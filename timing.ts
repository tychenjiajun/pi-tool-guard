import type { PiToolGuardTiming } from "./contract.ts";

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------
//
// Pi's built-in bash renderer prints a single opaque `Took <wall-clock>` line
// that silently swallows the guard's extra extractor run. The guard replaces
// it with a per-phase split so the user can see where the time went:
//
//   Took 6.5s  ███████████████░░░░  cmd 5.0s · filter 1.5s
//
// `█` is the cleaned command, `░` is the guard's extractor projection.

export const BAR_WIDTH = 18;

/** Render a millisecond duration compactly (`850ms`, `6.5s`). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Split `barWidth` cells between the two phases, proportional to their share
 * of `totalMs`. The filter always keeps at least one cell when it cost time.
 */
export function timingBarSplit(
  timing: PiToolGuardTiming,
  barWidth: number = BAR_WIDTH,
): { command: number; filter: number } {
  const width = Math.max(1, Math.floor(barWidth));
  const total = Math.max(timing.totalMs, 1);
  let command = Math.round(width * (timing.commandMs / total));
  if (timing.extractorMs > 0) command = Math.min(command, width - 1);
  command = Math.max(0, Math.min(width, command));
  return { command, filter: width - command };
}

/** Plain block-character bar (uncolored; the renderer applies theme colors). */
export function buildTimingBar(
  timing: PiToolGuardTiming,
  barWidth: number = BAR_WIDTH,
): string {
  const { command, filter } = timingBarSplit(timing, barWidth);
  return "█".repeat(command) + "░".repeat(filter);
}
