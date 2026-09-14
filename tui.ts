import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";

import type { PiToolGuardDetails, PiToolGuardTiming } from "./contract.ts";
import { formatProjectionSavings } from "./format.ts";
import { BAR_WIDTH, formatDuration, timingBarSplit } from "./timing.ts";

// ---------------------------------------------------------------------------
// Guard UI, in the SoL-Pi house style:
//
//   🛡 pi-tool-guard · tail -20
//      Context saved · 1,234 → 20 lines · 98% smaller · 12.1 KiB saved
//      Took 6.5s  ███████████████░░░░  cmd 5.0s · filter 1.5s
// ---------------------------------------------------------------------------

const GUARD_GLYPH = "🛡";
const STATUS_KEY = "pi-tool-guard";
const STATUS_DURATION_MS = 4_000;
const statusTimers = new WeakMap<ExtensionContext["ui"], ReturnType<typeof setTimeout>>();

/** `🛡 pi-tool-guard · <pipeline>` — the receipt/report title line. */
export function guardTitle(theme: Theme, pipeline: string): string {
  return (
    `${theme.fg("warning", GUARD_GLYPH)} ` +
    `${theme.fg("accent", theme.bold("pi-tool-guard"))} ` +
    `${theme.fg("dim", `· ${pipeline}`)}`
  );
}

/** The split timing line with a colored proportional bar. */
export function renderTimingLine(theme: Theme, timing: PiToolGuardTiming): string {
  const { command, filter } = timingBarSplit(timing, BAR_WIDTH);
  const bar =
    theme.fg("accent", "█".repeat(command)) + theme.fg("warning", "░".repeat(filter));
  const legend =
    `${theme.fg("accent", `cmd ${formatDuration(timing.commandMs)}`)} ` +
    `${theme.fg("dim", "·")} ` +
    `${theme.fg("warning", `filter ${formatDuration(timing.extractorMs)}`)}`;
  return (
    `${theme.fg("dim", "Took")} ${theme.fg("text", formatDuration(timing.totalMs))}` +
    `  ${bar}  ${legend}`
  );
}

/** Full guard receipt block, appended to the bash tool result. */
export function renderGuardReceipt(
  theme: Theme,
  guard: PiToolGuardDetails,
  timing: PiToolGuardTiming,
): Component {
  const container = new Container();
  container.addChild(new Text(guardTitle(theme, guard.removedPipeline), 0, 0));

  if (guard.projection) {
    const savings = formatProjectionSavings(guard.projection);
    container.addChild(new Text(`   ${theme.fg("success", `Context saved · ${savings}`)}`, 0, 0));
  }

  container.addChild(new Text(`   ${renderTimingLine(theme, timing)}`, 0, 0));
  return container;
}

/**
 * Flash a guard status in the footer, next to git/model badges, and clear it
 * after a few seconds. Mirrors SoL-Pi's transient savings status.
 */
export function showGuardStatus(ctx: ExtensionContext, text: string): void {
  if (ctx.mode !== "tui") return;
  ctx.ui.setStatus(STATUS_KEY, text);

  const previous = statusTimers.get(ctx.ui);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    if (statusTimers.get(ctx.ui) !== timer) return;
    statusTimers.delete(ctx.ui);
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }, STATUS_DURATION_MS);
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  statusTimers.set(ctx.ui, timer);
}
