/**
 * POST /v1/chat/completions — the compatibility surface for harnesses that are not Codex.
 *
 * The request is translated, executed by the same in-process Responses handler Codex uses, and
 * translated back. No state is stored: the caller owns the conversation history.
 */
import { formatErrorResponse } from "../bridge";
import { readJsonRequestBody } from "../http-body";
import {
  buildResponsesRequest,
  toChatCompletion,
  type BuiltRequest,
  type ChatCompletionBody,
  type ResponsesEnvelope,
} from "./convert";
import { responsesStreamToChat } from "./stream";
import { NativeTerminalMapping } from "./native-terminal";

export interface ChatCompletionsDependencies {
  /** Invokes the production Responses handler with an already-translated payload. */
  invokeResponses: (request: Request) => Promise<Response>;
}

export async function chatCompletionsRequest(
  req: Request,
  dependencies: ChatCompletionsDependencies,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await readJsonRequestBody(req);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : "Invalid JSON body");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return formatErrorResponse(400, "invalid_request_error", "Request body must be a JSON object");
  }

  let built: BuiltRequest;
  let terminalMapping: NativeTerminalMapping | undefined;
  try {
    built = buildResponsesRequest(raw as ChatCompletionBody, req.headers);
    terminalMapping = NativeTerminalMapping.apply(built.payload);
  } catch (error) {
    return formatErrorResponse(400, "invalid_request_error", error instanceof Error ? error.message : String(error));
  }

  const upstreamRequest = new Request("http://codex-web-gpt.local/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(built.payload),
  });
  let response: Response;
  try {
    response = await dependencies.invokeResponses(upstreamRequest);
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
  if (!response.ok) {
    return response;
  }

  if (built.payload.stream === true) {
    if (!response.body) {
      return formatErrorResponse(502, "upstream_error", "Upstream returned no response body");
    }
    return new Response(
      responsesStreamToChat(response.body, {
        model: built.model,
        legacy: built.legacy,
        includeUsage: (raw as ChatCompletionBody).stream_options?.include_usage === true,
        terminalMapping,
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        },
      },
    );
  }

  let envelope: ResponsesEnvelope;
  try {
    envelope = await response.json() as ResponsesEnvelope;
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : "Invalid upstream response");
  }
  try {
    return Response.json(toChatCompletion(terminalMapping ? terminalMapping.response(envelope) : envelope, built.model, built.legacy));
  } catch (error) {
    return formatErrorResponse(502, "upstream_error", error instanceof Error ? error.message : String(error));
  }
}
