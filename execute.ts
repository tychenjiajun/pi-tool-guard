import type { ExtensionAPI, ExtensionContext, AgentToolResult, BashToolDetails } from "@earendil-works/pi-coding-agent";
import {
  stripTrailingExtractors,
  extractFullOutputPath,
} from "./pipeline.ts";
import {
  FAST_THRESHOLD_MS,
  buildNotice,
  isProjectionNoop,
  runExtractorOnFile,
  runExtractorOnText,
} from "./bash.ts";
import { formatProjectionSavings, measureText } from "./format.ts";
import { showGuardStatus } from "./tui.ts";
import {
  PI_TOOL_GUARD_CONTRACT_VERSION,
  PI_TOOL_GUARD_DETAILS_KEY,
  type PiToolGuardDetails,
  type PiToolGuardOutcome,
  type PiToolGuardProjection,
  type PiToolGuardTiming,
} from "./contract.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ToolResult = AgentToolResult<BashToolDetails | undefined>;

export type GuardedBashToolDetails = BashToolDetails & {
  [PI_TOOL_GUARD_DETAILS_KEY]?: PiToolGuardDetails;
};

export interface ExecuteContext {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  originalExecute: (
    toolCallId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    params: any,
    signal: AbortSignal | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onUpdate: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execCtx: any,
  ) => Promise<ToolResult>;
}

// ---------------------------------------------------------------------------
// Guard details
// ---------------------------------------------------------------------------

/**
 * Attach the versioned guard record to the result's details.
 *
 * `details` is preserved as-is. In particular, on `projection-applied` the
 * untruncated `fullOutputPath`/`truncation` are deliberately KEPT: the visible
 * `content` is the user's projection, but a downstream reducer (e.g. SoL-Pi's
 * evidence-preserving reducer) reads `fullOutputPath` to archive and reduce the
 * exact full log. Guard's projection is the fallback for when no reducer acts.
 */
function withGuardDetails(
  result: ToolResult,
  guard: PiToolGuardDetails,
): ToolResult {
  const details = { ...((result.details ?? {}) as Record<string, unknown>) };
  details[PI_TOOL_GUARD_DETAILS_KEY] = guard;
  return {
    ...result,
    details: details as BashToolDetails,
  };
}

/**
 * Join a tool result's text content into the string the cleaned command
 * produced — the "original" output guard's projection is compared against.
 */
function resultText(result: ToolResult): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function guardRecord(
  originalCommand: string,
  cleanedCommand: string,
  stripped: { removedNames: string[]; removedPipeline: string },
  outcome: PiToolGuardOutcome,
  sourcePath: string | undefined,
  timing: PiToolGuardTiming,
  extras: { projection?: PiToolGuardProjection; noop?: boolean } = {},
): PiToolGuardDetails {
  return {
    version: PI_TOOL_GUARD_CONTRACT_VERSION,
    originalCommand,
    cleanedCommand,
    removed: stripped.removedNames,
    removedPipeline: stripped.removedPipeline,
    outcome,
    ...(sourcePath ? { sourcePath } : {}),
    timing,
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// Core execute logic (extracted for testability)
// ---------------------------------------------------------------------------

export async function executeBashGuarded(
  ctx: ExecuteContext,
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onUpdate: any,
  execCtx: unknown,
): Promise<ToolResult> {
  const input = params as Record<string, unknown>;
  const originalCommand = typeof input.command === "string" ? input.command : undefined;
  if (!originalCommand) {
    return ctx.originalExecute(toolCallId, params, signal, onUpdate, execCtx);
  }

  const stripped = stripTrailingExtractors(originalCommand);
  if (!stripped) {
    return ctx.originalExecute(toolCallId, params, signal, onUpdate, execCtx);
  }

  // Execute the cleaned command through a copy, leaving the caller's args
  // untouched. `tool_result.input.command` (and Pi's tool-call display) then
  // keeps the command the user actually wrote, which is what the SoL-Pi
  // evidence-preserving reducer hashes and cites in its receipt.
  const cleanedParams = { ...input, command: stripped.cleaned };

  const commandStart = Date.now();
  let result: ToolResult;
  try {
    result = await ctx.originalExecute(toolCallId, cleanedParams, signal, onUpdate, execCtx);
  } catch (err) {
    // On error: check if output was saved to file, run extractor on it.
    // A thrown error cannot carry `details`, so this path intentionally does
    // not publish the guard contract.
    const errText = err instanceof Error ? err.message : String(err);
    const fullPath = extractFullOutputPath(errText);
    if (fullPath) {
      const extracted = await runExtractorOnFile(ctx.pi, fullPath, stripped.removedPipeline);
      if (extracted !== undefined) {
        const uiNotice = buildNotice(stripped.removedPipeline, originalCommand, "fast-file");
        ctx.ctx.ui.notify(uiNotice, "info");
        throw new Error(extracted);
      }
    }
    throw err;
  }

  // Time spent applying the stripped extractor pipeline. Accumulated across a
  // failed attempt so the illustration still shows guard's wasted cost.
  const commandMs = Date.now() - commandStart;
  let extractorMs = 0;
  const totalMs = () => commandMs + extractorMs;
  const resultDetails = result.details as BashToolDetails | undefined;
  const fullOutputPath = resultDetails?.fullOutputPath;

  // Case 1: Fast command, truncated → run extractor on the full output file
  if (commandMs < FAST_THRESHOLD_MS && fullOutputPath) {
    const extractorStart = Date.now();
    const extracted = await runExtractorOnFile(ctx.pi, fullOutputPath, stripped.removedPipeline);
    extractorMs += Date.now() - extractorStart;
    if (extracted !== undefined) {
      const noop = isProjectionNoop(extracted, resultText(result));
      if (!noop) {
        const uiNotice = buildNotice(stripped.removedPipeline, originalCommand, "fast-file");
        ctx.ctx.ui.notify(uiNotice, "info");
        showGuardStatus(ctx.ctx, `🛡 ${stripped.removedPipeline} · piped the saved temp file`);
      }
      return withGuardDetails(
        {
          content: [{ type: "text" as const, text: extracted }],
          details: result.details,
        },
        guardRecord(
          originalCommand,
          stripped.cleaned,
          stripped,
          "projection-applied",
          fullOutputPath,
          { commandMs, extractorMs, totalMs: totalMs() },
          { noop },
        ),
      );
    }
  }

  // Case 2: Fast command, not truncated → pipe result through extractor
  if (commandMs < FAST_THRESHOLD_MS && !fullOutputPath) {
    const originalText = resultText(result);
    const originalSize = measureText(originalText);

    const extractorStart = Date.now();
    const extracted = await runExtractorOnText(ctx.pi, originalText, stripped.removedPipeline);
    extractorMs += Date.now() - extractorStart;
    if (extracted !== undefined) {
      const projectedSize = measureText(extracted);
      const projection: PiToolGuardProjection = {
        inputLines: originalSize.lines,
        inputBytes: originalSize.bytes,
        outputLines: projectedSize.lines,
        outputBytes: projectedSize.bytes,
      };
      const noop = isProjectionNoop(extracted, originalText);

      if (!noop) {
        const uiNotice = buildNotice(stripped.removedPipeline, originalCommand, "fast");
        ctx.ctx.ui.notify(uiNotice, "info");
        showGuardStatus(
          ctx.ctx,
          `🛡 ${stripped.removedPipeline} · ${formatProjectionSavings(projection)}`,
        );
      }
      return withGuardDetails(
        {
          content: [{ type: "text" as const, text: extracted }],
          details: result.details,
        },
        guardRecord(
          originalCommand,
          stripped.cleaned,
          stripped,
          "projection-applied",
          undefined,
          { commandMs, extractorMs, totalMs: totalMs() },
          { projection, noop },
        ),
      );
    }
  }

  // Case 3: Slow command (truncated or not) → return result with LLM notice
  const uiNotice = buildNotice(stripped.removedPipeline, originalCommand, "slow");
  ctx.ctx.ui.notify(uiNotice, "info");
  showGuardStatus(ctx.ctx, `🛡 ${stripped.removedPipeline} · full output kept`);
  const llmNotice = `This is a slow command. Avoid re-running; prefer reading from the full output path if available.`;
  return withGuardDetails(
    {
      content: [...result.content, { type: "text" as const, text: `\n\n${llmNotice}` }],
      details: result.details,
    },
    guardRecord(
      originalCommand,
      stripped.cleaned,
      stripped,
      "full-output",
      fullOutputPath,
      { commandMs, extractorMs, totalMs: totalMs() },
    ),
  );
}
