import { describe, it, expect } from "vitest";
import { applySimpleView } from "./view.ts";

describe("applySimpleView", () => {
  describe("head", () => {
    it("defaults to 10 lines", () => {
      const text = Array.from({ length: 15 }, (_, i) => `l${i + 1}`).join("\n");
      expect(applySimpleView(text, "head")).toBe(
        Array.from({ length: 10 }, (_, i) => `l${i + 1}`).join("\n") + "\n",
      );
    });

    it("takes the first N lines with `-N`", () => {
      expect(applySimpleView("a\nb\nc\n", "head -2")).toBe("a\nb\n");
    });

    it("takes the first N lines with `-n N`", () => {
      expect(applySimpleView("a\nb\nc\n", "head -n 2")).toBe("a\nb\n");
    });

    it("takes the first N lines with `-nN`", () => {
      expect(applySimpleView("a\nb\nc\n", "head -n2")).toBe("a\nb\n");
    });

    it("counts a trailing partial line", () => {
      expect(applySimpleView("a\nb", "head -2")).toBe("a\nb");
    });

    it("returns the whole text when there are fewer lines than N", () => {
      expect(applySimpleView("a\nb\n", "head -5")).toBe("a\nb\n");
    });

    it("returns empty for N=0", () => {
      expect(applySimpleView("a\nb\n", "head -0")).toBe("");
    });
  });

  describe("tail", () => {
    it("takes the last N lines and keeps the trailing newline", () => {
      expect(applySimpleView("a\nb\nc\n", "tail -2")).toBe("b\nc\n");
    });

    it("counts a trailing partial line", () => {
      expect(applySimpleView("a\nb\nc", "tail -2")).toBe("b\nc");
    });

    it("returns the whole text when there are fewer lines than N", () => {
      expect(applySimpleView("a\nb\n", "tail -5")).toBe("a\nb\n");
    });

    it("treats a single trailing newline as a terminator, not an empty line", () => {
      expect(applySimpleView("a\nb\n", "tail -1")).toBe("b\n");
    });
  });

  describe("bytes", () => {
    it("head -c takes the first N bytes", () => {
      expect(applySimpleView("hello world", "head -c5")).toBe("hello");
    });

    it("tail -c takes the last N bytes", () => {
      expect(applySimpleView("hello world", "tail -c 5")).toBe("world");
    });
  });

  describe("refusals (fall back to pi.exec)", () => {
    it("returns undefined for a non-head/tail pipeline", () => {
      expect(applySimpleView("text", "grep x")).toBeUndefined();
    });

    it("returns undefined for a multi-command pipeline", () => {
      expect(applySimpleView("text", "grep x | head -5")).toBeUndefined();
    });

    it("returns undefined for a follow", () => {
      expect(applySimpleView("text", "tail -f")).toBeUndefined();
    });

    it("returns undefined for `+N` / other flags", () => {
      expect(applySimpleView("text", "tail -n +2")).toBeUndefined();
      expect(applySimpleView("text", "head -q")).toBeUndefined();
      expect(applySimpleView("text", "head --lines=2")).toBeUndefined();
    });
  });
});