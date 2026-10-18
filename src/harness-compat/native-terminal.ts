import { asRecord } from "../lib/records";
import type { ResponsesEnvelope } from "./convert";

/** Adapt the caller's terminal to the command contract used by Codex Native's dispatcher. */
export class NativeTerminalMapping {
  private readonly properties: Record<string, unknown>;
  private readonly pendingNames = new Map<string, string>();

  private constructor(properties: Record<string, unknown>) {
    this.properties = properties;
  }

  static apply(payload: Record<string, unknown>): NativeTerminalMapping | undefined {
    if (!Array.isArray(payload.tools)) return undefined;
    const tools = payload.tools.map(asRecord);
    // An explicitly declared native command owns the dispatcher; never replace it.
    if (tools.some(tool => tool?.name === "shell_command" || tool?.name === "exec_command")) return undefined;
    const terminal = tools.find(tool => tool?.type === "function" && tool.name === "terminal");
    const parameters = asRecord(terminal?.parameters);
    const properties = asRecord(parameters?.properties);
    if (!terminal || !parameters || !properties || asRecord(properties.command)?.type !== "string") return undefined;
    if (Object.hasOwn(properties, "timeout_ms")) throw new Error("terminal.timeout_ms conflicts with the native command contract");
    const mapping = new NativeTerminalMapping(properties);
    const nativeProperties = { ...properties };
    if (Object.hasOwn(properties, "timeout")) {
      const timeout = asRecord(properties.timeout);
      if (timeout?.type !== "integer" && timeout?.type !== "number") throw new Error("terminal.timeout must be seconds expressed as a number");
      const converted: Record<string, unknown> = { ...timeout };
      nativeProperties.timeout_ms = converted;
      for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "default"] as const) {
        if (typeof converted[key] === "number") converted[key] *= 1000;
      }
      if (Array.isArray(converted.enum)) converted.enum = converted.enum.map(value => typeof value === "number" ? value * 1000 : value);
      if (typeof converted.const === "number") converted.const *= 1000;
      converted.description = "Command timeout in milliseconds; the calling harness enforces it.";
      delete nativeProperties.timeout;
    }
    terminal.name = "shell_command";
    terminal.parameters = {
      ...parameters,
      properties: nativeProperties,
      ...(Array.isArray(parameters.required) ? { required: parameters.required.map(key => key === "timeout" ? "timeout_ms" : key) } : {}),
    };
    const choice = asRecord(payload.tool_choice);
    if (choice?.name === "terminal") choice.name = "shell_command";
    if (Array.isArray(payload.input)) {
      for (const raw of payload.input) {
        const item = asRecord(raw);
        if (item?.type === "function_call" && item.name === "terminal") {
          item.name = "shell_command";
          item.arguments = mapping.arguments(String(item.arguments ?? "{}"), true);
        }
      }
    }
    return mapping;
  }

  private arguments(text: string, toNative: boolean): string {
    const args = asRecord(JSON.parse(text));
    if (!args) throw new Error("Terminal arguments must be a JSON object");
    const result = { ...args };
    if (toNative) {
      if (Object.hasOwn(result, "timeout")) {
        if (typeof result.timeout !== "number" || !Number.isFinite(result.timeout)) throw new Error("terminal.timeout must be a finite number");
        result.timeout_ms = result.timeout * 1000;
        delete result.timeout;
      }
    } else {
      if (Object.hasOwn(result, "timeout_ms")) {
        if (!Object.hasOwn(this.properties, "timeout")) throw new Error("The caller's terminal does not support the requested native timeout");
        if (typeof result.timeout_ms !== "number" || !Number.isFinite(result.timeout_ms)) throw new Error("Native timeout_ms must be a finite number");
        const seconds = result.timeout_ms / 1000;
        result.timeout = asRecord(this.properties.timeout)?.type === "integer" ? Math.ceil(seconds) : seconds;
        delete result.timeout_ms;
      }
      for (const key of Object.keys(result)) {
        if (!Object.hasOwn(this.properties, key)) throw new Error(`The caller's terminal does not support native argument ${key}`);
      }
    }
    return JSON.stringify(result);
  }

  private item(raw: unknown, complete = true): unknown {
    const item = asRecord(raw);
    if (item?.type !== "function_call" || item.name !== "shell_command") return raw;
    return { ...item, name: "terminal", arguments: complete ? this.arguments(String(item.arguments ?? "{}"), false) : "" };
  }

  response(response: ResponsesEnvelope): ResponsesEnvelope {
    return { ...response, ...(Array.isArray(response.output) ? { output: response.output.map(item => this.item(item)) } : {}) };
  }

  /** Buffer only adapted arguments: converting milliseconds needs a complete JSON value. */
  event(event: Record<string, unknown>): Record<string, unknown> | undefined {
    const item = asRecord(event.item);
    if (item?.type === "function_call") {
      for (const key of [item.id, item.call_id, event.output_index]) {
        if (key !== undefined) this.pendingNames.set(String(key), String(item.name));
      }
      if (item.name === "shell_command") return { ...event, item: this.item(item, event.type !== "response.output_item.added") };
    }
    const name = this.pendingNames.get(String(event.item_id)) ?? this.pendingNames.get(String(event.output_index));
    if (name === "shell_command") {
      if (event.type === "response.function_call_arguments.delta") return undefined;
      if (event.type === "response.function_call_arguments.done") return { ...event, arguments: this.arguments(String(event.arguments ?? "{}"), false) };
    }
    const response = asRecord(event.response);
    return response ? { ...event, response: this.response(response as ResponsesEnvelope) } : event;
  }
}
