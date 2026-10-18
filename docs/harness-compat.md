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

3. Send the full conversation history on every request. The daemon stores nothing.

Example:

```bash
curl http://127.0.0.1:17841/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'x-codex-thread-id: demo-thread' \
  -d '{"model":"chatgpt-web/gpt-6-sol","messages":[{"role":"user","content":"Responda OK"}]}'
```

## Behaviour

### Session identity

`x-codex-thread-id` (or `conversation_id` / `thread_id` in the body) becomes the `thread_id` of the
turn envelope. It is reused **only when the history contains an `assistant` message**, because that
is what lets the daemon build the continuation prompt for a retained ChatGPT conversation. Without
it the request is isolated instead of failing with
`Launcher reused a ChatGPT conversation without a continuation prompt`.

Without any identifier, each request gets a fresh thread and is fully stateless — the history you
send still provides the context.

### Tools

`tools` (and the legacy `functions`) are forwarded with the same turn metadata. A tool result is
accepted as `{"role":"tool","tool_call_id":…,"content":…}` and replayed as `function_call_output`
with the current turn id, which keeps the tool round inside one browser turn.

`function_call` / `finish_reason: "function_call"` is emitted for the legacy shape;
`tool_calls` / `finish_reason: "tool_calls"` for the modern one.

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

Symptom: the model answers in prose claiming it tried "Codex Native" and failed, instead of calling
your declared function tool.

Cause: in `full` mode the browser tab carries the `Codex Native2` connector, and ChatGPT routes
shell-shaped requests to it. The connector's `codex_exec` resolves a **native** `exec_command` /
`shell_command` from the outer Codex turn (`src/adapters/chatgpt-web/mcp-server.ts`). A Chat
Completions client does not advertise that native registry, so the call cannot be served — with or
without the tunnel running.

Measured behaviour on 6.1.10 (same request, only names changed):

| Declared tool | Prompt wording | Result |
| --- | --- | --- |
| `run_echo` (neutral description) | "use run_echo" | declared function called |
| `run_command` (shell description) | "use run_command" | declared function called |
| `terminal` (neutral description) | "use terminal" | routed to Codex Native, fails |
| `exec` (neutral description) | "use exec" | routed to Codex Native, fails |

Renaming the declared tool alone does not help: when the prompt says "terminal", the model still
prefers the connector.

What to do:

1. Use declared function tools whose purpose is not shell execution (file, HTTP, database, custom
   APIs). Those work.
2. Do shell work through Codex itself, which owns the native registry.
3. For harness-only installations, run the app in `browser-only` mode so no connector is attached
   and the model only sees declared tools.

### `GPT-6 Sol (Web) does not support effort "none" for this account`

Already handled: unsupported efforts are dropped before the turn is sent, so the model default
applies. If you see this from a client, it is not talking to this fork's daemon (check the base
URL) or is running an older build.

## Limitations

- **Local tools need the tunnel.** In `full` mode ChatGPT is told about the Codex Native harness;
  shell-shaped work is routed there and fails with `INVALID_ARGUMENT` when the `Codex Native2`
  connector is not connected. Connect the tunnel in the launcher's MCP page to use it.
- **No conversation state.** `previous_response_id` is not supported; resend the history.
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

Run `bun run typecheck && bun test tests/harness-compat.test.ts` after each rebase, plus a real
end-to-end turn, because the upstream releases frequently change browser-turn semantics.
