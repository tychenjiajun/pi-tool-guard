import { describe, it, expect } from "vitest";

import type { PiToolGuardProjection } from "./contract.ts";
import {
  formatBytes,
  formatCount,
  formatProjectionSavings,
  measureText,
} from "./format.ts";

describe("measureText", () => {
  it("counts logical lines, ignoring a single trailing newline", () => {
    expect(measureText("a\nb\nc")).toEqual({ lines: 3, bytes: 5 });
    expect(measureText("a\nb\nc\n").lines).toBe(3);
    expect(measureText("").lines).toBe(0);
  });

  it("counts UTF-8 bytes, not code units", () => {
    expect(measureText("é").bytes).toBe(2);
  });
});

describe("formatCount", () => {
  it("groups thousands", () => {
    expect(formatCount(1234)).toBe("1,234");
  });

  it("clamps invalid values", () => {
    expect(formatCount(-5)).toBe("0");
    expect(formatCount(Number.NaN)).toBe("0");
  });
});

describe("formatBytes", () => {
  it("scales through KiB and MiB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KiB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MiB");
  });
});

describe("formatProjectionSavings", () => {
  const projection: PiToolGuardProjection = {
    inputLines: 1_234,
    inputBytes: 20_480,
    outputLines: 20,
    outputBytes: 1_024,
  };

  it("summarizes the reduction", () => {
    const text = formatProjectionSavings(projection);
    expect(text).toContain("1,234 → 20 lines");
    expect(text).toContain("98% smaller");
    expect(text).toContain("19 KiB saved");
  });

  it("omits zero reductions instead of printing misleading stats", () => {
    const unchanged: PiToolGuardProjection = {
      inputLines: 5,
      inputBytes: 100,
      outputLines: 5,
      outputBytes: 100,
    };
    expect(formatProjectionSavings(unchanged)).toBe("5 → 5 lines");
  });
});
