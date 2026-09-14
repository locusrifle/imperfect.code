import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyEnvironment, fillEnvironment } from "../../native/environment-prompt.mjs";

const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../environment.md"), "utf8");

function prefix() {
  return process.env.IMPERFECT_PREFIX || "/opt/imperfect";
}

function person() {
  if (process.env.IMPERFECT_PERSON) return process.env.IMPERFECT_PERSON;
  try {
    return JSON.parse(readFileSync(join(prefix(), "machine.json"), "utf8")).person || "";
  } catch {
    return "";
  }
}

function personPage() {
  try {
    return readFileSync(join(prefix(), "data", "person.md"), "utf8").trim();
  } catch {
    return "";
  }
}

export default function locusEnvironment(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event) => {
    const block = [fillEnvironment(template, person()), personPage()].filter(Boolean).join("\n\n");
    return { systemPrompt: applyEnvironment(event.systemPrompt, block) };
  });
}
