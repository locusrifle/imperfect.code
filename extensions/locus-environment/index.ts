import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyEnvironment } from "../../native/environment-prompt.mjs";

const environment = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../environment.md"), "utf8");

export default function locusEnvironment(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: applyEnvironment(event.systemPrompt, environment),
  }));
}
