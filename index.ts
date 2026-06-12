import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type BashToolInput,
  type BashToolDetails,
  type EditToolInput,
  type ReadToolInput,
  type WriteToolInput,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  normalizeEditArgs,
  normalizeWriteArgs,
  normalizeReadArgs,
} from "./aliases.ts";
import {
  stripTrailingExtractors,
  extractFullOutputPath,
} from "./pipeline.ts";
import {
  FAST_THRESHOLD_MS,
  buildNotice,
  runExtractorOnFile,
  runExtractorOnText,
} from "./bash.ts";

// ---------------------------------------------------------------------------
// extension
// ---------------------------------------------------------------------------

export default function toolGuardExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // ── Override edit ──────────────────────────────────────────────────
    pi.registerTool({
      ...createEditToolDefinition(ctx.cwd),
      prepareArguments: (args: unknown): EditToolInput => {
        if (args && typeof args === "object") {
          normalizeEditArgs(args as Record<string, unknown>);
        }
        return args as EditToolInput;
      },
    });

    // ── Override write ─────────────────────────────────────────────────
    pi.registerTool({
      ...createWriteToolDefinition(ctx.cwd),
      prepareArguments: (args: unknown): WriteToolInput => {
        if (args && typeof args === "object") {
          normalizeWriteArgs(args as Record<string, unknown>);
        }
        return args as WriteToolInput;
      },
    });

    // ── Override read ──────────────────────────────────────────────────
    pi.registerTool({
      ...createReadToolDefinition(ctx.cwd),
      prepareArguments: (args: unknown): ReadToolInput => {
        if (args && typeof args === "object") {
          normalizeReadArgs(args as Record<string, unknown>);
        }
        return args as ReadToolInput;
      },
    });

    // ── Override bash ──────────────────────────────────────────────────
    const bashDef = createBashToolDefinition(ctx.cwd);
    const originalExecute = bashDef.execute;

    pi.registerTool({
      ...bashDef,
      prepareArguments: (args: unknown): BashToolInput => {
        if (!args || typeof args !== "object") return args as BashToolInput;

        const input = args as Record<string, unknown>;
        if (typeof input.command !== "string") return args as BashToolInput;

        const stripped = stripTrailingExtractors(input.command);
        if (stripped) {
          input.command = stripped.cleaned;
          input._piToolGuardRemoved = stripped.removedNames;
          input._piToolGuardPipeline = stripped.removedPipeline;
        }

        return input as unknown as BashToolInput;
      },

      async execute(toolCallId, params, signal, onUpdate, execCtx) {
        const input = params as Record<string, unknown>;
        const removedNames = input._piToolGuardRemoved as string[] | undefined;
        const removedPipeline = input._piToolGuardPipeline as string | undefined;

        // No extractors — run normally
        if (!removedNames || removedNames.length === 0 || !removedPipeline) {
          return originalExecute(toolCallId, params, signal, onUpdate, execCtx);
        }

        // Clean transient fields before running
        delete input._piToolGuardRemoved;
        delete input._piToolGuardPipeline;

        // Run the stripped command
        const start = Date.now();
        let result;
        try {
          result = await originalExecute(toolCallId, params, signal, onUpdate, execCtx);
        } catch (err) {
          // On error: check if output was saved to file, run extractor on it
          const errText = err instanceof Error ? err.message : String(err);
          const fullPath = extractFullOutputPath(errText);
          if (fullPath) {
            const extracted = await runExtractorOnFile(pi, fullPath, removedPipeline);
            if (extracted !== undefined) {
              const notice = buildNotice(removedNames);
              throw new Error(`${extracted}\n\n${notice}`);
            }
          }
          throw err;
        }

        const elapsed = Date.now() - start;

        // Case 1: Output was truncated → run extractor on the full output file
        const details = result.details as BashToolDetails | undefined;
        if (details?.fullOutputPath) {
          const extracted = await runExtractorOnFile(pi, details.fullOutputPath, removedPipeline);
          if (extracted !== undefined) {
            const notice = buildNotice(removedNames);
            return {
              content: [{ type: "text" as const, text: `${extracted}\n\n${notice}` }],
              details: result.details,
            };
          }
        }

        // Case 2: Fast command, no truncation → pipe result through extractor
        if (elapsed < FAST_THRESHOLD_MS) {
          const resultText = result.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");

          const extracted = await runExtractorOnText(pi, resultText, removedPipeline);
          if (extracted !== undefined) {
            const notice = buildNotice(removedNames);
            return {
              content: [{ type: "text" as const, text: `${extracted}\n\n${notice}` }],
              details: result.details,
            };
          }
        }

        // Case 3: Slow, no truncation → return full result with notice
        const notice = buildNotice(removedNames);
        return {
          content: [...result.content, { type: "text" as const, text: `\n\n${notice}` }],
          details: result.details,
        };
      },
    });

    ctx.ui.notify("pi-tool-guard: overriding edit/write/read/bash with corrections", "info");
  });
}
