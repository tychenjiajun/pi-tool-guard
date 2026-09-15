// ---------------------------------------------------------------------------
// Cross-extension contract: details.piToolGuard
// ---------------------------------------------------------------------------
//
// Pi persists `details` on every tool result and hands it to `tool_result`
// handlers. `pi-tool-guard` runs the bash tool itself (in `execute`), so it is
// always the first party able to describe what happened to the command. Other
// extensions that post-process bash output — notably the SoL-Pi
// evidence-preserving reducer — can only see the final result.
//
// When `pi-tool-guard` strips trailing extractors it stamps
// `details.piToolGuard` so those consumers can tell:
//
//   * what the user actually asked for (`originalCommand`),
//   * what was executed (`cleanedCommand`),
//   * whether the visible `content` is already the user's projection
//     (`outcome === "projection-applied"`) or the cleaned command's full,
//     possibly truncated, output (`outcome === "full-output"`),
//   * where the untruncated output lives (`sourcePath`).
//
// `details.fullOutputPath` is always preserved, including on a
// `projection-applied` result, so a reducer that predates this contract still
// finds the full log and can override the guard's projection. When pi did not
// truncate but the guard persisted its own slow log, the guard publishes that
// path as `details.fullOutputPath` too (the file is named `pi-bash-guard-*.log`
// so consumers that only trust pi's `pi-bash-*.log` temp artifacts accept it).
//
// The shape is versioned and additive-only. Consumers MUST ignore unknown
// fields and MUST fall back to the inline content when `version` is not
// understood, so an older consumer never expands a projection back into the
// full log.
//
// `pi-tool-guard` also uses this record to stay honest with Pi itself: the
// guard always preserves `details.fullOutputPath` and `details.truncation`,
// even on a `projection-applied` result, and sets `details.fullOutputPath` to
// its own persisted log when pi did not truncate, so a downstream reducer can
// read the exact full log. `piToolGuard.sourcePath` mirrors that pointer for
// consumers that understand the contract.

export const PI_TOOL_GUARD_DETAILS_KEY = "piToolGuard" as const;
export const PI_TOOL_GUARD_CONTRACT_VERSION = 1 as const;

export type PiToolGuardOutcome =
  /** `content` is the result of re-running the stripped extractor pipeline. */
  | "projection-applied"
  /** `content` is the cleaned command's full (possibly truncated) output. */
  | "full-output";

/**
 * Wall-clock cost of the guard's work, split by phase. Published on
 * `details.piToolGuard` so the UI can explain what pi's single "Took" line is
 * made of: the cleaned command ran for `commandMs`, the extractor projection
 * the guard ran afterwards cost `extractorMs`, and `totalMs` is their sum.
 */
export interface PiToolGuardTiming {
  /** Time spent executing the cleaned command. */
  readonly commandMs: number;
  /** Time spent applying the stripped extractor pipeline. `0` when none ran. */
  readonly extractorMs: number;
  /** `commandMs + extractorMs` — the wall clock the guard is accountable for. */
  readonly totalMs: number;
}

/**
 * What the extractor projection did to the output, measured before/after.
 * Published only when the guard held both the input and the projected text
 * (inline fast commands); a truncated command's "original" lives in a file, so
 * its pre-projection size is not known cheaply.
 */
export interface PiToolGuardProjection {
  /** Lines/bytes the cleaned command returned before the extractor ran. */
  readonly inputLines: number;
  readonly inputBytes: number;
  /** Lines/bytes after the extractor ran — what the model actually sees. */
  readonly outputLines: number;
  readonly outputBytes: number;
}

export interface PiToolGuardDetails {
  readonly version: typeof PI_TOOL_GUARD_CONTRACT_VERSION;
  readonly originalCommand: string;
  readonly cleanedCommand: string;
  readonly removed: readonly string[];
  readonly removedPipeline: string;
  readonly outcome: PiToolGuardOutcome;
  /**
   * Absolute path to the untruncated output file, when Pi produced one.
   *
   * This mirrors `details.fullOutputPath`, which the guard always preserves so
   * that a downstream reducer can archive the exact full log even when
   * `outcome` is `projection-applied` (guard applied its own projection as a
   * fallback). A consumer that understands this contract may prefer
   * `sourcePath`; one that does not should keep reading `fullOutputPath`.
   */
  readonly sourcePath?: string;
  /**
   * Per-phase timing, when the guard took effect. Additive and optional:
   * consumers that predate it simply ignore it.
   */
  readonly timing?: PiToolGuardTiming;
  /** Before/after size of the projection, when measurable. */
  readonly projection?: PiToolGuardProjection;
  /**
   * True when applying the extractor left the output unchanged. The guard is
   * then a no-op: it publishes the contract but shows no Notice and no receipt.
   */
  readonly noop?: boolean;
  /**
   * True when the cleaned command ran for at least `FAST_THRESHOLD_MS`. Only
   * slow runs surface guard UI (Notice, footer status, Guard Receipt); fast
   * commands stay visually identical to the built-in bash tool.
   */
  readonly slow?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseTiming(value: unknown): PiToolGuardTiming | undefined {
  if (!isRecord(value)) return undefined;
  const { commandMs, extractorMs, totalMs } = value;
  if (!isFiniteNumber(commandMs) || !isFiniteNumber(extractorMs) || !isFiniteNumber(totalMs)) {
    return undefined;
  }
  return { commandMs, extractorMs, totalMs };
}

function parseProjection(value: unknown): PiToolGuardProjection | undefined {
  if (!isRecord(value)) return undefined;
  const { inputLines, inputBytes, outputLines, outputBytes } = value;
  if (
    !isFiniteNumber(inputLines) ||
    !isFiniteNumber(inputBytes) ||
    !isFiniteNumber(outputLines) ||
    !isFiniteNumber(outputBytes)
  ) {
    return undefined;
  }
  return { inputLines, inputBytes, outputLines, outputBytes };
}

/**
 * Parse `details.piToolGuard`. Returns `undefined` for missing records and for
 * records written by a contract version this build does not understand.
 *
 * Consumers should treat `undefined` as "no guard metadata": use the inline
 * content as the source of truth and never re-expand from `fullOutputPath`.
 */
export function readPiToolGuardDetails(details: unknown): PiToolGuardDetails | undefined {
  if (!isRecord(details)) return undefined;
  const record = details[PI_TOOL_GUARD_DETAILS_KEY];
  if (!isRecord(record)) return undefined;

  const {
    version,
    originalCommand,
    cleanedCommand,
    removed,
    removedPipeline,
    outcome,
    sourcePath,
    timing,
    projection,
    noop,
    slow,
  } = record;

  if (version !== PI_TOOL_GUARD_CONTRACT_VERSION) return undefined;
  if (outcome !== "projection-applied" && outcome !== "full-output") return undefined;
  if (typeof originalCommand !== "string" || typeof cleanedCommand !== "string") return undefined;
  if (!Array.isArray(removed) || !removed.every((name) => typeof name === "string")) return undefined;
  if (typeof removedPipeline !== "string") return undefined;

  const parsedTiming = parseTiming(timing);
  const parsedProjection = parseProjection(projection);
  return {
    version: PI_TOOL_GUARD_CONTRACT_VERSION,
    originalCommand,
    cleanedCommand,
    removed,
    removedPipeline,
    outcome,
    ...(typeof sourcePath === "string" ? { sourcePath } : {}),
    ...(parsedTiming ? { timing: parsedTiming } : {}),
    ...(parsedProjection ? { projection: parsedProjection } : {}),
    ...(typeof noop === "boolean" ? { noop } : {}),
    ...(typeof slow === "boolean" ? { slow } : {}),
  };
}
