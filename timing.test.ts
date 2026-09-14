import { describe, it, expect } from "vitest";

import type { PiToolGuardTiming } from "./contract.ts";
import { buildTimingBar, formatDuration, timingBarSplit } from "./timing.ts";

const timing: PiToolGuardTiming = { commandMs: 5_000, extractorMs: 1_500, totalMs: 6_500 };

describe("formatDuration", () => {
  it("renders sub-second values in milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(999.6)).toBe("1000ms");
  });

  it("renders second-scale values with one decimal", () => {
    expect(formatDuration(1_000)).toBe("1.0s");
    expect(formatDuration(6_500)).toBe("6.5s");
  });
});

describe("timingBarSplit", () => {
  it("splits the bar proportionally to each phase", () => {
    // 5000/6500 of 20 cells ≈ 15 command cells, 5 filter cells.
    expect(timingBarSplit(timing, 20)).toEqual({ command: 15, filter: 5 });
  });

  it("keeps a filter cell even when the command dominates", () => {
    const skewed: PiToolGuardTiming = { commandMs: 9_999, extractorMs: 1, totalMs: 10_000 };
    expect(timingBarSplit(skewed, 5)).toEqual({ command: 4, filter: 1 });
  });

  it("gives the whole bar to the command when the filter cost nothing", () => {
    const commandOnly: PiToolGuardTiming = { commandMs: 4_000, extractorMs: 0, totalMs: 4_000 };
    expect(timingBarSplit(commandOnly, 6)).toEqual({ command: 6, filter: 0 });
  });
});

describe("buildTimingBar", () => {
  it("renders a plain block-character bar", () => {
    expect(buildTimingBar(timing, 20)).toBe("█".repeat(15) + "░".repeat(5));
  });

  it("defaults to the shared bar width", () => {
    expect(buildTimingBar(timing)).toHaveLength(18);
  });
});
