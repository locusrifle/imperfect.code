// The image lab's tool.
//
// The lab has a prompt box of its own, so why this exists: the person asks
// their machine for things in one place, and "make me a picture of the shed
// with a green roof" is that kind of asking. A picture made here lands in the
// same library the lab draws, in the same folders, so the two are one thing
// with two doors rather than two collections that drift apart.
//
// The engine is shared with the lab's own routes -- one place where a
// subscription is spent and a file is written. This file is only the part that
// explains it to the model.

import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { generateImage, CodexSignedOut } from "../../native/codex-images.mjs";
import { createImageLab } from "../../native/image-lab.mjs";

function labRoot() {
  // The same answer the server computes. The Pi process runs with the
  // workspace as its cwd, which is what the unit's WorkingDirectory sets.
  return process.env.GUEY_LAB_ROOT || join(process.cwd(), "images");
}

export default function imageLab(pi: ExtensionAPI) {
  pi.registerTool({
    name: "generate_image",
    label: "Image Lab",
    description:
      "Draw a picture with the machine owner's ChatGPT subscription and file it in their image lab. " +
      "Use this when the person asks for an image, illustration, photograph, logo, texture or mockup. " +
      "Optionally combine reference images already in the lab by passing their ids. " +
      "The picture appears in the Image Lab application.",
    promptSnippet: "Draw a picture into the person's image lab",
    parameters: Type.Object({
      prompt: Type.String({
        description: "What to draw. Describe subject, style, colours and framing plainly.",
      }),
      combine: Type.Optional(Type.Array(Type.String(), {
        description:
          "Ids of pictures or pins already in the lab to use as references, in the order they matter.",
      })),
      folder: Type.Optional(Type.String({
        description: "Id of a lab folder to file the picture in. Omit for the top level.",
      })),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const prompt = String(params?.prompt ?? "").trim();
      const combine = Array.isArray(params?.combine) ? params.combine.map(String) : [];
      const folder = String(params?.folder ?? "");
      if (!prompt) throw new Error("generate_image needs a prompt describing the picture");

      const lab = createImageLab({ root: labRoot() });
      const references = await lab.referencePaths(combine);

      // A picture is the better part of a minute. Without this the harness
      // shows a tool that has been running silently since the person asked,
      // which is the same complaint the app drawer earned.
      onUpdate?.({ content: [{ type: "text", text: "drawing…" }] });

      try {
        const { image, revisedPrompt } = await generateImage({
          prompt,
          references,
          signal,
          onPartial: () => onUpdate?.({ content: [{ type: "text", text: "drawing…" }] }),
        });
        const saved = await lab.savePicture({ image, prompt, references: combine, folder });
        return {
          // The id is the useful part: it is what a following turn passes back
          // in `combine` to build on the picture just made.
          content: [{
            type: "text",
            text: [
              "Filed a new picture in the image lab.",
              `id: ${saved.id}`,
              revisedPrompt ? `drawn as: ${revisedPrompt}` : "",
              "Tell the person to open the Image Lab application to see it.",
            ].filter(Boolean).join("\n"),
          }],
          details: { id: saved.id, prompt, combine },
        };
      } catch (error) {
        // A sign-out is an instruction to the person, not a failure the model
        // should retry or work around. Returned rather than thrown, because a
        // thrown error invites another attempt against a door that is shut.
        if (error instanceof CodexSignedOut) {
          return {
            content: [{
              type: "text",
              text: `Cannot draw: ${error.message}. Tell the person to sign in to their ChatGPT subscription with pi. Do not call this tool again this turn.`,
            }],
            details: { signedOut: true },
            terminate: true,
          };
        }
        throw error;
      }
    },
  });
}
