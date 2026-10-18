import { describe, expect, test } from "bun:test";
import {
  buildResponsesRequest,
  normalizeEffort,
  toChatCompletion,
  type ChatCompletionBody,
  type ChatCompletionResult,
  type ResponsesEnvelope,
} from "../src/harness-compat/convert";
import { chatCompletionsRequest } from "../src/harness-compat/handler";
import { asRecord, isRecord } from "../src/lib/records";
import { responsesStreamToChat } from "../src/harness-compat/stream";

const CWD = process.platform === "win32" ? "C:\\Projetos\\demo" : "/projetos/demo";

function headers(values: Record<string, string> = {}): Headers {
  return new Headers({ "x-codex-thread-id": "thread-test", "x-codex-cwd": CWD, ...values });
}

function build(body: ChatCompletionBody, extraHeaders: Record<string, string> = {}) {
  return buildResponsesRequest(body, headers(extraHeaders));
}

function user(content: string) {
  return { role: "user", content };
}

function itemsOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  const input = payload.input;
  if (!Array.isArray(input)) throw new Error("payload has no input array");
  return input.filter(isRecord);
}

function metadataOf(payload: Record<string, unknown>): { thread_id: string; turn_id: string } {
  const client = payload.client_metadata;
  if (!isRecord(client)) throw new Error("payload has no client_metadata");
  const raw = client["x-codex-turn-metadata"];
  if (typeof raw !== "string") throw new Error("payload has no turn metadata");
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || typeof parsed.thread_id !== "string" || typeof parsed.turn_id !== "string") {
    throw new Error("turn metadata is missing thread_id/turn_id");
  }
  return { thread_id: parsed.thread_id, turn_id: parsed.turn_id };
}

function firstTextOf(item: Record<string, unknown>): string {
  const content = item.content;
  if (!Array.isArray(content) || content.length === 0) return "";
  const block = content[0];
  return isRecord(block) && typeof block.text === "string" ? block.text : "";
}

function turnIdOf(item: Record<string, unknown>): string | undefined {
  const metadata = item.internal_chat_message_metadata_passthrough;
  return isRecord(metadata) && typeof metadata.turn_id === "string" ? metadata.turn_id : undefined;
}

async function sseOf(events: string[]): Promise<string> {
  const body = new Response(events.join("")).body;
  if (!body) throw new Error("fixture produced no body");
  const stream = responsesStreamToChat(body, {
    model: "chatgpt-web/gpt-6-sol",
    legacy: false,
    includeUsage: true,
  });
  return new Response(stream).text();
}

function frames(text: string): Record<string, unknown>[] {
  return text
    .split(/\r?\n/)
    .filter(line => line.startsWith("data: "))
    .map(line => line.slice(6))
    .filter(row => row !== "[DONE]")
    .map(row => JSON.parse(row) as Record<string, unknown>);
}

function firstChoice(row: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = row.choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const choice = choices[0];
  return isRecord(choice) ? choice : undefined;
}

function deltaOf(row: Record<string, unknown>): Record<string, unknown> {
  const delta = firstChoice(row)?.delta;
  return isRecord(delta) ? delta : {};
}

function contentOf(text: string): string {
  return frames(text).map(row => {
    const content = deltaOf(row).content;
    return typeof content === "string" ? content : "";
  }).join("");
}

function toolArgsOf(text: string): string {
  return frames(text).flatMap(row => {
    const calls = deltaOf(row).tool_calls;
    if (!Array.isArray(calls)) return [];
    return calls.flatMap(call => {
      if (!isRecord(call) || !isRecord(call.function)) return [];
      return typeof call.function.arguments === "string" ? [call.function.arguments] : [];
    });
  }).join("");
}

function finishOf(text: string): string | null {
  for (const row of frames(text)) {
    const reason = firstChoice(row)?.finish_reason;
    if (typeof reason === "string") return reason;
  }
  return null;
}

function errorMessageOf(text: string): string | undefined {
  for (const row of frames(text)) {
    const error = row.error;
    if (isRecord(error) && typeof error.message === "string") return error.message;
  }
  return undefined;
}

function event(type: string, payload: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`;
}

describe("conversão de request", () => {
  test("coloca o environment context imediatamente antes da mensagem âncora", () => {
    const { payload } = build({ model: "chatgpt-web/gpt-6-sol", messages: [user("Olá")] });
    const input = itemsOf(payload);
    expect(input).toHaveLength(2);
    expect(firstTextOf(input[0])).toStartWith("<environment_context>");
    expect(turnIdOf(input[0])).toBe(metadataOf(payload).turn_id);
    expect(input[1].role).toBe("user");
    expect(turnIdOf(input[1])).toBe(metadataOf(payload).turn_id);
  });

  test("mantém ids estáveis ao reenviar o mesmo histórico", () => {
    const body: ChatCompletionBody = {
      model: "chatgpt-web/gpt-6-sol",
      messages: [user("Primeira"), { role: "assistant", content: "Resposta" }, user("Segunda")],
    };
    const ids = (payload: Record<string, unknown>) => itemsOf(payload).map(item => String(item.id));
    expect(ids(build(body).payload)).toEqual(ids(build(body).payload));
  });

  test("preserva function_call e function_call_output com metadata do turno", () => {
    const callId = "call_abc";
    const { payload } = build({
      model: "chatgpt-web/gpt-6-sol",
      messages: [
        user("Calcule 17+25"),
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: callId, type: "function", function: { name: "soma", arguments: "{\"a\":17}" } }],
        },
        { role: "tool", tool_call_id: callId, content: "42" },
      ],
    });
    const input = itemsOf(payload);
    const call = input.find(item => item.type === "function_call");
    const output = input.find(item => item.type === "function_call_output");
    expect(call).toMatchObject({ call_id: callId, name: "soma", arguments: "{\"a\":17}" });
    expect(turnIdOf(call ?? {})).toBe(metadataOf(payload).turn_id);
    expect(output).toMatchObject({ call_id: callId, output: "42" });
    expect(turnIdOf(output ?? {})).toBe(metadataOf(payload).turn_id);
  });

  test("preserva identidade desde a primeira chamada até o retorno da ferramenta", () => {
    const messages: ChatCompletionBody["messages"] = [user("Execute o comando")];
    const first = metadataOf(build({ messages }).payload);
    messages.push(
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "terminal", arguments: "{\"command\":\"echo ok\"}" } }] },
      { role: "tool", tool_call_id: "call-1", content: "ok" },
    );
    expect(metadataOf(build({ messages }).payload)).toEqual(first);
    messages.push({ role: "assistant", content: "ok" }, user("Outro comando"));
    const next = metadataOf(build({ messages }).payload);
    expect(next.thread_id).toBe(first.thread_id);
    expect(next.turn_id).not.toBe(first.turn_id);
    expect(metadataOf(build({ messages }, { "x-codex-thread-id": "other-session" }).payload).thread_id).not.toBe(first.thread_id);
  });

  test("exige identidade do chamador antes de iniciar um ciclo de ferramentas", () => {
    expect(() => buildResponsesRequest({
      messages: [user("Execute")],
      tools: [{ type: "function", function: { name: "terminal", parameters: { type: "object" } } }],
    }, new Headers())).toThrow("stable x-codex-thread-id");
    const text = { messages: [user("Oi")] };
    expect(metadataOf(buildResponsesRequest(text, new Headers()).payload).thread_id)
      .not.toBe(metadataOf(buildResponsesRequest(text, new Headers()).payload).thread_id);
  });

  test("reaproveita a identidade quando há histórico do assistente", () => {
    const messages = [user("Olá"), { role: "assistant", content: "Oi" }, user("Tudo bem?")];
    const built = build({ model: "chatgpt-web/gpt-6-sol", messages });
    expect(metadataOf(built.payload).thread_id).toBe("thread-test");
    expect(built.payload.store).toBe(false);
    expect(built.payload.prompt_cache_key).toBe("thread-test");
  });

  test("normaliza esforços suportados e descarta os demais", () => {
    expect(normalizeEffort("chatgpt-web/gpt-6-sol", "high")).toBe("high");
    expect(normalizeEffort("chatgpt-web/gpt-6-sol", "none")).toBeUndefined();
    expect(normalizeEffort("chatgpt-web/gpt-6-sol", "xhigh")).toBeUndefined();
    expect(normalizeEffort("chatgpt-web/light", "high")).toBeUndefined();
    const { payload } = build({ model: "chatgpt-web/gpt-6-sol", messages: [user("oi")] });
    expect(payload.reasoning).toEqual({ effort: "medium" });
  });
});

describe("conversão de resposta", () => {
  const completed: ResponsesEnvelope = {
    id: "resp_1",
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  };

  test("texto e uso", () => {
    const chat = toChatCompletion(completed, "chatgpt-web/gpt-6-sol", false);
    expect(chat.choices[0].message.content).toBe("OK");
    expect(chat.choices[0].finish_reason).toBe("stop");
    expect(chat.usage).toEqual({ prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
  });

  test("tool_calls modernos e function_call legado", () => {
    const envelope: ResponsesEnvelope = {
      status: "completed",
      output: [{ type: "function_call", call_id: "call_9", name: "echo", arguments: "{\"value\":\"9\"}" }],
    };
    const modern = toChatCompletion(envelope, "chatgpt-web/gpt-6-sol", false);
    expect(modern.choices[0].finish_reason).toBe("tool_calls");
    expect(modern.choices[0].message.tool_calls).toEqual([
      { id: "call_9", type: "function", function: { name: "echo", arguments: "{\"value\":\"9\"}" } },
    ]);
    const legacy = toChatCompletion(envelope, "chatgpt-web/gpt-6-sol", true);
    expect(legacy.choices[0].finish_reason).toBe("function_call");
    expect(legacy.choices[0].message.function_call).toEqual({ name: "echo", arguments: "{\"value\":\"9\"}" });
  });

  test("estado incompleto tem precedência sobre tool_calls", () => {
    const envelope: ResponsesEnvelope = {
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output: [{ type: "function_call", call_id: "call_cut", name: "echo", arguments: "{\"value\":" }],
    };
    expect(toChatCompletion(envelope, "chatgpt-web/gpt-6-sol", false).choices[0].finish_reason).toBe("length");
    expect(toChatCompletion(
      { ...envelope, incomplete_details: { reason: "content_filter" } },
      "chatgpt-web/gpt-6-sol",
      false,
    ).choices[0].finish_reason).toBe("content_filter");
  });
});

describe("streaming", () => {
  test("entrega texto e não duplica o snapshot final", async () => {
    const text = await sseOf([
      event("response.created", { response: { id: "resp_sse" } }),
      event("response.output_text.delta", { delta: "A" }),
      event("response.output_text.delta", { delta: "B" }),
      event("response.completed", {
        response: { id: "resp_sse", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "AB" }] }] },
      }),
    ]);
    expect(contentOf(text)).toBe("AB");
    expect(finishOf(text)).toBe("stop");
  });

  test("argumentos enviados apenas em done chegam completos", async () => {
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "echo", arguments: "{\"value\":\"42\"}" };
    const text = await sseOf([
      event("response.created", { response: { id: "resp_sse" } }),
      event("response.output_item.added", { output_index: 0, item: { ...call, arguments: "" } }),
      event("response.function_call_arguments.done", { output_index: 0, item_id: "fc_1", arguments: call.arguments }),
      event("response.output_item.done", { output_index: 0, item: call }),
      event("response.completed", { response: { id: "resp_sse", status: "completed", output: [call] } }),
    ]);
    expect(toolArgsOf(text)).toBe("{\"value\":\"42\"}");
    expect(finishOf(text)).toBe("tool_calls");
  });

  test("texto presente apenas no snapshot final é entregue", async () => {
    const text = await sseOf([
      event("response.created", { response: { id: "resp_sse" } }),
      event("response.completed", {
        response: { id: "resp_sse", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "FINAL" }] }] },
      }),
    ]);
    expect(contentOf(text)).toBe("FINAL");
  });

  test("erro explícito e EOF sem terminal viram frames de erro", async () => {
    const failure = await sseOf([
      event("response.created", { response: { id: "resp_sse" } }),
      event("error", { error: { message: "limite atingido", type: "rate_limit_error", code: "rate_limit_exceeded" } }),
    ]);
    expect(errorMessageOf(failure)).toBe("limite atingido");

    const truncated = await sseOf([
      event("response.created", { response: { id: "resp_sse" } }),
      event("response.output_text.delta", { delta: "parcial" }),
    ]);
    expect(contentOf(truncated)).toBe("parcial");
    expect(errorMessageOf(truncated)).toBeDefined();
  });

  test("uso vai em chunk com choices vazio", async () => {
    const text = await sseOf([
      event("response.completed", {
        response: {
          id: "resp_sse",
          status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        },
      }),
    ]);
    const usageChunk = frames(text).find(row => row.usage !== undefined);
    expect(usageChunk?.choices).toEqual([]);
    expect(usageChunk?.usage).toEqual({ prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
  });
});

describe("handler", () => {
  test("traduz, invoca o handler de Responses e converte a resposta", async () => {
    let received: Record<string, unknown> | undefined;
    const response = await chatCompletionsRequest(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-codex-thread-id": "handler-thread", "x-codex-cwd": CWD },
        body: JSON.stringify({ model: "chatgpt-web/gpt-6-sol", messages: [user("oi")] }),
      }),
      {
        invokeResponses: async request => {
          const parsed: unknown = await request.json();
          received = isRecord(parsed) ? parsed : undefined;
          return Response.json({
            id: "resp_h",
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "OK" }] }],
          });
        },
      },
    );
    const chat = await response.json() as ChatCompletionResult;
    expect(response.status).toBe(200);
    expect(chat.choices[0].message.content).toBe("OK");
    expect(received?.model).toBe("chatgpt-web/gpt-6-sol");
    expect(Array.isArray(received?.input)).toBe(true);
  });

  test("rejeita corpo inválido com 400", async () => {
    const response = await chatCompletionsRequest(
      new Request("http://local/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "chatgpt-web/gpt-6-sol", messages: [] }),
      }),
      { invokeResponses: async () => Response.json({}) },
    );
    expect(response.status).toBe(400);
  });
});
