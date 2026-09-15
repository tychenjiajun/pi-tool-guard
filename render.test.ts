import { describe, it, expect } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";

import type { PiToolGuardDetails, PiToolGuardTiming } from "./contract.ts";
import { applyGuardReceipt, shouldRenderGuardReceipt, type ChildContainer } from "./render.ts";

const timing: PiToolGuardTiming = { commandMs: 5_000, extractorMs: 1_500, totalMs: 6_500 };

const guard: PiToolGuardDetails = {
  version: 1,
  originalCommand: "ls | tail -20",
  cleanedCommand: "ls",
  removed: ["tail"],
  removedPipeline: "tail -20",
  outcome: "projection-applied",
  timing,
  projection: { inputLines: 1_234, inputBytes: 20_000, outputLines: 20, outputBytes: 400 },
};

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `*${text}*`,
} as unknown as Theme;

function fakeContainer(children: unknown[]): ChildContainer & { children: unknown[] } {
  return {
    children,
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
    },
    addChild(child) {
      this.children.push(child);
    },
  };
}

describe("applyGuardReceipt", () => {
  it("replaces the built-in Took line with the guard receipt", () => {
    const builtInTook = { render: () => ["Took 9.9s"], invalidate: () => {} };
    const container = fakeContainer([
      { render: () => ["output"], invalidate: () => {} },
      builtInTook,
    ]);

    applyGuardReceipt(container, theme, guard, timing, true);

    expect(container.children).not.toContain(builtInTook);
    expect(container.children).toHaveLength(2);

    const receipt = container.children[1] as { render(width: number): string[] };
    const text = receipt.render(200).join("\n");
    expect(text).toContain("pi-tool-guard");
    expect(text).toContain("tail -20");
    expect(text).toContain("Context saved");
    expect(text).toContain("1,234");
    expect(text).toContain("Took");
    expect(text).toContain("cmd 5.0s");
    expect(text).toContain("filter 1.5s");
  });

  it("appends without removing when pi's renderer printed no Took line", () => {
    const container = fakeContainer([{ render: () => ["output"], invalidate: () => {} }]);

    applyGuardReceipt(container, theme, guard, timing, false);

    expect(container.children).toHaveLength(2);
  });

  it("omits the savings line when projection stats are unavailable", () => {
    const { projection: _projection, ...withoutProjection } = guard;
    const container = fakeContainer([{ render: () => ["output"], invalidate: () => {} }]);

    applyGuardReceipt(
      container,
      theme,
      withoutProjection as PiToolGuardDetails,
      timing,
      false,
    );

    const receipt = container.children[1] as { render(width: number): string[] };
    const text = receipt.render(200).join("\n");
    expect(text).not.toContain("Context saved");
    expect(text).toContain("Took");
  });
});

describe("shouldRenderGuardReceipt", () => {
  it("renders for a slow command whose extractor ran", () => {
    expect(shouldRenderGuardReceipt({ ...guard, slow: true })).toBe(true);
  });

  it("skips fast commands so the built-in bash UI is untouched", () => {
    expect(shouldRenderGuardReceipt({ ...guard, slow: false })).toBe(false);
    // `slow` unset (older/synthetic records) is treated as fast.
    expect(shouldRenderGuardReceipt({ ...guard })).toBe(false);
  });

  it("skips when no extractor ran", () => {
    expect(
      shouldRenderGuardReceipt({
        ...guard,
        slow: true,
        timing: { commandMs: 5_000, extractorMs: 0, totalMs: 5_000 },
      }),
    ).toBe(false);
  });

  it("skips no-op projections", () => {
    expect(shouldRenderGuardReceipt({ ...guard, slow: true, noop: true })).toBe(false);
  });

  it("skips missing details", () => {
    expect(shouldRenderGuardReceipt(undefined)).toBe(false);
  });
});
