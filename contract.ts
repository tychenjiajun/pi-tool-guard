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
// finds the full log and can override the guard's projection.
//
// The shape is versioned and additive-only. Consumers MUST ignore unknown
// fields and MUST fall back to the inline content when `version` is not
// understood, so an older consumer never expands a projection back into the
// full log.
//
// `pi-tool-guard` also uses this record to stay honest with Pi itself: on a
// `projection-applied` result it removes `details.fullOutputPath` and
// `details.truncation`, because the visible content is no longer a truncated
// full output. `sourcePath` keeps the pointer for consumers that understand
// the contract.

export const PI_TOOL_GUARD_DETAILS_KEY = "piToolGuard" as const;
export const PI_TOOL_GUARD_CONTRACT_VERSION = 1 as const;

export type PiToolGuardOutcome =
  /** `content` is the result of re-running the stripped extractor pipeline. */
  | "projection-applied"
  /** `content` is the cleaned command's full (possibly truncated) output. */
  | "full-output";

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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  } = record;

  if (version !== PI_TOOL_GUARD_CONTRACT_VERSION) return undefined;
  if (outcome !== "projection-applied" && outcome !== "full-output") return undefined;
  if (typeof originalCommand !== "string" || typeof cleanedCommand !== "string") return undefined;
  if (!Array.isArray(removed) || !removed.every((name) => typeof name === "string")) return undefined;
  if (typeof removedPipeline !== "string") return undefined;

  return {
    version: PI_TOOL_GUARD_CONTRACT_VERSION,
    originalCommand,
    cleanedCommand,
    removed,
    removedPipeline,
    outcome,
    ...(typeof sourcePath === "string" ? { sourcePath } : {}),
  };
}
