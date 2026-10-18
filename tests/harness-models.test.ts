import { expect, test } from "bun:test";
import { defaultConfig } from "../src/config";
import { chatCompletionsModelCatalog, isLocalHarnessModelDiscovery } from "../src/harness-compat/models";

test("keyless Hermes discovery is distinct from native Codex OAuth discovery", () => {
  const request = (authorization?: string) => new Request("http://127.0.0.1:17941/v1/models", {
    headers: authorization ? { authorization } : {},
  });
  expect(isLocalHarnessModelDiscovery(request())).toBe(true);
  expect(isLocalHarnessModelDiscovery(request("Bearer no-key-required"))).toBe(true);
  expect(isLocalHarnessModelDiscovery(request("Bearer hermes-local"))).toBe(true);
  expect(isLocalHarnessModelDiscovery(request("Bearer actual-native-codex-credential"))).toBe(false);
});

test("Hermes model discovery returns an OpenAI model list without Codex credentials", async () => {
  const config = defaultConfig("full");
  config.solAvailable = true;
  config.proAvailable = false;
  const response = chatCompletionsModelCatalog(config);
  expect(response.status).toBe(200);
  const body = await response.json() as { object: string; data: Array<{
    id: string; object: string; owned_by: string; context_window: number; input_modalities: string[];
  }> };
  expect(body.object).toBe("list");
  expect(body.data.map(model => model.id)).toContain("chatgpt-web/gpt-6-sol");
  expect(body.data.every(model => model.object === "model" && model.owned_by === "chatgpt-web" && model.context_window > 0)).toBe(true);
  expect(body.data.find(model => model.id === "chatgpt-web/gpt-6-sol")?.input_modalities).toEqual(["text", "image"]);
  expect(body.data.some(model => model.id === "chatgpt-web/gpt-6-pro")).toBe(false);
});

test("manual-only account advertises only text-capable selected model", async () => {
  const config = defaultConfig("full");
  config.browserInteractionMode = "manual";
  const response = await chatCompletionsModelCatalog(config).json() as { data: Array<{ id: string; input_modalities: string[] }> };
  expect(response.data).toHaveLength(1);
  expect(response.data[0]?.input_modalities).toEqual(["text"]);
});
