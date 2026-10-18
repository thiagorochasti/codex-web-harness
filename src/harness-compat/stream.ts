/**
 * Responses SSE → Chat Completions SSE.
 *
 * Reconciles deltas with the final snapshot so text and tool arguments are delivered exactly
 * once, and turns a silent disconnect into an explicit error instead of a successful empty reply.
 */
import { randomUUID } from "node:crypto";
import { asRecord } from "../lib/records";
import type { NativeTerminalMapping } from "./native-terminal";
import {
  collectOutput,
  finishReasonFor,
  usageToChat,
  type ChatUsage,
  type ResponsesEnvelope,
} from "./convert";

interface ToolState {
  index: number;
  id: string;
  name: string;
  args: string;
  announced: boolean;
}

interface StreamState {
  text: string;
  tools: Map<string, ToolState>;
  nextToolIndex: number;
  hasToolCalls: boolean;
  terminal: boolean;
}

interface StreamOptions {
  model: string;
  legacy: boolean;
  includeUsage: boolean;
  terminalMapping?: NativeTerminalMapping;
}

function frame(id: string, model: string, delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function usageFrame(id: string, model: string, usage: ChatUsage): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage,
  })}\n\n`;
}

function errorFrame(message: string, type = "upstream_error", code: string | null = null): string {
  return `data: ${JSON.stringify({ error: { message, type, param: null, code } })}\n\n`;
}

function toolKey(event: Record<string, unknown>): string[] {
  const keys: string[] = [];
  if (typeof event.item_id === "string" && event.item_id) keys.push(event.item_id);
  const item = asRecord(event.item);
  if (typeof item?.id === "string" && item.id) keys.push(item.id);
  if (typeof item?.call_id === "string" && item.call_id) keys.push(item.call_id);
  if (typeof event.output_index === "number") keys.push(`idx:${event.output_index}`);
  return keys;
}

function findTool(state: StreamState, event: Record<string, unknown>): { entry: ToolState | undefined; keys: string[] } {
  const keys = toolKey(event);
  for (const key of keys) {
    const found = state.tools.get(key);
    if (found) return { entry: found, keys };
  }
  return { entry: undefined, keys };
}

function registerTool(state: StreamState, event: Record<string, unknown>): ToolState {
  const { entry, keys } = findTool(state, event);
  if (entry) return entry;
  const item = asRecord(event.item);
  const created: ToolState = {
    index: state.nextToolIndex,
    id: String(item?.call_id ?? item?.id ?? `call_${randomUUID().replaceAll("-", "")}`),
    name: String(item?.name ?? ""),
    args: "",
    announced: false,
  };
  state.nextToolIndex += 1;
  for (const key of keys) state.tools.set(key, created);
  return created;
}

function emitTextTail(write: (chunk: string) => void, state: StreamState, id: string, model: string, full: string): void {
  if (full.length <= state.text.length || !full.startsWith(state.text)) return;
  const tail = full.slice(state.text.length);
  state.text = full;
  write(frame(id, model, { content: tail }));
}

function emitToolTail(
  write: (chunk: string) => void,
  state: StreamState,
  id: string,
  model: string,
  entry: ToolState,
  full: string,
  legacy: boolean,
): void {
  if (full.length <= entry.args.length || !full.startsWith(entry.args)) return;
  const tail = full.slice(entry.args.length);
  entry.args = full;
  write(frame(id, model, legacy ? { function_call: { arguments: tail } } : {
    tool_calls: [{ index: entry.index, function: { arguments: tail } }],
  }));
}

function announceTool(
  write: (chunk: string) => void,
  state: StreamState,
  id: string,
  model: string,
  entry: ToolState,
  legacy: boolean,
): void {
  if (entry.announced) return;
  entry.announced = true;
  state.hasToolCalls = true;
  write(frame(id, model, legacy ? { function_call: { name: entry.name, arguments: "" } } : {
    tool_calls: [{
      index: entry.index,
      id: entry.id,
      type: "function",
      function: { name: entry.name, arguments: "" },
    }],
  }));
}

export function responsesStreamToChat(
  source: ReadableStream<Uint8Array>,
  options: StreamOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const state: StreamState = {
    text: "",
    tools: new Map(),
    nextToolIndex: 0,
    hasToolCalls: false,
    terminal: false,
  };
  let completionId = `chatcmpl-${randomUUID().replaceAll("-", "")}`;
  let roleSent = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => controller.enqueue(encoder.encode(chunk));
      const finish = (response: ResponsesEnvelope) => {
        state.terminal = true;
        const reason = finishReasonFor(response, state.hasToolCalls, options.legacy);
        write(frame(completionId, options.model, {}, reason));
        const usage = usageToChat(response.usage);
        if (options.includeUsage && usage) {
          write(usageFrame(completionId, options.model, usage));
        }
        write("data: [DONE]\n\n");
        controller.close();
      };
      const reconcile = (response: ResponsesEnvelope) => {
        const { text, calls } = collectOutput(response);
        emitTextTail(write, state, completionId, options.model, text);
        for (const call of calls) {
          const entry = registerTool(state, { item: { id: `final:${call.id}`, call_id: call.id, name: call.name } });
          announceTool(write, state, completionId, options.model, entry, options.legacy);
          emitToolTail(write, state, completionId, options.model, entry, call.arguments, options.legacy);
        }
      };

      const reader = source.getReader();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary: number;
          while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
            const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + separator.length);
            const data = block
              .split(/\r?\n/)
              .filter(line => line.startsWith("data:"))
              .map(line => line.slice(5).trimStart())
              .join("\n");
            if (!data || data === "[DONE]") continue;
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(data) as Record<string, unknown>;
            } catch {
              state.terminal = true;
              write(errorFrame("Upstream stream contained a malformed SSE frame"));
              write("data: [DONE]\n\n");
              controller.close();
              return;
            }
            if (options.terminalMapping) {
              const mapped = options.terminalMapping.event(event);
              if (!mapped) continue;
              event = mapped;
            }
            const type = String(event.type ?? "");
            const response = asRecord(event.response) as ResponsesEnvelope | undefined;
            if (type === "response.created" && typeof response?.id === "string") completionId = response.id;
            if (!roleSent) {
              roleSent = true;
              write(frame(completionId, options.model, { role: "assistant" }));
            }

            if (type === "response.output_text.delta" || type === "response.refusal.delta") {
              if (typeof event.delta === "string" && event.delta) {
                state.text += event.delta;
                write(frame(completionId, options.model, { content: event.delta }));
              }
            } else if (type === "response.output_text.done") {
              if (typeof event.text === "string") emitTextTail(write, state, completionId, options.model, event.text);
            } else if (type === "response.output_item.added") {
              const item = asRecord(event.item);
              if (item?.type === "function_call") {
                const entry = registerTool(state, event);
                announceTool(write, state, completionId, options.model, entry, options.legacy);
                if (typeof item.arguments === "string") {
                  emitToolTail(write, state, completionId, options.model, entry, item.arguments, options.legacy);
                }
              }
            } else if (type === "response.function_call_arguments.delta") {
              if (typeof event.delta === "string" && event.delta) {
                const entry = registerTool(state, event);
                announceTool(write, state, completionId, options.model, entry, options.legacy);
                emitToolTail(write, state, completionId, options.model, entry, entry.args + event.delta, options.legacy);
              }
            } else if (type === "response.function_call_arguments.done") {
              const entry = registerTool(state, event);
              announceTool(write, state, completionId, options.model, entry, options.legacy);
              if (typeof event.arguments === "string") {
                emitToolTail(write, state, completionId, options.model, entry, event.arguments, options.legacy);
              }
            } else if (type === "response.output_item.done") {
              const item = asRecord(event.item);
              if (item?.type === "function_call") {
                const entry = registerTool(state, event);
                announceTool(write, state, completionId, options.model, entry, options.legacy);
                if (typeof item.arguments === "string") {
                  emitToolTail(write, state, completionId, options.model, entry, item.arguments, options.legacy);
                }
              }
            } else if (type === "response.completed" || type === "response.incomplete") {
              if (response?.id) completionId = response.id;
              reconcile(response ?? { status: "completed" });
              finish(response ?? { status: "completed" });
              return;
            } else if (type === "response.failed") {
              state.terminal = true;
              const error = asRecord(response?.error) ?? asRecord(event.error) ?? {};
              write(errorFrame(String(error.message ?? "Upstream response failed"), String(error.type ?? "server_error"), typeof error.code === "string" ? error.code : null));
              write("data: [DONE]\n\n");
              controller.close();
              return;
            } else if (type === "error") {
              state.terminal = true;
              const error = asRecord(event.error) ?? event;
              write(errorFrame(String(error.message ?? "Upstream error"), String(error.type ?? "upstream_error"), typeof error.code === "string" ? error.code : null));
              write("data: [DONE]\n\n");
              controller.close();
              return;
            }
          }
        }
        if (!state.terminal) {
          write(errorFrame("Upstream stream ended before a terminal event"));
          write("data: [DONE]\n\n");
          controller.close();
        }
      } catch (error) {
        if (!state.terminal) {
          write(errorFrame(error instanceof Error ? error.message : String(error)));
          write("data: [DONE]\n\n");
        }
        controller.close();
      } finally {
        reader.releaseLock();
      }
    },
  });
}
