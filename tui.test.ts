import { describe, it, expect, vi, afterEach } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { showGuardStatus } from "./tui.ts";

describe("showGuardStatus", () => {
  afterEach(() => vi.useRealTimers());

  it("sets then clears the footer status in TUI mode", () => {
    vi.useFakeTimers();
    const setStatus = vi.fn();
    const ctx = { mode: "tui", ui: { setStatus } } as unknown as ExtensionContext;

    showGuardStatus(ctx, "🛡 tail -20 · 98% smaller");
    expect(setStatus).toHaveBeenCalledWith("pi-tool-guard", "🛡 tail -20 · 98% smaller");

    vi.advanceTimersByTime(4_000);
    expect(setStatus).toHaveBeenLastCalledWith("pi-tool-guard", undefined);
  });

  it("does nothing outside TUI mode", () => {
    const setStatus = vi.fn();
    const ctx = { mode: "json", ui: { setStatus } } as unknown as ExtensionContext;

    showGuardStatus(ctx, "x");
    expect(setStatus).not.toHaveBeenCalled();
  });
});
