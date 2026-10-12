import type { ExtensionAPI, ExtensionContext, AgentToolResult, BashToolDetails } from "@earendil-works/pi-coding-agent";
import {
  stripTrailingExtractors,
  type SideChannelSinks,
  type StripResult,
} from "./pipeline.ts";
import {
  FAST_THRESHOLD_MS,
  EMPTY_OUTPUT_PLACEHOLDER,
  type ExtractorRunResult,
  buildNotice,
  buildSlowReadbackNotice,
  isProjectionNoop,
  joinOutputStreams,
  createSideChannelPath,
  readSideChannel,
  removeSideChannel,
  resetSideChannel,
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
// Extractor-failure error
// ---------------------------------------------------------------------------

/**
 * Build the Error thrown when the extractor pipeline itself exits non-zero.
 * `body` is the extractor's stdout (or the placeholder when empty); the
 * message is `body` followed by a `[Command exited with code N]` bracket,
 * with the full-output path appended when one exists.
 */
function throwExtractorFailure(
  body: string,
  code: number,
  sourcePath?: string,
): never {
  const suffix = sourcePath
    ? `Command exited with code ${code}. Full output: ${sourcePath}`
    : `Command exited with code ${code}`;
  throw new Error(`${body}\n\n[${suffix}]`);
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
 *
 * `hoisted` carries the side-channel text of hoisted statements, which is
 * re-attached around the projection so the thrown message still contains every
 * byte the user's command printed.
 */
export async function rethrowGuardedError(
  ctx: ExecuteContext,
  stripped: { removedNames: string[]; removedPipeline: string },
  originalCommand: string,
  err: unknown,
  commandMs?: number,
  hoisted?: { prefix?: string; suffix?: string },
): Promise<never> {
  const parsed = parseBashError(err);
  if (parsed.exitCode === undefined) throw err;

  const extracted = parsed.fullOutputPath
    ? await runExtractorOnFile(ctx.pi, parsed.fullOutputPath, stripped.removedPipeline)
    : await runExtractorOnText(ctx.pi, parsed.text, stripped.removedPipeline);

  const body = joinOutputStreams(
    hoisted?.prefix,
    extracted !== undefined ? extracted.text : parsed.text,
    hoisted?.suffix,
    // Hoisted sinks end with the newline the shell wrote; drop it so the bracket
    // sits exactly two newlines below the body, as on the non-hoisted path.
  ).replace(/\n+$/, "");
  if (extracted !== undefined) {
    // A slow failing command deserves the "do NOT re-run" wording; only the
    // caller knows how long the cleaned command ran, so `commandMs` is passed
    // in from `executeBashGuarded`.
    const isSlow = commandMs !== undefined && commandMs >= FAST_THRESHOLD_MS;
    const mode = isSlow ? "slow" : parsed.fullOutputPath ? "fast-file" : "fast";
    const uiNotice = buildNotice(stripped.removedPipeline, originalCommand, mode);
    ctx.ctx.ui.notify(uiNotice, "info");
  }

  const suffix = [`Command exited with code ${parsed.exitCode}`];
  if (parsed.fullOutputPath) suffix.push(`Full output: ${parsed.fullOutputPath}`);
  throw new Error(`${body}\n\n[${suffix.join(". ")}]`);
}

// ---------------------------------------------------------------------------
// Side channels (hoisting)
// ---------------------------------------------------------------------------

/**
 * The two side-channel sink files a hoisted command needs. Hoisted statements
 * append their stdout+stderr there instead of the command's stdout, and the
 * guard re-attaches that text around the projection.
 */
interface SideChannels {
  sinks: SideChannelSinks;
  text(): { prefix: string; suffix: string };
  dispose(): void;
}

/**
 * Open both sinks up front (`resetSideChannel` truncates them) so the shell's
 * `>>` can never fail mid-run and short-circuit an `&&` chain — that would skip
 * the user's real command. Returns undefined when the OS temp dir is unusable,
 * in which case hoisting is skipped and the command is passed through.
 */
function openSideChannels(): SideChannels | undefined {
  const prefix = createSideChannelPath();
  const suffix = createSideChannelPath();
  if (!prefix || !suffix || !resetSideChannel(prefix) || !resetSideChannel(suffix)) {
    if (prefix) removeSideChannel(prefix);
    if (suffix) removeSideChannel(suffix);
    return undefined;
  }
  return {
    sinks: { prefix, suffix },
    text: () => ({ prefix: readSideChannel(prefix), suffix: readSideChannel(suffix) }),
    dispose: () => {
      removeSideChannel(prefix);
      removeSideChannel(suffix);
    },
  };
}

/**
 * Hoisting is only ever needed when a second statement (or an `AndOr` chain)
 * surrounds the pipeline, which requires one of these separators. Keeps the
 * common single-pipeline case from paying for two temp files.
 */
const MAY_HOIST_RE = /[;&\n]|\|\|/;

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

  // Strip without sinks first: that is the cheap, side-effect-free path, and it
  // also keeps the pre-hoisting behaviour byte-identical for every command that
  // does not need a side channel (`echo a && b | head` still passes through).
  let stripped = stripTrailingExtractors(originalCommand);
  let channels: SideChannels | undefined;
  if (!stripped && MAY_HOIST_RE.test(originalCommand)) {
    channels = openSideChannels();
    if (channels) stripped = stripTrailingExtractors(originalCommand, channels.sinks);
  }
  if (!stripped) {
    channels?.dispose();
    return ctx.originalExecute(toolCallId, params, signal, onUpdate, execCtx);
  }

  try {
    return await runGuardedBash(
      ctx,
      toolCallId,
      input,
      originalCommand,
      stripped,
      channels,
      signal,
      onUpdate,
      execCtx,
    );
  } finally {
    channels?.dispose();
  }
}

async function runGuardedBash(
  ctx: ExecuteContext,
  toolCallId: string,
  input: Record<string, unknown>,
  originalCommand: string,
  stripped: StripResult,
  channels: SideChannels | undefined,
  signal: AbortSignal | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onUpdate: any,
  execCtx: unknown,
): Promise<ToolResult> {
  // Text hoisted out of the projection window. The sinks only fill up once the
  // command has run, so they are read *after* `originalExecute` returns (or
  // throws) — and before the caller's `finally` disposes them.
  let hoisted = { prefix: "", suffix: "" };
  const readHoisted = (): void => {
    hoisted = channels?.text() ?? { prefix: "", suffix: "" };
  };
  const hasHoisted = (): boolean => hoisted.prefix.length > 0 || hoisted.suffix.length > 0;
  /**
   * Re-attach hoisted output around a projection, in the order the shell would
   * have written it. Without hoisting this is the identity, so every non-hoisted
   * path stays byte-identical to the pre-side-channel behaviour.
   */
  const assemble = (window: string): string =>
    hasHoisted()
      ? joinOutputStreams(
          hoisted.prefix,
          window === EMPTY_OUTPUT_PLACEHOLDER ? undefined : window,
          hoisted.suffix,
        )
      : window;

  // Execute the cleaned command through a copy, leaving the caller's args
  // untouched. `tool_result.input.command` (and Pi's tool-call display) then
  // keeps the command the user actually wrote, which is what the SoL-Pi
  // evidence-preserving reducer hashes and cites in its receipt.
  const cleanedParams = { ...input, command: stripped.execCommand };

  const commandStart = Date.now();
  let result: ToolResult;
  try {
    result = await ctx.originalExecute(toolCallId, cleanedParams, signal, onUpdate, execCtx);
    readHoisted();
  } catch (err) {
    readHoisted();
    return await rethrowGuardedError(
      ctx,
      stripped,
      originalCommand,
      err,
      Date.now() - commandStart,
      hoisted,
    );
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

  // Publish the guard's own persisted log as `details.fullOutputPath` when pi
  // did not truncate. Downstream consumers (notably SoL-Pi's evidence-preserving
  // reducer) read `details.fullOutputPath` in preference to regex-scanning the
  // content, so this is what makes slow-but-untruncated output reducible. When
  // pi already truncated, its own `pi-bash-*.log` is kept untouched.
  const resultWithPointer: ToolResult =
    sourcePath && !fullOutputPath
      ? {
          ...result,
          details: {
            ...((result.details ?? {}) as Record<string, unknown>),
            fullOutputPath: sourcePath,
          } as BashToolDetails,
        }
      : result;

  // Apply the stripped extractor pipeline to the full output (file or inline).
  const inlineSource = sourcePath ? undefined : resultText(result);
  const extractorStart = Date.now();
  const extracted = sourcePath
    ? await runExtractorOnFile(ctx.pi, sourcePath, stripped.removedPipeline)
    : await runExtractorOnText(ctx.pi, inlineSource ?? "", stripped.removedPipeline);
  const extractorMs = Date.now() - extractorStart;
  const timing: PiToolGuardTiming = { commandMs, extractorMs, totalMs: commandMs + extractorMs };

  // The projection branch is only safe when we either ran fast (inline) or
  // have a persisted full-output file to point the readback notice at.
  const canProject = !isSlow || sourcePath !== undefined;

  if (extracted !== undefined) {
    // #1: the extractor pipeline itself exited non-zero. pi's native
    // `cmd | extractor` pipeline would fail with the last command's exit code
    // (no pipefail), so mirror that: exit 1 from `grep`/`rg` on no match is a
    // failure here too, not a silent empty success.
    //
    // That only holds while the extractor *is* the command's last command. When
    // a statement runs after the window (`a | grep x; echo "R=$?"`) bash exits
    // with that statement's status — `originalExecute` returning normally is the
    // proof the script succeeded — so the extractor's own status (which the
    // hoisted suffix reports) must not be turned into a command failure.
    if (extracted.code !== 0 && !stripped.hasFollowingStatement) {
      if (isSlow) {
        const uiNotice = buildNotice(stripped.removedPipeline, originalCommand, "slow");
        ctx.ctx.ui.notify(uiNotice, "info");
      }
      throwExtractorFailure(
        extracted.text || EMPTY_OUTPUT_PLACEHOLDER,
        extracted.code,
        sourcePath,
      );
    }

    if (canProject) {
      // #4: empty-output fidelity — pi renders an empty result as the literal
      // "(no output)". When the inline source is exactly that placeholder and
      // the projection came back empty/whitespace-only, keep the placeholder
      // so the visible result matches what pi would have shown.
      const isPlaceholderProjection =
        inlineSource === EMPTY_OUTPUT_PLACEHOLDER &&
        extracted.text.trim().length === 0;

      const projectedText = isPlaceholderProjection
        ? EMPTY_OUTPUT_PLACEHOLDER
        : extracted.text;

      // F5: noop detection — only meaningful for inline (non-file) projections.
      // A hoisted statement means the returned content *did* change relative to
      // the executed command, so the guard is never a no-op there.
      const noop =
        !hasHoisted() &&
        inlineSource !== undefined &&
        isProjectionNoop(projectedText, isPlaceholderProjection ? EMPTY_OUTPUT_PLACEHOLDER : inlineSource);
      const projection: PiToolGuardProjection | undefined =
        inlineSource !== undefined
          ? (() => {
              const inputSize = measureText(isPlaceholderProjection ? EMPTY_OUTPUT_PLACEHOLDER : inlineSource);
              const outputSize = measureText(projectedText);
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

      const body = assemble(projectedText);
      const text = notices.length ? `${body}\n\n${notices.join("\n\n")}` : body;
      return withGuardDetails(
        {
          content: [{ type: "text" as const, text }],
          details: resultWithPointer.details,
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
    // fall through to full-output branch below
  }

  // Extractor failed to run, or projection unsafe (slow + no persist) → return
  // full output with LLM notice
  if (isSlow) {
    const uiNotice = buildNotice(stripped.removedPipeline, originalCommand, "slow");
    ctx.ctx.ui.notify(uiNotice, "info");
    showGuardStatus(ctx.ctx, `🛡 ${stripped.removedPipeline} · full output kept`);
  }
  const llmNotice = isSlow
    ? buildSlowReadbackNotice(originalCommand, sourcePath)
    : "The projection could not be applied; showing the full output.";
  const fullBody = assemble(resultText(result));
  return withGuardDetails(
    {
      content: hasHoisted()
        ? [{ type: "text" as const, text: `${fullBody}\n\n${llmNotice}` }]
        : [...result.content, { type: "text" as const, text: `\n\n${llmNotice}` }],
      details: resultWithPointer.details,
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
