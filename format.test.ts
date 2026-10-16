import { describe, it, expect } from "vitest";

import type { PiToolGuardProjection } from "./contract.ts";
import {
  capModelOutput,
  formatBytes,
  formatCount,
  formatProjectionSavings,
  measureText,
} from "./format.ts";
import { extractFullOutputPath } from "./pipeline.ts";

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

describe("capModelOutput", () => {
  it("leaves text within pi's limits untouched", () => {
    expect(capModelOutput("a\nb")).toEqual({ text: "a\nb", banner: "", capped: false });
  });

  it("caps a single ultra-long line and banners the full-output path", () => {
    // The production regression: `head -60` over 30 matches of a minified
    // HTML file — every line kept, megabytes returned.
    const giant = "x".repeat(200_000);
    const { text, banner, capped } = capModelOutput(giant, "/tmp/pi-bash-x.log");
    expect(capped).toBe(true);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
    expect(banner).toContain("[Showing last ");
    expect(banner).toContain("(line is ");
    expect(banner).toContain("Full output: /tmp/pi-bash-x.log]");
  });

  it("caps a many-line text at pi's 2000-line limit with the line banner", () => {
    const many = Array.from({ length: 2_500 }, (_, i) => `line ${i}`).join("\n");
    const { text, banner, capped } = capModelOutput(many, "/tmp/log");
    expect(capped).toBe(true);
    expect(text.split("\n")).toHaveLength(2_000);
    expect(banner).toBe("\n\n[Showing lines 501-2500 of 2500. Full output: /tmp/log]");
  });

  it("caps without a banner when no path is given", () => {
    const giant = "x".repeat(200_000);
    const { text, banner, capped } = capModelOutput(giant);
    expect(capped).toBe(true);
    expect(banner).toBe("");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024);
  });

  it("keeps the pointer reachable via extractFullOutputPath", () => {
    const giant = "x".repeat(200_000);
    const { text, banner } = capModelOutput(giant, "/tmp/pi-bash-x.log");
    expect(extractFullOutputPath(`${text}${banner}`)).toBe("/tmp/pi-bash-x.log");
  });
});
