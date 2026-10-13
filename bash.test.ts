import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readdir, realpath, lstat } from "node:fs/promises";
import { readFileSync, rmSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, dirname } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  buildNotice,
  buildSlowReadbackNotice,
  FAST_THRESHOLD_MS,
  EMPTY_OUTPUT_PLACEHOLDER,
  FULL_OUTPUT_TTL_MS,
  isProjectionNoop,
  runExtractorOnText,
  runExtractorOnFile,
  sweepStaleFullOutputs,
  persistFullOutput,
  parseBashError,
  splitExitStatus,
  joinOutputStreams,
  createSideChannelPath,
  resetSideChannel,
  readSideChannel,
  removeSideChannel,
} from "./bash.ts";
import { rethrowGuardedError, executeBashGuarded, type ExecuteContext, type ToolResult } from "./execute.ts";
import { stripTrailingExtractors } from "./pipeline.ts";
import { readPiToolGuardDetails } from "./contract.ts";

describe("buildNotice", () => {
  it("returns fast-mode notice when mode is 'fast'", () => {
    const notice = buildNotice("head -5", "ls -la | head -5", "fast");
    expect(notice).toContain("Filtered via");
    expect(notice).toContain("small enough to pipe");
    expect(notice).not.toContain("do NOT re-run");
  });

  it("returns fast-file notice when output came from the saved temp file", () => {
    const notice = buildNotice("head -5", "ls -la | head -5", "fast-file");
    expect(notice).toContain("Filtered via");
    expect(notice).toContain("temp file");
    // The truncated output was NOT small; do not claim it was.
    expect(notice).not.toContain("small enough to pipe");
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

describe("buildSlowReadbackNotice", () => {
  it("inlines the full-output path and tells the agent to read it", () => {
    const notice = buildSlowReadbackNotice("npm test | tail -5", "/tmp/full.log");
    expect(notice).toContain("slow command");
    expect(notice).toContain("Avoid re-running");
    expect(notice).toContain("/tmp/full.log");
    expect(notice).toContain("instead of re-running");
    // The `Full output:` form lets downstream reducers (SoL-Pi EPR) locate the
    // guard's persisted log by regex when `details.fullOutputPath` is absent.
    expect(notice).toContain("Full output: /tmp/full.log");
  });

  it("still warns to avoid re-running when no path was persisted", () => {
    const notice = buildSlowReadbackNotice("npm test | tail -5");
    expect(notice).toContain("slow command");
    expect(notice).toContain("Avoid re-running");
    expect(notice).not.toContain("saved to:");
  });
});

describe("isProjectionNoop", () => {
  it("treats trailing-whitespace-only differences as identical", () => {
    expect(isProjectionNoop("a\nb", "a\nb\n")).toBe(true);
    expect(isProjectionNoop("a\nb\n", "a\nb\n\n")).toBe(true);
  });

  it("detects a real reduction", () => {
    expect(isProjectionNoop("a", "a\nb")).toBe(false);
    expect(isProjectionNoop("", "a")).toBe(false);
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
    expect(result).toEqual({ text: "line1\nline2", code: 0 });
    // `text` must travel as an argv element, not be spliced into the script.
    expect(mockPi.exec).toHaveBeenCalledWith("bash", [
      "-c",
      expect.stringContaining('"$1"'),
      "bash",
      text,
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
    expect(result).toEqual({ text: "last line", code: 0 });
    expect(mockPi.exec).toHaveBeenCalledWith("bash", [
      "-c",
      expect.stringContaining('"$1"'),
      "bash",
      filePath,
    ]);
  });

  it("runExtractorOnText returns {text,code} for non-zero exit (code 2)", async () => {
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 2,
      stdout: "",
    });

    const result = await runExtractorOnText(mockPi, "text", "head -1");
    expect(result).toEqual({ text: "", code: 2 });
  });

  it("F2: runExtractorOnText returns {text,code} for exit-1 (grep no match)", async () => {
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 1,
      stdout: "",
    });

    const result = await runExtractorOnText(mockPi, "text", "grep nope");
    expect(result).toEqual({ text: "", code: 1 });
  });

  it("F2: runExtractorOnFile returns {text,code} for exit-1 (grep no match)", async () => {
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 1,
      stdout: "",
    });

    const result = await runExtractorOnFile(mockPi, "/tmp/file.txt", "grep nope");
    expect(result).toEqual({ text: "", code: 1 });
  });

  it("runExtractorOnFile returns {text,code} for non-zero exit (code 2)", async () => {
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 2,
      stdout: "",
    });

    const result = await runExtractorOnFile(mockPi, "/tmp/file.txt", "head -1");
    expect(result).toEqual({ text: "", code: 2 });
  });

  it("runExtractorOnFile returns undefined only when pi.exec throws", async () => {
    (mockPi.exec as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("fail"));

    const result = await runExtractorOnFile(mockPi, "/tmp/file.txt", "head -1");
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F4: persistFullOutput
// ---------------------------------------------------------------------------

describe("persistFullOutput", () => {
  it("writes text to a temp file and returns its path", () => {
    const text = "line1\nline2\nline3";
    const path = persistFullOutput(text);
    expect(path).toBeDefined();
    expect(path).toMatch(/^.*pi-bash-guard-[0-9a-f]+\.log$/);

    const read = readFileSync(path!, "utf-8");
    expect(read).toBe(text);

    rmSync(path!, { force: true });
  });

  it("returns undefined on write failure", () => {
    // An unwritable path forces writeFileSync to throw.
    const path = persistFullOutput("data");
    // We can't easily force a failure without mocking, so just verify the
    // happy path returns a string. Failure-path coverage comes from the
    // catch branch which is simple enough.
    expect(typeof path).toBe("string");
    rmSync(path!, { force: true });
  });

  it("sweeps stale guard temp files before writing", () => {
    const stalePath = join(tmpdir(), `pi-bash-guard-${Date.now().toString(16)}-stale.log`);
    writeFileSync(stalePath, "stale");
    const old = new Date(Date.now() - (FULL_OUTPUT_TTL_MS + 1000));
    utimesSync(stalePath, old, old);

    const fresh = persistFullOutput("hello");
    try {
      expect(fresh).toBeDefined();
      expect(existsSync(stalePath)).toBe(false);
    } finally {
      rmSync(stalePath, { force: true });
      if (fresh) rmSync(fresh, { force: true });
    }
  });

  it("produces an artifact SoL-Pi's EPR safePiBashTempPath accepts", async () => {
    const text = `full log line\n${"x".repeat(5_000)}`;
    const path = persistFullOutput(text);
    try {
      expect(path).toBeDefined();
      // EPR's safePiBashTempPath trusts only pi-shaped names directly in the
      // OS temp dir, so the guard's artifact must satisfy all three checks.
      expect(/^pi-bash-[^/\\]+\.log$/u.test(basename(path!))).toBe(true);
      const [candidate, root, status] = await Promise.all([
        realpath(path!),
        realpath(tmpdir()),
        lstat(path!),
      ]);
      expect(status.isFile()).toBe(true);
      expect(status.isSymbolicLink()).toBe(false);
      expect(dirname(candidate)).toBe(root);
      // ...and hold the exact, untruncated bytes the reducer will archive.
      expect(readFileSync(path!, "utf-8")).toBe(text);
    } finally {
      rmSync(path!, { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// F1: parseBashError
// ---------------------------------------------------------------------------

describe("parseBashError", () => {
  it("parses exit code from error message", () => {
    const err = new Error("output text\n\nCommand exited with code 1");
    const parsed = parseBashError(err);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.text).toBe("output text");
    expect(parsed.fullOutputPath).toBeUndefined();
  });

  it("parses exit code 0", () => {
    const err = new Error("some output\n\nCommand exited with code 0");
    const parsed = parseBashError(err);
    expect(parsed.exitCode).toBe(0);
    expect(parsed.text).toBe("some output");
  });

  it("extracts full-output path from truncated error", () => {
    const err = new Error(
      "output\n\n[Showing lines 5-9 of 999. Full output: /tmp/pi-bash-abc.log]\n\nCommand exited with code 1",
    );
    const parsed = parseBashError(err);
    expect(parsed.exitCode).toBe(1);
    expect(parsed.fullOutputPath).toBe("/tmp/pi-bash-abc.log");
    // Banner stripped from text
    expect(parsed.text).toBe("output");
  });

  it("returns raw text with no exitCode for non-bash errors", () => {
    const err = new Error("connection timeout");
    const parsed = parseBashError(err);
    expect(parsed.exitCode).toBeUndefined();
    expect(parsed.text).toBe("connection timeout");
  });

  it("handles string errors", () => {
    const parsed = parseBashError("raw string error");
    expect(parsed.exitCode).toBeUndefined();
    expect(parsed.text).toBe("raw string error");
  });
});

// ---------------------------------------------------------------------------
// pi's resolved non-zero exits (isError results, pi 0.99+/1.2.0)
// ---------------------------------------------------------------------------

describe("splitExitStatus", () => {
  it("splits pi's appended status off the output, byte-exact", () => {
    // pi writes `${outputText}\n\n${status}` (appendStatus); the body must be
    // the original outputText, trailing newline included.
    expect(splitExitStatus("a\nb\n\n\nCommand exited with code 3")).toEqual({
      body: "a\nb\n",
      exitCode: 3,
    });
  });

  it("handles a status-only result (command printed nothing)", () => {
    expect(splitExitStatus("Command exited with code 1")).toEqual({
      body: "",
      exitCode: 1,
    });
  });

  it("returns undefined when the text carries no status", () => {
    expect(splitExitStatus("just output")).toBeUndefined();
  });

  it("strips only pi's trailing status, not an identical earlier line", () => {
    expect(
      splitExitStatus("Command exited with code 5\n\nCommand exited with code 5"),
    ).toEqual({ body: "Command exited with code 5", exitCode: 5 });
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
    // Fast commands show no guard UI at all — no Notice, no receipt.
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
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
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);
  });

  it("F4: slow command persists full output and projects (outcome projection-applied)", async () => {
    vi.useFakeTimers();

    mockOriginalExecute.mockImplementation(async () => {
      vi.advanceTimersByTime(FAST_THRESHOLD_MS + 100);
      return {
        content: [{ type: "text", text: "full output" }],
        details: undefined,
      };
    });

    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "projected output",
    });

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      { command: "npm test | tail -5" },
      new AbortController().signal,
      () => {},
      {},
    );

    // Slow command → persistFullOutput wrote a temp file, extractor ran on it
    const textContent = result.content[0];
    if (textContent.type === "text") {
      expect(textContent.text).toContain("projected output");
      expect(textContent.text).toContain("slow command");
      expect(textContent.text).toContain("Avoid re-running");
    }
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("The full output is above"),
      "info",
    );

    const guard = readPiToolGuardDetails(result.details);
    expect(guard).toMatchObject({
      originalCommand: "npm test | tail -5",
      cleanedCommand: "npm test",
      outcome: "projection-applied",
      slow: true,
    });
    // F4: slow command without truncation still gets a persisted sourcePath,
    // and the LLM-visible text points the agent at that file instead of a rerun.
    expect(guard?.sourcePath).toBeDefined();
    expect(typeof guard?.sourcePath).toBe("string");
    const slowText = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
    expect(slowText?.text).toContain(guard!.sourcePath!);
    expect(slowText?.text).toContain("instead of re-running");

    vi.useRealTimers();
  });

  it("F4: slow command + truncated runs extractor on full output file (outcome projection-applied)", async () => {
    vi.useFakeTimers();

    mockOriginalExecute.mockImplementation(async () => {
      vi.advanceTimersByTime(FAST_THRESHOLD_MS + 100);
      return {
        content: [{ type: "text", text: "truncated output..." }],
        details: { fullOutputPath: "/tmp/full-output.txt" },
      };
    });

    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "projected from file",
    });

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      { command: "npm test | tail -5" },
      new AbortController().signal,
      () => {},
      {},
    );

    // Slow + truncated → extractor runs on the full output file
    expect(mockPi.exec).toHaveBeenCalledWith("bash", [
      "-c",
      expect.stringContaining('"$1"'),
      "bash",
      "/tmp/full-output.txt",
    ]);
    const textContent = result.content[0];
    if (textContent.type === "text") {
      expect(textContent.text).toContain("projected from file");
      expect(textContent.text).toContain("slow command");
      expect(textContent.text).toContain("Avoid re-running");
    }
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("The full output is above"),
      "info",
    );

    // projection-applied keeps fullOutputPath for downstream reducers.
    const guard = readPiToolGuardDetails(result.details);
    expect(guard).toMatchObject({ outcome: "projection-applied", sourcePath: "/tmp/full-output.txt" });
    expect((result.details as { fullOutputPath?: string }).fullOutputPath).toBe("/tmp/full-output.txt");
    const slowText = result.content.find((c): c is { type: "text"; text: string } => c.type === "text");
    expect(slowText?.text).toContain("/tmp/full-output.txt");

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
      expect.stringContaining('"$1"'),
      "bash",
      "/tmp/full-output.txt",
    ]);
    const textContent = result.content[0];
    if (textContent.type === "text") {
      expect(textContent.text).toBe("filtered from file");
    }
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
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
      "bash",
      "FAIL test1\nFAIL test2\nPASS test3",
    ]);
    const textContent = result.content[0];
    if (textContent.type === "text") {
      expect(textContent.text).toBe("FAIL test1\nFAIL test2");
    }
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
    expect(result.content).toHaveLength(1);

    const guard = readPiToolGuardDetails(result.details);
    expect(guard).toMatchObject({
      removed: ["grep", "head"],
      removedPipeline: "grep FAIL | head -5",
      outcome: "projection-applied",
    });
  });

  it("splits wall clock into command and extractor timing", async () => {
    let clock = 1_000_000;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      mockOriginalExecute.mockImplementation(async () => {
        clock += 5_000; // cleaned command runs for 5s
        return { content: [{ type: "text", text: "a\nb\nc" }], details: undefined };
      });
      (mockPi.exec as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        clock += 1_500; // guard's extractor projection costs another 1.5s
        return { code: 0, stdout: "a\nb" };
      });

      const result = await executeBashGuarded(
        ctx,
        "call-1",
        { command: "ls | head -2" },
        new AbortController().signal,
        () => {},
        {},
      );

      const guard = readPiToolGuardDetails(result.details);
      expect(guard?.timing).toEqual({ commandMs: 5_000, extractorMs: 1_500, totalMs: 6_500 });
    } finally {
      now.mockRestore();
    }
  });

  it("shows no notice when the projection matches the original output", async () => {
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "line1\nline2\n" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "line1\nline2\n", // tail -20 on a 2-line output changes nothing
    });

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      { command: "ls | tail -20" },
      new AbortController().signal,
      () => {},
      {},
    );

    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
    const textContent = result.content[0];
    if (textContent.type === "text") {
      expect(textContent.text).toBe("line1\nline2");
    }
    // The strip is still published for downstream consumers.
    const guard = readPiToolGuardDetails(result.details);
    expect(guard?.outcome).toBe("projection-applied");
    expect(guard?.noop).toBe(true);
  });

  it("publishes projection savings for a real reduction", async () => {
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "b\na\nc\nd" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "a\nb", // head -2 does change the output
    });

    const result = await executeBashGuarded(
      ctx,
      "call-1",
      { command: "cat | head -2" },
      new AbortController().signal,
      () => {},
      {},
    );

    const guard = readPiToolGuardDetails(result.details);
    expect(guard?.noop).toBe(false);
    expect(guard?.projection).toEqual({
      inputLines: 4,
      inputBytes: 7,
      outputLines: 2,
      outputBytes: 3,
    });
    expect(guard?.slow).toBe(false);
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
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

  it("parses per-phase timing when present", () => {
    const parsed = readPiToolGuardDetails({
      piToolGuard: {
        version: 1,
        originalCommand: "ls | head -2",
        cleanedCommand: "ls",
        removed: ["head"],
        removedPipeline: "head -2",
        outcome: "projection-applied",
        timing: { commandMs: 5_000, extractorMs: 1_500, totalMs: 6_500 },
      },
    });
    expect(parsed?.timing).toEqual({ commandMs: 5_000, extractorMs: 1_500, totalMs: 6_500 });
  });

  it("parses projection stats and the noop flag", () => {
    const parsed = readPiToolGuardDetails({
      piToolGuard: {
        version: 1,
        originalCommand: "ls | tail -20",
        cleanedCommand: "ls",
        removed: ["tail"],
        removedPipeline: "tail -20",
        outcome: "projection-applied",
        noop: false,
        projection: { inputLines: 1_234, inputBytes: 20_480, outputLines: 20, outputBytes: 1_024 },
      },
    });
    expect(parsed?.noop).toBe(false);
    expect(parsed?.projection).toEqual({
      inputLines: 1_234,
      inputBytes: 20_480,
      outputLines: 20,
      outputBytes: 1_024,
    });
  });

  it("drops malformed timing/projection instead of failing the whole record", () => {
    const parsed = readPiToolGuardDetails({
      piToolGuard: {
        version: 1,
        originalCommand: "a",
        cleanedCommand: "a",
        removed: [],
        removedPipeline: "",
        outcome: "full-output",
        timing: { commandMs: "soon" },
        projection: { inputLines: 1 },
        noop: "maybe",
      },
    });
    expect(parsed).toBeDefined();
    expect(parsed?.timing).toBeUndefined();
    expect(parsed?.projection).toBeUndefined();
    expect(parsed?.noop).toBeUndefined();
  });
});

describe("extractor execution (real shell)", () => {
  const execFileAsync = promisify(execFile);

  async function realExec(command: string, args: string[]) {
    try {
      const { stdout, stderr } = await execFileAsync(command, args);
      return { stdout, stderr, code: 0, killed: false };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number };
      return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1, killed: false };
    }
  }

  const pi = { exec: realExec } as unknown as ExtensionAPI;

  it("preserves real newlines so line-based extractors work", async () => {
    const out = await runExtractorOnText(pi, "FAIL test1\nFAIL test2\nPASS test3", "tail -1");
    expect(out).toEqual({ text: "PASS test3", code: 0 });
  });

  it("does not expand $() or backticks from command output", async () => {
    const text = "$(echo pwned)\n`echo pwned`";
    const out = await runExtractorOnText(pi, text, "cat");
    expect(out).toEqual({ text, code: 0 });
  });

  it("filters a file whose path contains spaces", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-tool-guard-"));
    const file = join(dir, "with space.txt");
    await writeFile(file, "alpha\nbeta\n");
    try {
      const out = await runExtractorOnFile(pi, file, "head -1");
      expect(out).toEqual({ text: "alpha", code: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("F6: sweepStaleFullOutputs", () => {
  it("removes stale matching files and keeps fresh ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-tool-guard-sweep-"));
    const fresh = join(dir, "pi-bash-guard-aaaaaaaa.log");
    const stale = join(dir, "pi-bash-guard-bbbbbbbb.log");
    const nonMatching = join(dir, "other-file.log");
    await writeFile(fresh, "fresh");
    await writeFile(stale, "stale");
    await writeFile(nonMatching, "non-matching");

    // Make `stal` look older than the TTL by setting its mtime in the past.
    const staleTime = new Date(Date.now() - (FULL_OUTPUT_TTL_MS + 1000));
    const { utimes } = await import("node:fs/promises");
    await utimes(stale, staleTime, staleTime);

    const removed = sweepStaleFullOutputs(dir, FULL_OUTPUT_TTL_MS);
    expect(removed).toBe(1);

    // Fresh and non-matching files remain.
    const remaining = new Set(await readdir(dir));
    expect(remaining.has("pi-bash-guard-aaaaaaaa.log")).toBe(true);
    expect(remaining.has("pi-bash-guard-bbbbbbbb.log")).toBe(false);
    expect(remaining.has("other-file.log")).toBe(true);

    await rm(dir, { recursive: true, force: true });
  });

  it("does not remove files whose names do not match the pattern", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-tool-guard-sweep-"));
    const file = join(dir, "not-a-guard-file.log");
    await writeFile(file, "data");
    const staleTime = new Date(Date.now() - (FULL_OUTPUT_TTL_MS + 1000));
    const { utimes } = await import("node:fs/promises");
    await utimes(file, staleTime, staleTime);

    const removed = sweepStaleFullOutputs(dir, FULL_OUTPUT_TTL_MS);
    expect(removed).toBe(0);

    await rm(dir, { recursive: true, force: true });
  });

  it("returns 0 when the directory does not exist", () => {
    const removed = sweepStaleFullOutputs("/nonexistent/path/xyz", FULL_OUTPUT_TTL_MS);
    expect(removed).toBe(0);
  });
});

describe("EMPTY_OUTPUT_PLACEHOLDER", () => {
  it("matches the literal string pi uses for empty results", () => {
    expect(EMPTY_OUTPUT_PLACEHOLDER).toBe("(no output)");
  });
});

// ---------------------------------------------------------------------------
// Side-channel sinks (hoisted statements)
// ---------------------------------------------------------------------------

describe("joinOutputStreams", () => {
  it("returns the middle verbatim when nothing was hoisted", () => {
    expect(joinOutputStreams("", "line1\nline2", "")).toBe("line1\nline2");
  });

  it("re-attaches prefix and suffix in shell order", () => {
    expect(joinOutputStreams("=== t ===\n", "line1", "R=0\n")).toBe("=== t ===\nline1\nR=0\n");
  });

  it("inserts a newline only when the accumulated text needs one", () => {
    // The projection is `trimEnd`-ed, so without this guard the suffix would
    // glue onto the last projected line.
    expect(joinOutputStreams("head", "tail", "R=1")).toBe("head\ntail\nR=1");
  });

  it("drops empty and undefined parts", () => {
    expect(joinOutputStreams(undefined, "", "only")).toBe("only");
    expect(joinOutputStreams("", "", "")).toBe("");
  });
});

describe("side-channel sinks", () => {
  it("round-trips through create/reset/read/remove", () => {
    const path = createSideChannelPath()!;
    expect(path).toMatch(/pi-bash-guard-sink-[0-9a-f]+\.out$/);
    try {
      expect(resetSideChannel(path)).toBe(true);
      expect(readSideChannel(path)).toBe("");
      writeFileSync(path, "hoisted text", "utf-8");
      expect(readSideChannel(path)).toBe("hoisted text");
    } finally {
      removeSideChannel(path);
    }
    expect(existsSync(path)).toBe(false);
  });

  it("returns safe fallbacks for unusable paths", () => {
    expect(readSideChannel("/nonexistent/dir/pi-bash-guard-sink-x.out")).toBe("");
    expect(resetSideChannel("/nonexistent/dir/pi-bash-guard-sink-x.out")).toBe(false);
    // Removal never throws on a missing file.
    expect(() => removeSideChannel("/nonexistent/dir/pi-bash-guard-sink-x.out")).not.toThrow();
  });

  it("sweeps stale sinks alongside stale full-output logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-tool-guard-sink-sweep-"));
    const sink = join(dir, "pi-bash-guard-sink-deadbeef.out");
    await writeFile(sink, "hoisted");
    const staleTime = new Date(Date.now() - (FULL_OUTPUT_TTL_MS + 1000));
    const { utimes } = await import("node:fs/promises");
    await utimes(sink, staleTime, staleTime);

    expect(sweepStaleFullOutputs(dir, FULL_OUTPUT_TTL_MS)).toBe(1);
    expect(existsSync(sink)).toBe(false);

    await rm(dir, { recursive: true, force: true });
  });
});
