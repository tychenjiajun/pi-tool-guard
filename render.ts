import type { Theme } from "@earendil-works/pi-coding-agent";

import type { PiToolGuardDetails, PiToolGuardTiming } from "./contract.ts";
import { renderGuardReceipt } from "./tui.ts";

// ---------------------------------------------------------------------------
// Guarded bash result rendering
// ---------------------------------------------------------------------------
//
// Pi's built-in bash renderer appends a single opaque `Took <total>` line as
// the last child of its result component. When the guard projected the output
// that total silently includes the extra extractor run, so we drop that line
// and draw the guard receipt in its place.

/** Structural view of a pi-tui Container, kept loose so tests can fake it. */
export interface ChildContainer {
  children?: unknown[];
  removeChild?: (child: unknown) => void;
  addChild?: (child: unknown) => void;
}

/**
 * Whether a result should get the guard receipt at all. Fast commands stay
 * visually identical to the built-in bash tool, and a no-op projection changed
 * nothing to illustrate, so both are skipped.
 */
export function shouldRenderGuardReceipt(guard: PiToolGuardDetails | undefined): boolean {
  if (!guard || guard.slow !== true || guard.noop === true) return false;
  return (guard.timing?.extractorMs ?? 0) > 0;
}

/**
 * Replace the trailing `Took` line with the guard receipt.
 *
 * `hasBuiltInTookLine` must be true only when pi's renderer actually appended
 * its own line, otherwise the last child would be output or a truncation
 * warning and removing it would hide real content.
 */
export function applyGuardReceipt(
  component: ChildContainer,
  theme: Theme,
  guard: PiToolGuardDetails,
  timing: PiToolGuardTiming,
  hasBuiltInTookLine: boolean,
): ChildContainer {
  if (hasBuiltInTookLine && Array.isArray(component.children)) {
    const last = component.children[component.children.length - 1];
    if (last !== undefined) component.removeChild?.(last);
  }
  component.addChild?.(renderGuardReceipt(theme, guard, timing));
  return component;
}
