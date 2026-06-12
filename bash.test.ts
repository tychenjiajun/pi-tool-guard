import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildNotice, FAST_THRESHOLD_MS, runExtractorOnText, runExtractorOnFile } from "./bash.ts";
import { stripTrailingExtractors } from "./pipeline.ts";
import { executeBashGuarded, prepareBashArguments, type ExecuteContext, type ToolResult } from "./execute.ts";

describe("buildNotice", () => {
  it("returns fast-mode notice when mode is 'fast'", () => {
    const notice = buildNotice(["head"], "fast");
    expect(notice).toContain("Filtered via");
    expect(notice).toContain("small enough to pipe");
    expect(notice).not.toContain("do NOT re-run");
  });

  it("returns slow-mode notice when mode is 'slow'", () => {
    const notice = buildNotice(["head"], "slow");
    expect(notice).toContain("The full output is above");
    expect(notice).toContain("do NOT re-run");
  });

  it("defaults to slow mode when no mode provided", () => {
    const notice = buildNotice(["head"]);
    expect(notice).toContain("The full output is above");
    expect(notice).toContain("do NOT re-run");
  });

  it("lists multiple removed commands", () => {
    const notice = buildNotice(["grep", "head"], "fast");
    expect(notice).toContain("`grep`, `head`");
  });
});

describe("FAST_THRESHOLD_MS", () => {
  it("is 10 seconds", () => {
    expect(FAST_THRESHOLD_MS).toBe(10_000);
  });
});

describe("fast command behavior", () => {
  let mockPi: ExtensionAPI;

  beforeEach(() => {
    mockPi = {
      exec: vi.fn(),
    } as unknown as ExtensionAPI;
  });

  it("runExtractorOnText pipes text through extractor pipeline", async () => {
    const text = "line1\nline2\nline3";
    const pipeline = "head -2";
    
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "line1\nline2",
    });

    const result = await runExtractorOnText(mockPi, text, pipeline);
    expect(result).toBe("line1\nline2");
    expect(mockPi.exec).toHaveBeenCalledWith("bash", [
      "-c",
      expect.stringContaining("head -2"),
    ]);
  });

  it("runExtractorOnFile pipes file content through extractor pipeline", async () => {
    const filePath = "/tmp/output.txt";
    const pipeline = "tail -1";
    
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "last line",
    });

    const result = await runExtractorOnFile(mockPi, filePath, pipeline);
    expect(result).toBe("last line");
    expect(mockPi.exec).toHaveBeenCalledWith("bash", [
      "-c",
      expect.stringContaining("tail -1"),
    ]);
  });

  it("runExtractorOnText returns undefined on failure", async () => {
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 1,
      stdout: "",
    });

    const result = await runExtractorOnText(mockPi, "text", "head -1");
    expect(result).toBeUndefined();
  });

  it("runExtractorOnFile returns undefined on failure", async () => {
    (mockPi.exec as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));

    const result = await runExtractorOnFile(mockPi, "/tmp/file.txt", "head -1");
    expect(result).toBeUndefined();
  });
});

describe("stripTrailingExtractors integration", () => {
  it("strips head from ls | head", () => {
    const result = stripTrailingExtractors("ls -la | head -5");
    expect(result).toBeDefined();
    expect(result!.cleaned).toBe("ls -la");
    expect(result!.removedNames).toEqual(["head"]);
    expect(result!.removedPipeline).toBe("head -5");
  });

  it("strips tail from npm test | tail -20", () => {
    const result = stripTrailingExtractors("npm test 2>&1 | tail -20");
    expect(result).toBeDefined();
    expect(result!.cleaned).toBe("npm test 2>&1");
    expect(result!.removedNames).toEqual(["tail"]);
  });

  it("strips multiple extractors from grep FAIL | head -5", () => {
    const result = stripTrailingExtractors("npm test | grep FAIL | head -5");
    expect(result).toBeDefined();
    expect(result!.removedNames).toEqual(["grep", "head"]);
  });

  it("returns undefined for commands without extractors", () => {
    const result = stripTrailingExtractors("ls -la");
    expect(result).toBeUndefined();
  });
});

describe("executeBashGuarded", () => {
  let mockPi: ExtensionAPI;
  let mockCtx: { ui: { notify: ReturnType<typeof vi.fn> } };
  let mockOriginalExecute: ReturnType<typeof vi.fn>;
  let ctx: ExecuteContext;

  beforeEach(() => {
    mockPi = {
      exec: vi.fn(),
    } as unknown as ExtensionAPI;
    mockCtx = {
      ui: { notify: vi.fn() },
    };
    mockOriginalExecute = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "" }],
      details: undefined,
    });
    ctx = {
      pi: mockPi,
      ctx: mockCtx as unknown as ExecuteContext["ctx"],
      originalExecute: mockOriginalExecute as unknown as ExecuteContext["originalExecute"],
    };
  });

  it("runs original execute when no extractors removed", async () => {
    const expected: ToolResult = {
      content: [{ type: "text", text: "output" }],
      details: undefined,
    };
    mockOriginalExecute.mockResolvedValue(expected);

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      { command: "ls -la" },
      new AbortController().signal,
      () => {},
      {},
    );

    expect(result).toBe(expected);
    expect(mockOriginalExecute).toHaveBeenCalledOnce();
  });

  it("fast command: pipes result through extractor and returns filtered output", async () => {
    // Simulate fast command (< 10s)
    const originalResult: ToolResult = {
      content: [{ type: "text", text: "line1\nline2\nline3" }],
      details: undefined,
    };
    mockOriginalExecute.mockImplementation(async () => {
      // Simulate fast execution
      return originalResult;
    });

    // Mock pi.exec to simulate head -2
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "line1\nline2",
    });

    const params = { command: "ls -la" };
    // prepareBashArguments would have set these
    const prepared = prepareBashArguments({ command: "ls -la | head -2" });

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      prepared,
      new AbortController().signal,
      () => {},
      {},
    );

    // Should return filtered output (head -2)
    const textContent = result.content[0];
    if (textContent.type === "text") {
      expect(textContent.text).toBe("line1\nline2");
    }
    // Should notify UI
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Filtered via"),
      "info",
    );
    // Should NOT append notice to LLM response for fast commands
    expect(result.content).toHaveLength(1);
  });

  it("fast command: produces same output as original bash with extractor", async () => {
    // This is the key test: ensure guarded execution == original execution
    const originalOutput = "file1.txt\nfile2.txt\nfile3.txt";
    const headOutput = "file1.txt\nfile2.txt";

    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: originalOutput }],
      details: undefined,
    });

    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: headOutput,
    });

    const prepared = prepareBashArguments({ command: "ls | head -2" });

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      prepared,
      new AbortController().signal,
      () => {},
      {},
    );

    // The filtered output should match what head -2 would produce
    const textContent = result.content[0];
    if (textContent.type === "text") {
      expect(textContent.text).toBe(headOutput);
    }
    // Should notify UI
    expect(mockCtx.ui.notify).toHaveBeenCalled();
    // Should NOT append notice to LLM response for fast commands
    expect(result.content).toHaveLength(1);
  });

  it("slow command: returns full output with LLM notice", async () => {
    // Use fake timers to simulate slow command
    vi.useFakeTimers();

    mockOriginalExecute.mockImplementation(async () => {
      // Advance time past the threshold
      vi.advanceTimersByTime(FAST_THRESHOLD_MS + 100);
      return {
        content: [{ type: "text", text: "full output" }],
        details: undefined,
      };
    });

    const prepared = prepareBashArguments({ command: "npm test | tail -5" });

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      prepared,
      new AbortController().signal,
      () => {},
      {},
    );

    // Should return full output with LLM notice
    const textContent = result.content[0];
    const llmNotice = result.content[1];
    if (textContent.type === "text" && llmNotice.type === "text") {
      expect(textContent.text).toBe("full output");
      expect(llmNotice.text).toContain("slow command");
      expect(llmNotice.text).toContain("Avoid re-running");
    }
    // Should notify UI
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("The full output is above"),
      "info",
    );

    vi.useRealTimers();
  });

  it("slow command + truncated: returns truncated output with LLM notice, no extractor run", async () => {
    // Use fake timers to simulate slow command
    vi.useFakeTimers();

    mockOriginalExecute.mockImplementation(async () => {
      vi.advanceTimersByTime(FAST_THRESHOLD_MS + 100);
      return {
        content: [{ type: "text", text: "truncated output..." }],
        details: { fullOutputPath: "/tmp/full-output.txt" },
      };
    });

    const prepared = prepareBashArguments({ command: "npm test | tail -5" });

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      prepared,
      new AbortController().signal,
      () => {},
      {},
    );

    // Should NOT run extractor on file for slow commands
    expect(mockPi.exec).not.toHaveBeenCalled();
    // Should return truncated result as-is with LLM notice
    const textContent = result.content[0];
    const llmNotice = result.content[1];
    if (textContent.type === "text" && llmNotice.type === "text") {
      expect(textContent.text).toBe("truncated output...");
      expect(llmNotice.text).toContain("slow command");
      expect(llmNotice.text).toContain("Avoid re-running");
    }
    // Should notify UI
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("The full output is above"),
      "info",
    );

    vi.useRealTimers();
  });

  it("truncated output: fast command runs extractor on full output file", async () => {
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "truncated..." }],
      details: { fullOutputPath: "/tmp/full-output.txt" },
    });

    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "filtered from file",
    });

    const prepared = prepareBashArguments({ command: "npm test | tail -5" });

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      prepared,
      new AbortController().signal,
      () => {},
      {},
    );

    // Should run extractor on the full output file
    expect(mockPi.exec).toHaveBeenCalledWith("bash", [
      "-c",
      expect.stringContaining("/tmp/full-output.txt"),
    ]);
    // Should return filtered output only (no LLM notice for fast commands)
    const textContent = result.content[0];
    if (textContent.type === "text") {
      expect(textContent.text).toBe("filtered from file");
    }
    // Should notify UI
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Filtered via"),
      "info",
    );
    // Should NOT append notice to LLM response for fast commands
    expect(result.content).toHaveLength(1);
  });

  it("strips multiple extractors: grep FAIL | head -5", async () => {
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "FAIL test1\nFAIL test2\nPASS test3" }],
      details: undefined,
    });

    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "FAIL test1\nFAIL test2",
    });

    const prepared = prepareBashArguments({ command: "npm test | grep FAIL | head -5" });

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      prepared,
      new AbortController().signal,
      () => {},
      {},
    );

    // Should pipe through both grep and head
    expect(mockPi.exec).toHaveBeenCalledWith("bash", [
      "-c",
      expect.stringContaining("grep FAIL | head -5"),
    ]);
    const textContent = result.content[0];
    if (textContent.type === "text") {
      expect(textContent.text).toBe("FAIL test1\nFAIL test2");
    }
    // Should notify UI
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Filtered via"),
      "info",
    );
    // Should NOT append notice to LLM response for fast commands
    expect(result.content).toHaveLength(1);
  });
});

describe("prepareBashArguments", () => {
  it("strips trailing extractor and stores metadata", () => {
    const result = prepareBashArguments({ command: "ls | head -5" });
    expect(result.command).toBe("ls");
    expect(result._piToolGuardRemoved).toEqual(["head"]);
    expect(result._piToolGuardPipeline).toBe("head -5");
  });

  it("does nothing for commands without extractors", () => {
    const result = prepareBashArguments({ command: "ls -la" });
    expect(result.command).toBe("ls -la");
    expect(result._piToolGuardRemoved).toBeUndefined();
  });

  it("handles non-string command gracefully", () => {
    const result = prepareBashArguments({ command: 123 } as Record<string, unknown>);
    expect(result.command).toBe(123);
  });
});
