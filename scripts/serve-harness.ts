import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config";
import { createLauncherDevAdapter } from "../src/dev-chat/driver";
import { startServer } from "../src/server";

// Run the fork's HTTP surface alongside the installed launcher. Tool calls belong to the
// launcher's existing external-owner broker, so its MCP connector can resolve their tokens.
const config = loadConfig();
if (config.mode !== "full" || config.browserHost !== "launcher") {
  throw new Error("Harness service requires the installed launcher in full mode");
}
const stateRoot = resolve(import.meta.dir, "..", "runtime", "harness");
mkdirSync(stateRoot, { recursive: true });
const { adapterFactory } = createLauncherDevAdapter(config, stateRoot);
const port = 17941;
startServer({
  ...config,
  host: "127.0.0.1",
  port,
  // startServer owns this separate listener; the adapter above uses the installed broker.
  brokerSocketPath: process.platform === "win32"
    ? "\\\\.\\pipe\\codex-web-harness-17941"
    : join(stateRoot, "broker.sock"),
}, { adapterFactory });
console.log(`Harness service listening on http://127.0.0.1:${port}/v1; launcher broker retained`);
