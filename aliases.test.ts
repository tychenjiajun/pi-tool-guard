import { describe, it, expect } from "vitest";
import { normalizeEditArgs, normalizeWriteArgs, normalizeReadArgs } from "./aliases.ts";

// ---------------------------------------------------------------------------
// normalizeEditArgs
// ---------------------------------------------------------------------------

describe("normalizeEditArgs", () => {
  // ── Alias renaming ───────────────────────────────────────────────────

  describe("alias renaming", () => {
    it("renames file → path", () => {
      const args = { file: "foo.ts", edits: [{ oldText: "a", newText: "b" }] };
      normalizeEditArgs(args);
      expect(args).toEqual({ path: "foo.ts", edits: [{ oldText: "a", newText: "b" }] });
    });

    it("renames filePath → path", () => {
      const args = { filePath: "foo.ts", edits: [{ oldText: "a", newText: "b" }] };
      normalizeEditArgs(args);
      expect(args).toHaveProperty("path", "foo.ts");
    });

    it("renames old_str → oldText inside edits", () => {
      const args = { path: "f", edits: [{ old_str: "a", new_str: "b" }] };
      normalizeEditArgs(args);
      expect(args.edits[0]).toEqual({ oldText: "a", newText: "b" });
    });

    it("renames old_string → oldText", () => {
      const args = { path: "f", edits: [{ old_string: "a", new_string: "b" }] };
      normalizeEditArgs(args);
      expect(args.edits[0]).toEqual({ oldText: "a", newText: "b" });
    });

    it("renames search → oldText, replace → newText", () => {
      const args = { path: "f", edits: [{ search: "a", replace: "b" }] };
      normalizeEditArgs(args);
      expect(args.edits[0]).toEqual({ oldText: "a", newText: "b" });
    });

    it("renames old → oldText, new → newText", () => {
      const args = { path: "f", edits: [{ old: "a", new: "b" }] };
      normalizeEditArgs(args);
      expect(args.edits[0]).toEqual({ oldText: "a", newText: "b" });
    });
  });

  // ── Pattern A: top-level oldText/newText → wrap into edits ───────────

  describe("Pattern A: top-level wrap", () => {
    it("wraps oldText/newText into edits", () => {
      const args = { path: "f", oldText: "a", newText: "b" } as Record<string, unknown>;
      normalizeEditArgs(args);
      expect(args.edits).toEqual([{ oldText: "a", newText: "b" }]);
      expect(args.oldText).toBeUndefined();
      expect(args.newText).toBeUndefined();
    });

    it("wraps old_str/new_str aliases at top level", () => {
      const args = { path: "f", old_str: "a", new_str: "b" } as Record<string, unknown>;
      normalizeEditArgs(args);
      expect(args.edits).toEqual([{ oldText: "a", newText: "b" }]);
    });

    it("does NOT wrap if edits already exists", () => {
      const args = { path: "f", edits: [{ oldText: "x", newText: "y" }], oldText: "a", newText: "b" } as Record<string, unknown>;
      normalizeEditArgs(args);
      // edits should keep the existing array, oldText/newText left as-is
      expect(args.edits).toEqual([{ oldText: "x", newText: "y" }]);
    });
  });

  // ── Pattern B: alias keys at top level → wrap ────────────────────────

  describe("Pattern B: alias keys at top level", () => {
    it("wraps search/replace at top level", () => {
      const args = { path: "f", search: "a", replace: "b" } as Record<string, unknown>;
      normalizeEditArgs(args);
      expect(args.edits).toEqual([{ oldText: "a", newText: "b" }]);
    });

    it("wraps old/new at top level", () => {
      const args = { path: "f", old: "a", new: "b" } as Record<string, unknown>;
      normalizeEditArgs(args);
      expect(args.edits).toEqual([{ oldText: "a", newText: "b" }]);
    });
  });

  // ── Pattern C: edits as JSON string ──────────────────────────────────

  describe("Pattern C: JSON string edits", () => {
    it("parses JSON string edits", () => {
      const args = { path: "f", edits: '[{"oldText":"a","newText":"b"}]' } as Record<string, unknown>;
      normalizeEditArgs(args);
      expect(args.edits).toEqual([{ oldText: "a", newText: "b" }]);
    });

    it("ignores invalid JSON", () => {
      const args = { path: "f", edits: "not-json" } as Record<string, unknown>;
      normalizeEditArgs(args);
      expect(args.edits).toBe("not-json"); // unchanged
    });
  });

  // ── No-op cases ──────────────────────────────────────────────────────

  describe("no-op", () => {
    it("already correct args pass through", () => {
      const args = { path: "f.ts", edits: [{ oldText: "a", newText: "b" }] };
      normalizeEditArgs(args);
      expect(args).toEqual({ path: "f.ts", edits: [{ oldText: "a", newText: "b" }] });
    });
  });
});

// ---------------------------------------------------------------------------
// normalizeWriteArgs
// ---------------------------------------------------------------------------

describe("normalizeWriteArgs", () => {
  it("renames file → path", () => {
    const args = { file: "foo.ts", content: "hello" };
    normalizeWriteArgs(args);
    expect(args).toEqual({ path: "foo.ts", content: "hello" });
  });

  it("renames text → content", () => {
    const args = { path: "f", text: "hello" };
    normalizeWriteArgs(args);
    expect(args).toEqual({ path: "f", content: "hello" });
  });

  it("renames body → content", () => {
    const args = { path: "f", body: "hello" };
    normalizeWriteArgs(args);
    expect(args).toEqual({ path: "f", content: "hello" });
  });

  it("renames code → content", () => {
    const args = { path: "f", code: "console.log(1)" };
    normalizeWriteArgs(args);
    expect(args).toEqual({ path: "f", content: "console.log(1)" });
  });

  it("already correct args pass through", () => {
    const args = { path: "f.ts", content: "hello" };
    normalizeWriteArgs(args);
    expect(args).toEqual({ path: "f.ts", content: "hello" });
  });
});

// ---------------------------------------------------------------------------
// normalizeReadArgs
// ---------------------------------------------------------------------------

describe("normalizeReadArgs", () => {
  it("renames file → path", () => {
    const args = { file: "foo.ts" };
    normalizeReadArgs(args);
    expect(args).toEqual({ path: "foo.ts" });
  });

  it("renames start → offset", () => {
    const args = { path: "f", start: 10 };
    normalizeReadArgs(args);
    expect(args).toEqual({ path: "f", offset: 10 });
  });

  it("renames lines → limit", () => {
    const args = { path: "f", lines: 50 };
    normalizeReadArgs(args);
    expect(args).toEqual({ path: "f", limit: 50 });
  });

  it("coerces string offset to number", () => {
    const args = { path: "f", offset: "10" };
    normalizeReadArgs(args);
    expect(args).toEqual({ path: "f", offset: 10 });
  });

  it("coerces string limit to number", () => {
    const args = { path: "f", limit: "50" };
    normalizeReadArgs(args);
    expect(args).toEqual({ path: "f", limit: 50 });
  });

  it("does not coerce non-numeric string", () => {
    const args = { path: "f", offset: "abc" };
    normalizeReadArgs(args);
    expect(args).toEqual({ path: "f", offset: "abc" }); // unchanged
  });

  it("already correct args pass through", () => {
    const args = { path: "f.ts", offset: 1, limit: 100 };
    normalizeReadArgs(args);
    expect(args).toEqual({ path: "f.ts", offset: 1, limit: 100 });
  });
});
