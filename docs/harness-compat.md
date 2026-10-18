# Harness compatibility (Chat Completions)

This fork exposes the models the Codex picker already shows — `chatgpt-web/gpt-6-sol`,
`chatgpt-web/gpt-6-sol-instant`, `chatgpt-web/gpt-5.6-sol`, `chatgpt-web/gpt-5.6-sol-instant`,
`chatgpt-web/light`, `chatgpt-web/medium`, `chatgpt-web/high` — over the OpenAI
**Chat Completions** protocol, so any harness can use them without being Codex.

```
harness (Chat Completions) ──▶ codex-chatgpt-web daemon ──▶ ChatGPT Web
                                  (/v1/chat/completions)
```

The translation happens inside the daemon and calls the same in-process Responses handler Codex
uses. There is no second process, port, or credential.

## Why a fork

Upstream is intentionally Codex-only. Its `CONTRIBUTING.md` states that *"generic providers and
unrelated product surfaces are out of scope"*, so this surface cannot land there. It lives here as
a thin edge: the compatibility module plus one route.

## Quick start

1. Install and sign in with the launcher as usual (ChatGPT Web connection, model install).
2. Point your harness at the daemon:

| Setting | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:17841/v1` |
| Endpoint | `POST /v1/chat/completions` |
| Model | `chatgpt-web/gpt-6-sol` |
| API key | any non-empty value; the daemon authenticates through the browser session |
| Session header | `x-codex-thread-id: <stable conversation id>` |

3. Send the full conversation history on every request. The compatibility layer does not persist it; the upstream broker keeps pending tool calls until their results arrive.

Example:

```bash
curl http://127.0.0.1:17841/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-codex-thread-id: demo-thread' \
  -d '{"model":"chatgpt-web/gpt-6-sol","messages":[{"role":"user","content":"Responda OK"}]}'
```

### Running alongside the official installed launcher

To use the corrected source without replacing the official launcher, run
`bun run scripts/serve-harness.ts` from this checkout, then use
`http://127.0.0.1:17941/v1` as the harness base URL.

This entry point requires the installed launcher in `full` mode. It builds the checkout's browser
helper and uses the launcher's external-owner broker, so the existing MCP connector resolves the
same tool tokens. Browser diagnostics and turn state are isolated under `runtime/harness/`.
The extra HTTP listener has its own local broker socket and does not replace the installed daemon.
The launcher must remain available while processing requests.

On this Windows deployment, the scheduled task `Codex Web Harness Bridge` runs this entry point
at user logon with no execution time limit and ignores duplicate starts. The Hermes `codex-web`
provider uses port `17941`; the old shim on `17842` is stopped. Restart an already-open Hermes
process to reload its provider configuration, then start a fresh conversation.

## Behaviour

### Session identity

`x-codex-thread-id` (or `conversation_id` / `thread_id` in the body) becomes the `thread_id`
**from the first request**, including requests without an assistant message yet. Reuse that identity
through every tool call and result. Changing it mid-cycle disconnects the pending broker invocation.
The `turn_id` stays stable while returning results for the same user message, then changes for a new
user message.

Requests declaring tools or returning tool results require an explicit conversation identifier;
otherwise they fail with HTTP 400 before starting a browser turn. Text-only requests without an
identifier remain isolated. Use a new identifier when starting a new conversation; do not reuse an
old identifier with its history removed.

### Tools

`tools` (and the legacy `functions`) are forwarded with the same turn metadata. A tool result is
accepted as `{"role":"tool","tool_call_id":…,"content":…}` and replayed as `function_call_output`
with the current turn id, which keeps the tool round inside one browser turn.

`function_call` / `finish_reason: "function_call"` is emitted for the legacy shape;
`tool_calls` / `finish_reason: "tool_calls"` for the modern one.

Hermes' `terminal` function is advertised upstream as `shell_command`, which the connector's
`codex_exec` dispatcher recognizes. Calls return to the client as `terminal`; the caller executes
them under its own permissions and sends the result back. This is a protocol translation, not
prompt-based renaming, and works even when the user asks for “the terminal”.

- `command` and `workdir` are preserved.
- `timeout` in seconds is advertised as `timeout_ms`; returned milliseconds are converted back
  (rounded up for an integer-seconds schema).
- Tool history, explicit tool choice, legacy functions, JSON responses and SSE use the same mapping.
- SSE buffers adapted tool arguments until their complete JSON arrives; unrelated text still streams.
- An explicitly declared `shell_command` or `exec_command` takes precedence; it is never overwritten.
- Unsupported native arguments, including escalation requests the caller cannot represent, produce
  an explicit error rather than being silently discarded.

The mapping is specific to `terminal` with a string `command` property. Other harness tool contracts
are forwarded unchanged, not guessed from their descriptions.

### Reasoning effort

The upstream only accepts specific efforts per model and account. Requests asking for anything else
are forwarded **without** the `reasoning` field, so the model default applies:

| Model | Accepted |
| --- | --- |
| `chatgpt-web/gpt-6-sol`, `chatgpt-web/gpt-5.6-sol` | `medium`, `high` |
| `chatgpt-web/gpt-6-sol-instant`, `chatgpt-web/gpt-5.6-sol-instant` | `none`, `low` |
| `chatgpt-web/light`, `medium`, `high` | effort is encoded in the slug |

`chatgpt-web/gpt-6-sol` defaults to `medium` when the request says nothing.

### Streaming

`stream: true` returns `text/event-stream` with `chat.completion.chunk` frames:

- text deltas, with the final snapshot reconciled so nothing is duplicated;
- tool arguments delivered exactly once, even when the upstream only sends them in
  `response.function_call_arguments.done`;
- `finish_reason` derived from the terminal state (`length` for `max_output_tokens`,
  `content_filter` for filtered output, `tool_calls` when calls completed);
- an explicit error frame plus `[DONE]` when the upstream errors or ends without a terminal event;
- `stream_options.include_usage` adds the final chunk with `choices: []` and `usage`.

### Response

Non-streaming responses are ordinary `chat.completion` objects with `usage` mapped from the
upstream token counters.


## Known errors

### `INVALID_ARGUMENT: This Codex turn did not advertise a native command tool or the native exec gateway`

Older versions forwarded Hermes' `terminal` name unchanged. ChatGPT selected `codex_exec`, whose
dispatcher looks for `exec_command` or `shell_command`; consequently it could not dispatch the call.
The current compatibility layer translates this contract as described above.

Do not disable the connector or switch to `browser-only` as a workaround. In this architecture,
structured tool calls arrive through MCP and the broker, not by parsing JSON written in model prose.
The launcher, connector and `full` mode remain necessary.

End-to-end verification used the existing signed-in launcher and a development adapter connected
to its external-owner broker. Hermes received `terminal`, executed `echo ASTRA_HERMES_REAL_OK`,
stored `{"output":"ASTRA_HERMES_REAL_OK","exit_code":0,"error":null}`, returned the result and received
the final answer. No replacement of the installed launcher or removal of the account connector
was needed.
A second Hermes run read `NOTICE` through `read_file`, then executed `cmd /c exit 7` through
`terminal`. The tool record preserved `exit_code: 7` and the final answer reported the failure,
confirming that non-shell tools and error results still complete their round trips.

### `GPT-6 Sol (Web) does not support effort "none" for this account`

Already handled: unsupported efforts are dropped before the turn is sent, so the model default
applies. If you see this from a client, it is not talking to this fork's daemon (check the base
URL) or is running an older build.

## Limitations

- **Local tools need the connector and broker.** Keep `full` mode and the launcher's MCP connection
  available. The compatibility layer does not provide a second local executor.
- **The caller owns history.** `previous_response_id` is not supported; resend the history and keep
  the conversation identifier stable throughout tool execution.
- **Latency** is a browser turn: seconds, not milliseconds.
- **Account-dependent models and efforts.** The catalog and the accepted efforts follow the signed-in
  ChatGPT account.
- **Not an OpenAI API.** This is browser automation of the ChatGPT web UI, exactly like upstream.

## Maintenance

The compatibility layer is deliberately thin so it can be rebased:

- new files: `src/harness-compat/*`, `src/lib/records.ts`, `tests/harness-compat.test.ts`;
- one route branch in `src/server.ts` and one member in `HttpTrackedEndpoint`;
- no changes to `src/adapters/chatgpt-web/*` (the hottest area of the repository).

Rebase recipe:

```bash
git remote add upstream https://github.com/miuuyy/codex-chatgpt-web.git
git fetch --tags upstream
git rebase --onto v6.1.11 v6.1.10 feat/harness-compat
```

Run `bun run typecheck && bun test tests/harness-compat.test.ts tests/harness-native-tools.test.ts` after each rebase, plus a real
end-to-end turn, because the upstream releases frequently change browser-turn semantics.
