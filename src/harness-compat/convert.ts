/**
 * Chat Completions → Responses compatibility layer.
 *
 * The daemon speaks the Responses protocol because Codex does. Every other harness speaks
 * Chat Completions, so this module translates one into the other and back. It never invents
 * state: the caller owns the conversation history and resends it on every request.
 */
import { createHash, randomUUID } from "node:crypto";
import { asRecord } from "../lib/records";

export interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: unknown };
}

export interface ChatMessage {
  role?: string;
  content?: unknown;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
  function_call?: { name?: string; arguments?: unknown };
}

export interface ChatCompletionBody {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
  n?: number;
  instructions?: string;
  tools?: unknown[];
  functions?: unknown[];
  tool_choice?: unknown;
  function_call?: unknown;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  parallel_tool_calls?: boolean;
  reasoning_effort?: string;
  reasoning?: { effort?: string };
  response_format?: { type?: string; json_schema?: { name?: string; schema?: unknown; strict?: boolean } };
  stream_options?: { include_usage?: boolean };
  conversation_id?: string;
  thread_id?: string;
  codex_cwd?: string;
  user?: string;
}

/** Efforts the upstream accepts per model ("for this account"). Others are dropped. */
const SUPPORTED_EFFORTS: Record<string, readonly string[]> = {
  "chatgpt-web/gpt-6-sol": ["medium", "high"],
  "chatgpt-web/gpt-5.6-sol": ["medium", "high"],
  "chatgpt-web/gpt-6-sol-instant": ["none", "low"],
  "chatgpt-web/gpt-5.6-sol-instant": ["none", "low"],
};

export function normalizeEffort(model: string, requested: unknown): string | undefined {
  if (typeof requested !== "string" || !requested) return undefined;
  return SUPPORTED_EFFORTS[model]?.includes(requested) ? requested : undefined;
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map(part => {
      if (typeof part === "string") return part;
      const block = asRecord(part);
      if (!block) return "";
      return block.type === "text" || block.type === "input_text" || block.type === "output_text"
        ? String(block.text ?? "")
        : "";
    })
    .join("");
}

function contentParts(content: unknown, role: string): unknown[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return content ? [{ type: "input_text", text: content }] : [];
  if (!Array.isArray(content)) throw new Error(`Unsupported ${role} content shape`);
  const parts: unknown[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      parts.push({ type: "input_text", text: raw });
      continue;
    }
    const block = asRecord(raw);
    if (!block) continue;
    if (block.type === "text" || block.type === "input_text") {
      parts.push({ type: "input_text", text: String(block.text ?? "") });
    } else if (block.type === "image_url") {
      const image = typeof block.image_url === "string" ? block.image_url : asRecord(block.image_url)?.url;
      if (typeof image !== "string" || !image) throw new Error("image_url content part requires image_url.url");
      const detail = asRecord(block.image_url)?.detail;
      parts.push({ type: "input_image", image_url: image, ...(typeof detail === "string" ? { detail } : {}) });
    } else {
      throw new Error(`Unsupported ${role} content part type: ${String(block.type ?? "unknown")}`);
    }
  }
  return parts;
}

/** Replayed history must keep identical item ids: the upstream hashes (itemId, content) to
 *  decide whether a request continues the previous instruction or supersedes it. */
export function stableId(prefix: string, ...parts: string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24)}`;
}

function tools(body: ChatCompletionBody): unknown[] {
  const source = Array.isArray(body.tools)
    ? body.tools
    : Array.isArray(body.functions)
      ? body.functions.map(fn => ({ type: "function", function: fn }))
      : [];
  return source.map(raw => {
    const tool = asRecord(raw);
    const fn = asRecord(tool?.function);
    if (tool?.type !== "function" || !fn || typeof fn.name !== "string" || !fn.name) {
      throw new Error("Only OpenAI function tools are supported");
    }
    return {
      type: "function",
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      ...(asRecord(fn.parameters) ? { parameters: fn.parameters } : {}),
      ...(typeof fn.strict === "boolean" ? { strict: fn.strict } : {}),
    };
  });
}

function toolChoice(body: ChatCompletionBody): unknown {
  const choice = body.tool_choice ?? (body.function_call === "none" ? "none" : undefined);
  if (choice === undefined || choice === null) return undefined;
  if (typeof choice === "string") return choice;
  const value = asRecord(choice);
  const fn = asRecord(value?.function);
  if (value?.type === "function" && typeof fn?.name === "string") return { type: "function", name: fn.name };
  throw new Error("Unsupported tool_choice shape");
}

export interface BuildContext {
  cwd: string;
  threadId: string;
  turnId: string;
}

export interface BuiltRequest {
  payload: Record<string, unknown>;
  model: string;
  legacy: boolean;
}

function environmentItem(cwd: string, turnId: string, threadId: string): Record<string, unknown> {
  const escaped = cwd
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const text = [
    "<environment_context>",
    `  <cwd>${escaped}</cwd>`,
    `  <filesystem><workspace_roots><root>${escaped}</root></workspace_roots><permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile></filesystem>`,
    "</environment_context>",
  ].join("\n");
  return {
    type: "message",
    id: stableId("env", threadId, turnId, escaped),
    role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

function userItem(content: unknown, threadId: string, turnId: string, index: number, metadata: boolean): Record<string, unknown> {
  return {
    type: "message",
    id: stableId("msg", threadId, String(index), "user", textOf(content)),
    role: "user",
    content: contentParts(content, "user"),
    ...(metadata ? { internal_chat_message_metadata_passthrough: { turn_id: turnId } } : {}),
  };
}

/**
 * Converts chat history into Responses input items.
 *
 * Structured `function_call`/`function_call_output` items are preserved with the current turn
 * metadata, which is what lets the browser turn accept the tool result instead of waiting for the
 * live connector. The environment context sits immediately before the user message that anchors
 * the turn, because the adapter walks back exactly one item from it.
 */
export function convertMessages(
  messages: ChatMessage[],
  cwd: string,
  threadId: string,
  turnId: string,
): { instructions: string; input: unknown[] } {
  const instructions: string[] = [];
  const input: unknown[] = [];
  const callNames = new Map<string, string>();
  let anchor = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") { anchor = index; break; }
  }
  if (anchor < 0) throw new Error("messages must include at least one user message");

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || typeof message !== "object") continue;
    const role = message.role;

    if (index === anchor) {
      input.push(environmentItem(cwd, turnId, threadId));
      input.push(userItem(message.content, threadId, turnId, index, true));
      continue;
    }

    if (role === "system" || role === "developer") {
      const text = textOf(message.content);
      if (text) instructions.push(text);
      continue;
    }

    if (role === "user") {
      input.push(userItem(message.content, threadId, turnId, index, false));
      continue;
    }

    if (role === "assistant") {
      const parts = contentParts(message.content, "assistant");
      if (parts.length) {
        input.push({
          type: "message",
          id: stableId("msg", threadId, String(index), "assistant", textOf(message.content)),
          role: "assistant",
          content: parts,
        });
      }
      for (const call of message.tool_calls ?? []) {
        const fn = call?.function;
        if (!fn || typeof fn.name !== "string") continue;
        const callId = String(call.id ?? `call_${randomUUID().replaceAll("-", "")}`);
        callNames.set(callId, fn.name);
        input.push({
          type: "function_call",
          id: stableId("fc", threadId, String(index), callId),
          call_id: callId,
          name: fn.name,
          arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        });
      }
      if (message.function_call?.name) {
        const callId = `legacy_${message.function_call.name}`;
        callNames.set(callId, message.function_call.name);
        input.push({
          type: "function_call",
          id: stableId("fc", threadId, String(index), callId),
          call_id: callId,
          name: message.function_call.name,
          arguments: typeof message.function_call.arguments === "string"
            ? message.function_call.arguments
            : JSON.stringify(message.function_call.arguments ?? {}),
          internal_chat_message_metadata_passthrough: { turn_id: turnId },
        });
      }
      continue;
    }

    if (role === "tool" || role === "function") {
      const callId = String(message.tool_call_id ?? `legacy_${message.name ?? "function"}`);
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: textOf(message.content),
        internal_chat_message_metadata_passthrough: { turn_id: turnId },
      });
      continue;
    }

    throw new Error(`Unsupported chat message role: ${String(role ?? "unknown")}`);
  }

  return { instructions: instructions.join("\n\n"), input };
}

export function resolveThreadId(headers: Headers, body: ChatCompletionBody): string {
  const header = headers.get("x-codex-thread-id");
  if (header?.trim()) return header.trim();
  if (typeof body.conversation_id === "string" && body.conversation_id.trim()) return body.conversation_id.trim();
  if (typeof body.thread_id === "string" && body.thread_id.trim()) return body.thread_id.trim();
  const hasToolCycle = (Array.isArray(body.tools) && body.tools.length > 0)
    || (Array.isArray(body.functions) && body.functions.length > 0)
    || body.messages?.some(message => message?.role === "tool" || message?.role === "function"
      || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)
      || message?.function_call !== undefined);
  if (hasToolCycle) {
    throw new Error("Tool cycles require a stable x-codex-thread-id, conversation_id, or thread_id from the first request");
  }
  // Without caller-owned identity, text-only requests are isolated rather than joined by content.
  return `thread_${randomUUID().replaceAll("-", "")}`;
}

export function resolveCwd(headers: Headers, body: ChatCompletionBody): string {
  const requested = headers.get("x-codex-cwd") ?? body.codex_cwd ?? process.cwd();
  if (typeof requested !== "string" || !requested.trim()) throw new Error("No working directory was supplied");
  if (!/^([A-Za-z]:[\\/]|\/)/.test(requested.trim())) {
    throw new Error("Working directory must be absolute; set x-codex-cwd, codex_cwd, or start the daemon in the project");
  }
  return requested.trim();
}

export function buildResponsesRequest(body: ChatCompletionBody, headers: Headers): BuiltRequest {
  if (!Array.isArray(body.messages) || body.messages.length === 0) throw new Error("messages must be a non-empty array");
  if (body.n !== undefined && body.n !== 1) throw new Error("This bridge supports n=1 only");
  const model = typeof body.model === "string" && body.model ? body.model : "chatgpt-web/gpt-6-sol";
  const cwd = resolveCwd(headers, body);
  const threadId = resolveThreadId(headers, body);
  const anchorIndex = body.messages.reduce((last, message, index) => (message?.role === "user" ? index : last), -1);
  const anchorText = textOf(body.messages[anchorIndex]?.content);
  const turnId = `turn_${createHash("sha256")
    .update(`${threadId}\u0000${anchorIndex}\u0000${anchorText}`)
    .digest("hex")
    .slice(0, 32)}`;
  const converted = convertMessages(body.messages, cwd, threadId, turnId);
  const legacy = !Array.isArray(body.tools) && Array.isArray(body.functions) && body.functions.length > 0;

  const payload: Record<string, unknown> = {
    model,
    input: converted.input,
    stream: body.stream === true,
    store: false,
    prompt_cache_key: threadId,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        thread_id: threadId,
        turn_id: turnId,
        request_kind: "turn",
        sandbox: "none",
        workspaces: { [cwd]: {} },
      }),
    },
  };
  const instructions = [body.instructions, converted.instructions]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n\n");
  if (instructions) payload.instructions = instructions;

  const effort = normalizeEffort(
    model,
    body.reasoning_effort ?? body.reasoning?.effort ?? (model === "chatgpt-web/gpt-6-sol" ? "medium" : undefined),
  );
  if (effort) payload.reasoning = { effort };
  if (Number.isInteger(body.max_completion_tokens)) payload.max_output_tokens = body.max_completion_tokens;
  else if (Number.isInteger(body.max_tokens)) payload.max_output_tokens = body.max_tokens;
  if (typeof body.temperature === "number") payload.temperature = body.temperature;
  if (typeof body.top_p === "number") payload.top_p = body.top_p;
  if (typeof body.parallel_tool_calls === "boolean") payload.parallel_tool_calls = body.parallel_tool_calls;

  const convertedTools = tools(body);
  if (convertedTools.length > 0) payload.tools = convertedTools;
  const choice = toolChoice(body);
  if (choice !== undefined) payload.tool_choice = choice;

  if (body.response_format?.type === "json_object") {
    payload.text = { format: { type: "json_object" } };
  } else if (body.response_format?.type === "json_schema" && body.response_format.json_schema) {
    const schema = body.response_format.json_schema;
    payload.text = {
      format: {
        type: "json_schema",
        name: schema.name ?? "response",
        schema: schema.schema ?? {},
        ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
      },
    };
  }

  return { payload, model, legacy };
}

export interface ResponsesEnvelope {
  id?: string;
  model?: string;
  created_at?: number;
  status?: string;
  incomplete_details?: { reason?: string };
  output?: unknown[];
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionMessage {
  role: "assistant";
  content: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  function_call?: { name: string; arguments: string };
}

export interface ChatCompletionResult {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: { index: number; message: ChatCompletionMessage; finish_reason: string }[];
  usage?: ChatUsage;
}

export function usageToChat(usage: ResponsesEnvelope["usage"]): ChatUsage | undefined {
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
    total_tokens: usage.total_tokens ?? 0,
  };
}

export function finishReasonFor(response: ResponsesEnvelope, hasCalls: boolean, legacy: boolean): string {
  if (response.status === "incomplete") {
    return response.incomplete_details?.reason === "content_filter" ? "content_filter" : "length";
  }
  if (hasCalls) return legacy ? "function_call" : "tool_calls";
  return "stop";
}

export function collectOutput(response: ResponsesEnvelope) {
  const texts: string[] = [];
  const calls: { id: string; name: string; arguments: string }[] = [];
  for (const raw of response.output ?? []) {
    const item = asRecord(raw);
    if (!item) continue;
    if (item.type === "message") {
      for (const part of Array.isArray(item.content) ? item.content : []) {
        const block = asRecord(part);
        if (block?.type === "output_text" && typeof block.text === "string") texts.push(block.text);
        if (block?.type === "refusal" && typeof block.refusal === "string") texts.push(block.refusal);
      }
    } else if (item.type === "function_call") {
      calls.push({
        id: String(item.call_id ?? item.id ?? `call_${randomUUID().replaceAll("-", "")}`),
        name: String(item.name ?? ""),
        arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {}),
      });
    }
  }
  return { text: texts.join(""), calls };
}

export function toChatCompletion(response: ResponsesEnvelope, model: string, legacy: boolean): ChatCompletionResult {
  if (response.status === "failed" || response.error) {
    throw new Error(response.error?.message ?? "Upstream model failed");
  }
  const { text, calls } = collectOutput(response);
  const message: ChatCompletionMessage = { role: "assistant", content: text || null };
  if (calls.length > 0 && legacy) {
    message.function_call = { name: calls[0].name, arguments: calls[0].arguments };
  } else if (calls.length > 0) {
    message.tool_calls = calls.map(call => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return {
    id: response.id ?? `chatcmpl-${randomUUID().replaceAll("-", "")}`,
    object: "chat.completion",
    created: response.created_at ?? Math.floor(Date.now() / 1000),
    model: response.model ?? model,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReasonFor(response, calls.length > 0, legacy),
    }],
    ...(response.usage ? { usage: usageToChat(response.usage) } : {}),
  };
}
