import { expect, test } from "bun:test";
import { NativeTerminalMapping } from "../src/harness-compat/native-terminal";
import { responsesStreamToChat } from "../src/harness-compat/stream";

function request() {
  return {
    tools: [{ type: "function", name: "terminal", parameters: { type: "object", properties: {
      command: { type: "string" }, workdir: { type: "string" }, timeout: { type: "integer", minimum: 1 },
    }, required: ["command"], additionalProperties: false } }],
    tool_choice: { type: "function", name: "terminal" },
    input: [{ type: "function_call", name: "terminal", call_id: "c1", arguments: '{"command":"echo ok","timeout":5}' }],
  };
}

const call = { type: "function_call", id: "fc1", call_id: "c1", name: "shell_command", arguments: '{"command":"echo ok","workdir":"D:/project","timeout_ms":5000}' };

test("terminal native roundtrip preserves command, working directory, timeout and call identity", () => {
  const payload = request();
  const mapping = NativeTerminalMapping.apply(payload)!;
  expect(payload.tools[0].name).toBe("shell_command");
  expect(payload.tool_choice.name).toBe("shell_command");
  expect(JSON.parse(payload.input[0].arguments)).toEqual({ command: "echo ok", timeout_ms: 5000 });
  expect(mapping.response({ output: [call] }).output).toEqual([{ ...call, name: "terminal", arguments: '{"command":"echo ok","workdir":"D:/project","timeout":5}' }]);
});

test("explicit native command is never overwritten by terminal mapping", () => {
  const payload = request();
  payload.tools.push({ ...payload.tools[0], name: "shell_command" });
  expect(NativeTerminalMapping.apply(payload)).toBeUndefined();
  expect(payload.tools.map(tool => tool.name)).toEqual(["terminal", "shell_command"]);
});

test("native approval requests are not silently discarded", () => {
  const mapping = NativeTerminalMapping.apply(request())!;
  expect(() => mapping.response({ output: [{ ...call, arguments: '{"command":"echo ok","sandbox_permissions":"require_escalated"}' }] }))
    .toThrow("does not support native argument sandbox_permissions");
});

for (const legacy of [false, true]) {
  test(`streamed native arguments are translated exactly once (${legacy ? "legacy" : "modern"})`, async () => {
    const mapping = NativeTerminalMapping.apply(request())!;
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", item_id: "fc1", delta: call.arguments.slice(0, 20) },
      { type: "response.function_call_arguments.delta", item_id: "fc1", delta: call.arguments.slice(20) },
      { type: "response.function_call_arguments.done", item_id: "fc1", arguments: call.arguments },
      { type: "response.output_item.done", output_index: 0, item: call },
      { type: "response.completed", response: { status: "completed", output: [call] } },
    ];
    const source = new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")).body!;
    const text = await new Response(responsesStreamToChat(source, { model: "web", legacy, includeUsage: false, terminalMapping: mapping })).text();
    const frames = text.split("\n\n").filter(line => line.startsWith("data: {")).map(line => JSON.parse(line.slice(6)));
    const deltas = frames.map(frame => legacy ? frame.choices?.[0]?.delta?.function_call : frame.choices?.[0]?.delta?.tool_calls?.[0]?.function).filter(Boolean);
    expect(deltas.filter(delta => delta.name).map(delta => delta.name)).toEqual(["terminal"]);
    expect(JSON.parse(deltas.map(delta => delta.arguments ?? "").join(""))).toEqual({ command: "echo ok", workdir: "D:/project", timeout: 5 });
    expect(frames.at(-1).choices[0].finish_reason).toBe(legacy ? "function_call" : "tool_calls");
  });
}
