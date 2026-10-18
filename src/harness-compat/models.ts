/** OpenAI-compatible discovery for local Chat Completions clients such as Hermes.
 * Native Codex clients use the authenticated upstream model catalog instead.
 */
import type { AppConfig } from "../config";
import { availableChatGptWebModelRoutes, resolveChatGptWebContextLimits } from "../chatgpt-web-models";

/** Hermes and OpenAI SDKs fill keyless loopback connections with this sentinel. */
export function isLocalHarnessModelDiscovery(request: Request): boolean {
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  return !authorization || /^Bearer (?:no-key-required|hermes-local)$/i.test(authorization);
}

export function chatCompletionsModelCatalog(config: AppConfig): Response {
  const data = availableChatGptWebModelRoutes(config).map(route => ({
    id: route.slug,
    object: "model",
    created: 0,
    owned_by: "chatgpt-web",
    context_window: resolveChatGptWebContextLimits(
      route.backendModel, route.adapterEffort, config,
      route.interactionMode === "automatic" ? route.modelFamily : undefined,
    ).contextWindow,
    input_modalities: route.interactionMode === "manual" ? ["text"] : ["text", "image"],
  }));
  return Response.json({ object: "list", data });
}
