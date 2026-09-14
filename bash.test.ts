import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildNotice, FAST_THRESHOLD_MS, runExtractorOnText, runExtractorOnFile } from "./bash.ts";
import { stripTrailingExtractors } from "./pipeline.ts";
import { executeBashGuarded, type ExecuteContext, type ToolResult } from "./execute.ts";
import { readPiToolGuardDetails } from "./contract.ts";

describe("buildNotice", () => {
  it("returns fast-mode notice when mode is 'fast'", () => {
    const notice = buildNotice("head -5", "ls -la | head -5", "fast");
    expect(notice).toContain("Filtered via");
    expect(notice).toContain("small enough to pipe");
    expect(notice).not.toContain("do NOT re-run");
  });

  it("returns slow-mode notice when mode is 'slow'", () => {
    const notice = buildNotice("head -5", "ls -la | head -5", "slow");
    expect(notice).toContain("The full output is above");
    expect(notice).toContain("do NOT re-run");
  });

  it("defaults to slow mode when no mode provided", () => {
    const notice = buildNotice("head -5", "ls -la | head -5");
    expect(notice).toContain("The full output is above");
    expect(notice).toContain("do NOT re-run");
  });

  it("shows full original command and extractor pipeline", () => {
    const notice = buildNotice("grep FAIL | head -5", "npm test | grep FAIL | head -5", "fast");
    expect(notice).toContain("`grep FAIL | head -5`");
    expect(notice).toContain("`npm test | grep FAIL | head -5`");
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

    const params = { command: "ls -la" };
    const result = await executeBashGuarded(
      ctx,
      "call-1",
      params,
      new AbortController().signal,
      () => {},
      {},
    );

    expect(result).toBe(expected);
    expect(mockOriginalExecute).toHaveBeenCalledOnce();
    expect(mockOriginalExecute).toHaveBeenCalledWith(
      "call-1",
      params,
      expect.anything(),
      expect.any(Function),
      {},
    );
    // No extractors → no guard contract stamped.
    expect(readPiToolGuardDetails(result.details)).toBeUndefined();
  });

  it("fast command: pipes result through extractor and returns filtered output", async () => {
    const originalResult: ToolResult = {
      content: [{ type: "text", text: "line1\nline2\nline3" }],
      details: undefined,
    };
    mockOriginalExecute.mockImplementation(async () => originalResult);

    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "line1\nline2",
    });

    const params = { command: "ls -la | head -2" };
    const result = await executeBashGuarded(
      ctx,
      "call-1",
      params,
      new AbortController().signal,
      () => {},
      {},
    );

    // Should return filtered output (head -2)
    const textContent = result.content[0];
    if (textContent.type === "text") {
      expect(textContent.text).toBe("line1\nline2");
    }
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Filtered via"),
      "info",
    );
    // Should NOT append notice to LLM response for fast commands
    expect(result.content).toHaveLength(1);
  });

  it("executes the cleaned command but keeps the caller's original command", async () => {
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "line1\nline2" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, stdout: "line1" });

    const params: Record<string, unknown> = { command: "npm test | tail -20" };
    const result = await executeBashGuarded(
      ctx,
      "call-1",
      params,
      new AbortController().signal,
      () => {},
      {},
    );

    // The tool actually ran the cleaned command...
    expect(mockOriginalExecute).toHaveBeenCalledWith(
      "call-1",
      expect.objectContaining({ command: "npm test" }),
      expect.anything(),
      expect.anything(),
      {},
    );
    // ...but the caller's args (and therefore tool_result.input.command) keep
    // the command the user wrote, which is what SoL-Pi hashes in its receipt.
    expect(params.command).toBe("npm test | tail -20");
    expect(params._piToolGuardRemoved).toBeUndefined();
    expect(params._piToolGuardPipeline).toBeUndefined();
    expect(params._piToolGuardOriginalCommand).toBeUndefined();

    const guard = readPiToolGuardDetails(result.details);
    expect(guard).toMatchObject({
      version: 1,
      originalCommand: "npm test | tail -20",
      cleanedCommand: "npm test",
      removed: ["tail"],
      removedPipeline: "tail -20",
      outcome: "projection-applied",
    });
  });

  it("fast command: produces same output as original bash with extractor", async () => {
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

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      { command: "ls | head -2" },
      new AbortController().signal,
      () => {},
      {},
    );

    const textContent = result.content[0];
    if (textContent.type === "text") {
      expect(textContent.text).toBe(headOutput);
    }
    expect(mockCtx.ui.notify).toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
  });

  it("slow command: returns full output with LLM notice", async () => {
    vi.useFakeTimers();

    mockOriginalExecute.mockImplementation(async () => {
      vi.advanceTimersByTime(FAST_THRESHOLD_MS + 100);
      return {
        content: [{ type: "text", text: "full output" }],
        details: undefined,
      };
    });

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      { command: "npm test | tail -5" },
      new AbortController().signal,
      () => {},
      {},
    );

    const textContent = result.content[0];
    const llmNotice = result.content[1];
    if (textContent.type === "text" && llmNotice.type === "text") {
      expect(textContent.text).toBe("full output");
      expect(llmNotice.text).toContain("slow command");
      expect(llmNotice.text).toContain("Avoid re-running");
    }
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("The full output is above"),
      "info",
    );

    const guard = readPiToolGuardDetails(result.details);
    expect(guard).toMatchObject({
      originalCommand: "npm test | tail -5",
      cleanedCommand: "npm test",
      outcome: "full-output",
    });
    expect(guard?.sourcePath).toBeUndefined();

    vi.useRealTimers();
  });

  it("slow command + truncated: returns truncated output with LLM notice, no extractor run", async () => {
    vi.useFakeTimers();

    mockOriginalExecute.mockImplementation(async () => {
      vi.advanceTimersByTime(FAST_THRESHOLD_MS + 100);
      return {
        content: [{ type: "text", text: "truncated output..." }],
        details: { fullOutputPath: "/tmp/full-output.txt" },
      };
    });

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      { command: "npm test | tail -5" },
      new AbortController().signal,
      () => {},
      {},
    );

    expect(mockPi.exec).not.toHaveBeenCalled();
    const textContent = result.content[0];
    const llmNotice = result.content[1];
    if (textContent.type === "text" && llmNotice.type === "text") {
      expect(textContent.text).toBe("truncated output...");
      expect(llmNotice.text).toContain("slow command");
      expect(llmNotice.text).toContain("Avoid re-running");
    }
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("The full output is above"),
      "info",
    );

    // full-output keeps fullOutputPath for downstream reducers.
    const guard = readPiToolGuardDetails(result.details);
    expect(guard).toMatchObject({ outcome: "full-output", sourcePath: "/tmp/full-output.txt" });
    expect((result.details as { fullOutputPath?: string }).fullOutputPath).toBe("/tmp/full-output.txt");

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

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      { command: "npm test | tail -5" },
      new AbortController().signal,
      () => {},
      {},
    );

    expect(mockPi.exec).toHaveBeenCalledWith("bash", [
      "-c",
      expect.stringContaining("/tmp/full-output.txt"),
    ]);
    const textContent = result.content[0];
    if (textContent.type === "text") {
      expect(textContent.text).toBe("filtered from file");
    }
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Filtered via"),
      "info",
    );
    expect(result.content).toHaveLength(1);

    // Projection applied as a fallback, but `fullOutputPath` is preserved so a
    // downstream reducer (e.g. SoL-Pi's evidence-preserving reducer) can read
    // the exact full log and override guard's projection with its receipt.
    const guard = readPiToolGuardDetails(result.details);
    expect(guard).toMatchObject({
      outcome: "projection-applied",
      sourcePath: "/tmp/full-output.txt",
    });
    expect((result.details as { fullOutputPath?: string }).fullOutputPath).toBe("/tmp/full-output.txt");
  });

  it("interop: projection-applied still exposes fullOutputPath for an EPR-style reducer", async () => {
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "truncated full log..." }],
      details: { fullOutputPath: "/tmp/pi-bash-abc.log" },
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, stdout: "tail projection" });

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      { command: "npm test | tail -20" },
      new AbortController().signal,
      () => {},
      {},
    );

    // EPR's source selection (exactBodyFromInline) reads details.fullOutputPath
    // when it points at a safe pi-bash-*.log file. Guard must keep it so EPR
    // archives the full log and overrides guard's projection with a receipt.
    expect((result.details as { fullOutputPath?: string }).fullOutputPath).toBe("/tmp/pi-bash-abc.log");
    // ...and the original command survives for EPR's gate + receipt identity.
    expect(readPiToolGuardDetails(result.details)?.originalCommand).toBe("npm test | tail -20");
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

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      { command: "npm test | grep FAIL | head -5" },
      new AbortController().signal,
      () => {},
      {},
    );

    expect(mockPi.exec).toHaveBeenCalledWith("bash", [
      "-c",
      expect.stringContaining("grep FAIL | head -5"),
    ]);
    const textContent = result.content[0];
    if (textContent.type === "text") {
      expect(textContent.text).toBe("FAIL test1\nFAIL test2");
    }
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Filtered via"),
      "info",
    );
    expect(result.content).toHaveLength(1);

    const guard = readPiToolGuardDetails(result.details);
    expect(guard).toMatchObject({
      removed: ["grep", "head"],
      removedPipeline: "grep FAIL | head -5",
      outcome: "projection-applied",
    });
  });
});

describe("readPiToolGuardDetails", () => {
  it("parses a valid v1 record", () => {
    const parsed = readPiToolGuardDetails({
      piToolGuard: {
        version: 1,
        originalCommand: "npm test | tail",
        cleanedCommand: "npm test",
        removed: ["tail"],
        removedPipeline: "tail",
        outcome: "full-output",
        sourcePath: "/tmp/pi-bash-x.log",
      },
    });
    expect(parsed).toEqual({
      version: 1,
      originalCommand: "npm test | tail",
      cleanedCommand: "npm test",
      removed: ["tail"],
      removedPipeline: "tail",
      outcome: "full-output",
      sourcePath: "/tmp/pi-bash-x.log",
    });
  });

  it("returns undefined for missing or malformed records", () => {
    expect(readPiToolGuardDetails(undefined)).toBeUndefined();
    expect(readPiToolGuardDetails({})).toBeUndefined();
    expect(readPiToolGuardDetails({ piToolGuard: "nope" })).toBeUndefined();
    expect(
      readPiToolGuardDetails({ piToolGuard: { version: 2, outcome: "full-output" } }),
    ).toBeUndefined();
    expect(
      readPiToolGuardDetails({
        piToolGuard: {
          version: 1,
          originalCommand: "a",
          cleanedCommand: "a",
          removed: [],
          removedPipeline: "",
          outcome: "made-up",
        },
      }),
    ).toBeUndefined();
  });

  it("omits sourcePath when absent", () => {
    const parsed = readPiToolGuardDetails({
      piToolGuard: {
        version: 1,
        originalCommand: "a",
        cleanedCommand: "a",
        removed: [],
        removedPipeline: "",
        outcome: "projection-applied",
      },
    });
    expect(parsed).toBeDefined();
    expect("sourcePath" in parsed!).toBe(false);
  });
});
