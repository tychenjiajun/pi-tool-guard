import type { ExtensionAPI, ExtensionContext, AgentToolResult, BashToolDetails } from "@earendil-works/pi-coding-agent";
import {
  stripTrailingExtractors,
} from "./pipeline.ts";
import {
  FAST_THRESHOLD_MS,
  buildNotice,
  buildSlowReadbackNotice,
  isProjectionNoop,
  runExtractorOnFile,
  runExtractorOnText,
  persistFullOutput,
  parseBashError,
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
  extras: { projection?: PiToolGuardProjection; noop?: boolean; slow?: boolean } = {},
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
// F1: error rethrow with projection
// ---------------------------------------------------------------------------

/**
 * F1: when the cleaned command throws, parse the error for a truncation banner
 * and exit code, run the stripped extractor on the full output (file or
 * inline), and rethrow a new Error whose message is the projected text plus a
 * `[Command exited with code N. Full output: <path>]` suffix. If the error is
 * not a bash exit-code error (abort/timeout), rethrow it unchanged.
 */
export async function rethrowGuardedError(
  ctx: ExecuteContext,
  stripped: { removedNames: string[]; removedPipeline: string },
  originalCommand: string,
  err: unknown,
): Promise<never> {
  const parsed = parseBashError(err);
  if (parsed.exitCode === undefined) throw err;

  const extracted = parsed.fullOutputPath
    ? await runExtractorOnFile(ctx.pi, parsed.fullOutputPath, stripped.removedPipeline)
    : await runExtractorOnText(ctx.pi, parsed.text, stripped.removedPipeline);

  const body = extracted !== undefined ? extracted : parsed.text;
  if (extracted !== undefined) {
    const mode = parsed.fullOutputPath ? "fast-file" : "fast";
    const uiNotice = buildNotice(stripped.removedPipeline, originalCommand, mode);
    ctx.ctx.ui.notify(uiNotice, "info");
  }

  const suffix = [`Command exited with code ${parsed.exitCode}`];
  if (parsed.fullOutputPath) suffix.push(`Full output: ${parsed.fullOutputPath}`);
  throw new Error(`${body}\n\n[${suffix.join(". ")}]`);
}

// ---------------------------------------------------------------------------
// Core execute logic
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
    return await rethrowGuardedError(ctx, stripped, originalCommand, err);
  }
  const commandMs = Date.now() - commandStart;

  const resultDetails = result.details as BashToolDetails | undefined;
  const fullOutputPath = resultDetails?.fullOutputPath;
  const isSlow = commandMs >= FAST_THRESHOLD_MS;

  // F4: slow commands always get a persisted full-output file
  let sourcePath = fullOutputPath;
  if (isSlow && !sourcePath) {
    sourcePath = persistFullOutput(resultText(result));
  }

  // Apply the stripped extractor pipeline to the full output (file or inline).
  const inlineSource = sourcePath ? undefined : resultText(result);
  const extractorStart = Date.now();
  const extracted = sourcePath
    ? await runExtractorOnFile(ctx.pi, sourcePath, stripped.removedPipeline)
    : await runExtractorOnText(ctx.pi, inlineSource ?? "", stripped.removedPipeline);
  const extractorMs = Date.now() - extractorStart;
  const timing: PiToolGuardTiming = { commandMs, extractorMs, totalMs: commandMs + extractorMs };

  if (extracted !== undefined) {
    // F5: noop detection — only meaningful for inline (non-file) projections
    const noop = inlineSource !== undefined ? isProjectionNoop(extracted, inlineSource) : false;
    const projection: PiToolGuardProjection | undefined =
      inlineSource !== undefined
        ? (() => {
            const inputSize = measureText(inlineSource);
            const outputSize = measureText(extracted);
            return {
              inputLines: inputSize.lines,
              inputBytes: inputSize.bytes,
              outputLines: outputSize.lines,
              outputBytes: outputSize.bytes,
            };
          })()
        : undefined;

    // Slow commands persist the full, unextracted output so the agent can
    // read it later instead of re-running the command. Without an extractor
    // notice there is nothing for the file to point at, so only stamp it here.
    const notices: string[] = [];
    if (isSlow) notices.push(buildSlowReadbackNotice(originalCommand, sourcePath));

    if (!noop && isSlow) {
      const uiNotice = buildNotice(stripped.removedPipeline, originalCommand, "slow");
      ctx.ctx.ui.notify(uiNotice, "info");
      showGuardStatus(
        ctx.ctx,
        `🛡 ${stripped.removedPipeline} · ${projection ? formatProjectionSavings(projection) : "projection applied"}`,
      );
    }

    const text = notices.length ? `${extracted}\n\n${notices.join("\n\n")}` : extracted;
    return withGuardDetails(
      {
        content: [{ type: "text" as const, text }],
        details: result.details,
      },
      guardRecord(
        originalCommand,
        stripped.cleaned,
        stripped,
        "projection-applied",
        sourcePath,
        timing,
        { projection, noop, slow: isSlow },
      ),
    );
  }

  // Extractor failed to run → return full output with LLM notice
  if (isSlow) {
    const uiNotice = buildNotice(stripped.removedPipeline, originalCommand, "slow");
    ctx.ctx.ui.notify(uiNotice, "info");
    showGuardStatus(ctx.ctx, `🛡 ${stripped.removedPipeline} · full output kept`);
  }
  const llmNotice = isSlow
    ? buildSlowReadbackNotice(originalCommand, sourcePath)
    : "The projection could not be applied; showing the full output.";
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
      sourcePath,
      timing,
      { slow: isSlow },
    ),
  );
}
