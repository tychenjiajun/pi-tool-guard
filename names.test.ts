import { describe, it, expect } from "vitest";
import { editDistance, repairToolCallNames, repairToolName } from "./names.ts";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const CODING_TOOLS = ["bash", "edit", "read", "write", "codemode", "tool_search"];

const assistantMessage = (...content: unknown[]): Record<string, unknown> => ({
  role: "assistant",
  api: "openai-completions",
  provider: "test",
  model: "test-model",
  usage: { input: 0, output: 0 },
  stopReason: "toolUse",
  timestamp: 0,
  content,
});

const text = (value: string) => ({ type: "text", text: value });

const toolCall = (name: string, arguments_: unknown = {}) => ({
  type: "toolCall",
  id: `call_${name}`,
  name,
  arguments: arguments_,
});

// ---------------------------------------------------------------------------
// editDistance
// ---------------------------------------------------------------------------

describe("editDistance", () => {
  it("is 0 for identical strings", () => {
    expect(editDistance("codemode", "codemode")).toBe(0);
  });

  it("counts a substitution", () => {
    expect(editDistance("reed", "read")).toBe(1);
  });

  it("counts an insertion and a deletion", () => {
    expect(editDistance("baash", "bash")).toBe(1);
    expect(editDistance("writ", "write")).toBe(1);
  });

  it("counts an adjacent transposition as one edit", () => {
    expect(editDistance("raed", "read")).toBe(1);
  });

  it("counts the repeated-syllable typo the guard was built for", () => {
    expect(editDistance("codememode", "codemode")).toBe(2);
  });

  it("is symmetric", () => {
    expect(editDistance("codememode", "codemode")).toBe(editDistance("codemode", "codememode"));
  });

  it("abandons the computation above the budget", () => {
    expect(editDistance("frobnicate", "bash", 2)).toBeGreaterThan(2);
    expect(editDistance("bash", "frobnicate", 2)).toBeGreaterThan(2);
  });
});

// ---------------------------------------------------------------------------
// repairToolName
// ---------------------------------------------------------------------------

describe("repairToolName", () => {
  describe("declared names are left alone", () => {
    it("returns undefined for an exact match", () => {
      expect(repairToolName("read", CODING_TOOLS)).toBeUndefined();
    });

    it("returns undefined for every declared tool", () => {
      for (const name of CODING_TOOLS) {
        expect(repairToolName(name, CODING_TOOLS)).toBeUndefined();
      }
    });
  });

  describe("case-only differences", () => {
    it("repairs Read → read", () => {
      expect(repairToolName("Read", CODING_TOOLS)).toEqual({
        from: "Read",
        to: "read",
        kind: "case",
        distance: 0,
      });
    });

    it("repairs a fully upper-cased name", () => {
      expect(repairToolName("CODEMODE", CODING_TOOLS)).toMatchObject({
        to: "codemode",
        kind: "case",
      });
    });
  });

  describe("the observed typo", () => {
    it("repairs codememode → codemode as a distance-2 repair", () => {
      expect(repairToolName("codememode", CODING_TOOLS)).toEqual({
        from: "codememode",
        to: "codemode",
        kind: "distance",
        distance: 2,
      });
    });

    it("repairs a case-mangled variant of it too", () => {
      expect(repairToolName("CodeMemode", CODING_TOOLS)).toMatchObject({
        to: "codemode",
        kind: "distance",
      });
    });

    it("still refuses it when the target is not declared", () => {
      expect(repairToolName("codememode", ["read"])).toBeUndefined();
    });
  });

  describe("edit distance", () => {
    it("repairs a one-edit typo of a short name", () => {
      expect(repairToolName("reed", CODING_TOOLS)).toEqual({
        from: "reed",
        to: "read",
        kind: "distance",
        distance: 1,
      });
    });

    it("repairs a transposed pair", () => {
      expect(repairToolName("raed", CODING_TOOLS)).toMatchObject({ to: "read", distance: 1 });
    });

    it("repairs a doubled keypress", () => {
      expect(repairToolName("baash", CODING_TOOLS)).toMatchObject({ to: "bash", distance: 1 });
    });

    it("repairs a dropped trailing letter", () => {
      expect(repairToolName("writ", CODING_TOOLS)).toMatchObject({ to: "write", distance: 1 });
    });

    it("repairs the repeated-syllable typo", () => {
      expect(repairToolName("codememode", ["codemode"])).toEqual({
        from: "codememode",
        to: "codemode",
        kind: "distance",
        distance: 2,
      });
    });

    it("refuses two edits on a short name", () => {
      expect(repairToolName("axyd", ["abcd"])).toBeUndefined();
    });

    it("allows two edits on a long name when both ends are unchanged", () => {
      expect(repairToolName("abcdeXYh", ["abcdefgh"])).toMatchObject({
        to: "abcdefgh",
        distance: 2,
      });
    });

    it("refuses two edits that move either end", () => {
      expect(repairToolName("odemodec", ["codemode"])).toBeUndefined();
    });

    it("refuses a name that is too far from every declared tool", () => {
      expect(repairToolName("frobnicate", CODING_TOOLS)).toBeUndefined();
    });

    it("refuses when the closest name is ambiguous", () => {
      expect(repairToolName("abcx", ["abcd", "abce"])).toBeUndefined();
    });

    it("never targets a name shorter than four characters", () => {
      expect(repairToolName("lss", ["ls"])).toBeUndefined();
    });
  });

  describe("MCP families", () => {
    const declared = ["mcp__jira__create_issue", "read"];

    it("repairs a typo inside the same family", () => {
      expect(repairToolName("mcp__jira__create_issues", declared)).toMatchObject({
        to: "mcp__jira__create_issue",
        distance: 1,
      });
    });

    it("repairs a typo in the tool segment of a long name", () => {
      expect(repairToolName("mcp__jira__create_isue", declared)).toMatchObject({
        to: "mcp__jira__create_issue",
        distance: 1,
      });
    });

    it("refuses to cross into a different server", () => {
      expect(repairToolName("mcp__jria__create_issue", declared)).toBeUndefined();
    });

    it("refuses to add or drop a namespace", () => {
      expect(repairToolName("jira__create_issue", declared)).toBeUndefined();
      expect(repairToolName("create_issue", declared)).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// repairToolCallNames
// ---------------------------------------------------------------------------

describe("repairToolCallNames", () => {
  it("renames the misspelled call and keeps its arguments", () => {
    const args = { code: "const x = 1;" };
    const message = assistantMessage(text("reading"), toolCall("codememode", args));

    const { message: repaired, repairs } = repairToolCallNames(message, CODING_TOOLS);

    expect(repairs).toEqual([
      { from: "codememode", to: "codemode", kind: "distance", distance: 2 },
    ]);
    const content = repaired.content as Array<Record<string, unknown>>;
    // Only `name` is rewritten: the call id, the arguments, and every other
    // part stay exactly as the model wrote them.
    expect(content[1]).toEqual({ ...toolCall("codememode", args), name: "codemode" });
    expect(content[0]).toEqual(text("reading"));
  });

  it("does not mutate the message it was given", () => {
    const message = assistantMessage(toolCall("codememode", { code: "1" }));
    const snapshot = structuredClone(message);

    repairToolCallNames(message, CODING_TOOLS);

    expect(message).toEqual(snapshot);
  });

  it("returns the input message untouched when nothing needs a repair", () => {
    const message = assistantMessage(toolCall("read", { path: "a" }));

    const { message: repaired, repairs } = repairToolCallNames(message, CODING_TOOLS);

    expect(repairs).toEqual([]);
    expect(repaired).toBe(message);
  });

  it("reuses the untouched parts by identity", () => {
    const fine = toolCall("read", { path: "a" });
    const message = assistantMessage(toolCall("reed", { path: "b" }), fine);

    const content = repairToolCallNames(message, CODING_TOOLS).message.content as unknown[];

    expect(content[1]).toBe(fine);
  });

  it("repairs every misspelled call in one message", () => {
    const message = assistantMessage(
      toolCall("codememode", { code: "1" }),
      toolCall("reed", { path: "a" }),
      toolCall("bash", { command: "ls" }),
    );

    const { message: repaired, repairs } = repairToolCallNames(message, CODING_TOOLS);

    expect(repairs.map((repair) => repair.to)).toEqual(["codemode", "read"]);
    expect((repaired.content as Array<{ name: string }>).map((part) => part.name)).toEqual([
      "codemode",
      "read",
      "bash",
    ]);
  });

  it("ignores non-assistant messages", () => {
    for (const role of ["user", "toolResult", "custom"]) {
      const message = { role, content: [toolCall("codememode", { code: "1" })] };
      const result = repairToolCallNames(message, CODING_TOOLS);
      expect(result.repairs).toEqual([]);
      expect(result.message).toBe(message);
    }
  });

  it("ignores content that is not an array", () => {
    const message = { role: "assistant", content: "plain string" };
    const result = repairToolCallNames(message, CODING_TOOLS);
    expect(result.repairs).toEqual([]);
    expect(result.message).toBe(message);
  });

  it("ignores parts that are not tool calls", () => {
    const message = assistantMessage(
      text("hi"),
      { type: "thinking", thinking: "hmm" },
      { type: "toolCall", name: 42 },
      { type: "toolCall" },
    );

    const result = repairToolCallNames(message, CODING_TOOLS);

    expect(result.repairs).toEqual([]);
    expect(result.message).toBe(message);
  });

  it("keeps a tool call with no arguments intact", () => {
    const message = assistantMessage({ type: "toolCall", id: "call_1", name: "codememode" });

    const content = repairToolCallNames(message, CODING_TOOLS).message.content as Array<
      Record<string, unknown>
    >;

    expect(content[0]).toEqual({ type: "toolCall", id: "call_1", name: "codemode" });
  });
});