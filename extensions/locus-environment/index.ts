import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyEnvironment, fillEnvironment } from "../../native/environment-prompt.mjs";

const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../environment.md"), "utf8");

function person() {
  if (process.env.IMPERFECT_PERSON) return process.env.IMPERFECT_PERSON;
  const prefix = process.env.IMPERFECT_PREFIX || "/opt/imperfect";
  try {
    return JSON.parse(readFileSync(join(prefix, "machine.json"), "utf8")).person || "";
  } catch {
    return "";
  }
}

export default function locusEnvironment(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: applyEnvironment(event.systemPrompt, fillEnvironment(template, person())),
  }));
}
