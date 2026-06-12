import type { ExtensionAPI, ExtensionContext, AgentToolResult, BashToolDetails } from "@earendil-works/pi-coding-agent";
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
// Types
// ---------------------------------------------------------------------------

export type ToolResult = AgentToolResult<BashToolDetails | undefined>;

export interface ExecuteContext {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  originalExecute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    execCtx: unknown,
  ) => Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Core execute logic (extracted for testability)
// ---------------------------------------------------------------------------

export async function executeBashGuarded(
  ctx: ExecuteContext,
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  onUpdate: ((update: unknown) => void) | undefined,
  execCtx: unknown,
): Promise<ToolResult> {
  const input = params as Record<string, unknown>;
  const removedNames = input._piToolGuardRemoved as string[] | undefined;
  const removedPipeline = input._piToolGuardPipeline as string | undefined;

  // No extractors — run normally
  if (!removedNames || removedNames.length === 0 || !removedPipeline) {
    return ctx.originalExecute(toolCallId, params, signal, onUpdate, execCtx);
  }

  // Clean transient fields before running
  delete input._piToolGuardRemoved;
  delete input._piToolGuardPipeline;

  // Run the stripped command
  const start = Date.now();
  let result;
  try {
    result = await ctx.originalExecute(toolCallId, params, signal, onUpdate, execCtx);
  } catch (err) {
    // On error: check if output was saved to file, run extractor on it
    const errText = err instanceof Error ? err.message : String(err);
    const fullPath = extractFullOutputPath(errText);
    if (fullPath) {
      const extracted = await runExtractorOnFile(ctx.pi, fullPath, removedPipeline);
      if (extracted !== undefined) {
        const uiNotice = buildNotice(removedNames, "fast");
        ctx.ctx.ui.notify(uiNotice, "info");
        throw new Error(extracted);
      }
    }
    throw err;
  }

  const elapsed = Date.now() - start;
  const details = result.details as BashToolDetails | undefined;
  const isTruncated = !!details?.fullOutputPath;

  // Case 1: Fast command, truncated → run extractor on the full output file
  if (elapsed < FAST_THRESHOLD_MS && isTruncated) {
    const extracted = await runExtractorOnFile(ctx.pi, details!.fullOutputPath!, removedPipeline);
    if (extracted !== undefined) {
      const uiNotice = buildNotice(removedNames, "fast");
      ctx.ctx.ui.notify(uiNotice, "info");
      return {
        content: [{ type: "text" as const, text: extracted }],
        details: result.details,
      };
    }
  }

  // Case 2: Fast command, not truncated → pipe result through extractor
  if (elapsed < FAST_THRESHOLD_MS && !isTruncated) {
    const resultText = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");

    const extracted = await runExtractorOnText(ctx.pi, resultText, removedPipeline);
    if (extracted !== undefined) {
      const uiNotice = buildNotice(removedNames, "fast");
      ctx.ctx.ui.notify(uiNotice, "info");
      return {
        content: [{ type: "text" as const, text: extracted }],
        details: result.details,
      };
    }
  }

  // Case 3: Slow command (truncated or not) → return result with LLM notice
  const uiNotice = buildNotice(removedNames, "slow");
  ctx.ctx.ui.notify(uiNotice, "info");
  const llmNotice = `This is a slow command. Avoid re-running; prefer reading from the full output path if available.`;
  return {
    content: [...result.content, { type: "text" as const, text: `\n\n${llmNotice}` }],
    details: result.details,
  };
}

// ---------------------------------------------------------------------------
// prepareArguments logic (extracted for testability)
// ---------------------------------------------------------------------------

export function prepareBashArguments(input: Record<string, unknown>): Record<string, unknown> {
  if (typeof input.command !== "string") return input;

  const stripped = stripTrailingExtractors(input.command);
  if (stripped) {
    input.command = stripped.cleaned;
    input._piToolGuardRemoved = stripped.removedNames;
    input._piToolGuardPipeline = stripped.removedPipeline;
  }

  return input;
}
