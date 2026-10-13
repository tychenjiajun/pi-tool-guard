import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const mockPersistFullOutput = vi.hoisted(() => vi.fn());

vi.mock("./bash.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bash.ts")>();
  return {
    ...actual,
    persistFullOutput: mockPersistFullOutput,
  };
});

import {
  executeBashGuarded,
  rethrowGuardedError,
  type ExecuteContext,
  type ToolResult,
} from "./execute.ts";
import { readPiToolGuardDetails } from "./contract.ts";
import { persistFullOutput, EMPTY_OUTPUT_PLACEHOLDER, FAST_THRESHOLD_MS } from "./bash.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Default: persistFullOutput returns undefined. Tests that need real
  // filesystem behavior can override this mock inline.
  mockPersistFullOutput.mockReset();
  mockPersistFullOutput.mockReturnValue(undefined);
});

function makeContext() {
  const mockPi = { exec: vi.fn() } as unknown as ExtensionAPI;
  const mockCtx = { ui: { notify: vi.fn(), setStatus: vi.fn() }, mode: "tui" };
  const mockOriginalExecute = vi.fn().mockResolvedValue({
    content: [{ type: "text", text: "" }],
    details: undefined,
  });
  const ctx: ExecuteContext = {
    pi: mockPi,
    ctx: mockCtx as unknown as ExecuteContext["ctx"],
    originalExecute: mockOriginalExecute as unknown as ExecuteContext["originalExecute"],
  };
  return { mockPi, mockCtx, mockOriginalExecute, ctx };
}

// ---------------------------------------------------------------------------
// F1: rethrowGuardedError
// ---------------------------------------------------------------------------

describe("rethrowGuardedError", () => {
  const stripped = { removedNames: ["tail"], removedPipeline: "tail -5" };

  it("rethrows unchanged when error has no exit code (abort/timeout)", async () => {
    const { mockPi, ctx } = makeContext();
    const err = new Error("Command aborted by signal SIGTERM");

    await expect(
      rethrowGuardedError(ctx, stripped, "npm test | tail -5", err),
    ).rejects.toThrow("Command aborted by signal SIGTERM");
    expect(mockPi.exec).not.toHaveBeenCalled();
  });

  it("projects from full-output file on non-zero exit", async () => {
    const { mockPi, mockCtx, ctx } = makeContext();
    const err = new Error(
      "build failed\n\n[Showing lines 5-9 of 999. Full output: /tmp/pi-bash-abc.log]\n\nCommand exited with code 1",
    );

    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "projected failure",
    });

    await expect(
      rethrowGuardedError(ctx, stripped, "npm test | tail -5", err),
    ).rejects.toThrow(/projected failure[\s\S]*Command exited with code 1[\s\S]*Full output: \/tmp\/pi-bash-abc\.log/);
    expect(mockPi.exec).toHaveBeenCalledWith("bash", [
      "-c",
      expect.stringContaining('"$1"'),
      "bash",
      "/tmp/pi-bash-abc.log",
    ]);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("the large output was piped through"),
      "info",
    );
  });

  it("projects inline when no full-output path", async () => {
    const { mockPi, ctx } = makeContext();
    const err = new Error("some error output\n\nCommand exited with code 2");

    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "projected inline",
    });

    await expect(
      rethrowGuardedError(ctx, stripped, "npm test | tail -5", err),
    ).rejects.toThrow(/projected inline[\s\S]*Command exited with code 2/);
    expect(mockPi.exec).toHaveBeenCalledWith("bash", [
      "-c",
      expect.stringContaining('"$1"'),
      "bash",
      "some error output",
    ]);
  });

  it("uses raw text when extractor fails", async () => {
    const { mockPi, mockCtx, ctx } = makeContext();
    const err = new Error("error text\n\nCommand exited with code 1");

    (mockPi.exec as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("exec failed"));

    await expect(
      rethrowGuardedError(ctx, stripped, "npm test | tail -5", err),
    ).rejects.toThrow(/error text[\s\S]*Command exited with code 1/);
    // No notification when extractor fails
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("keeps the original exit code when the re-run extractor also fails", async () => {
    const { mockPi, ctx } = makeContext();
    const err = new Error("body text\n\nCommand exited with code 2");

    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 1,
      stdout: "partial body",
    });

    await expect(
      rethrowGuardedError(ctx, stripped, "npm test | tail -5", err),
    ).rejects.toThrow(/partial body[\s\S]*Command exited with code 2/);
  });

  it("uses the slow notice mode when the failing command was slow", async () => {
    const { mockPi, mockCtx, ctx } = makeContext();
    const err = new Error("out\n\nCommand exited with code 1");

    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "projected",
    });

    await expect(
      rethrowGuardedError(ctx, stripped, "npm test | tail -5", err, FAST_THRESHOLD_MS + 1),
    ).rejects.toThrow(/projected/);
    expect(mockCtx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("do NOT re-run"),
      "info",
    );
  });

  it("re-attaches hoisted output around the projected error body", async () => {
    const { mockPi, ctx } = makeContext();
    const err = new Error("raw\n\nCommand exited with code 1");

    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, stdout: "projected" });

    await expect(
      rethrowGuardedError(ctx, stripped, "echo hi; npm test | tail -5", err, undefined, {
        prefix: "hi\n",
        suffix: "bye\n",
      }),
    ).rejects.toThrow(/^hi\nprojected\nbye\n\n\[Command exited with code 1\]/);
  });
});

// ---------------------------------------------------------------------------
// No caching: an identical slow command always re-runs
// ---------------------------------------------------------------------------

describe("executeBashGuarded does not replay commands", () => {
  it("runs an identical command again instead of reusing a prior output", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "output" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, stdout: "out" });

    await executeBashGuarded(
      ctx, "c1", { command: "ls | head -2" },
      new AbortController().signal, () => {}, {},
    );
    await executeBashGuarded(
      ctx, "c2", { command: "ls | head -2" },
      new AbortController().signal, () => {}, {},
    );

    // The guard never replays a previous output: both runs execute the command.
    expect(mockOriginalExecute).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// F5: noop detection on file projections
// ---------------------------------------------------------------------------

describe("executeBashGuarded noop detection (F5)", () => {
  it("does not claim noop for file-based projections", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();

    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "truncated..." }],
      details: { fullOutputPath: "/tmp/full.log" },
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "identical to original",
    });

    const result = await executeBashGuarded(
      ctx, "c1", { command: "ls | tail -5" },
      new AbortController().signal, () => {}, {},
    );

    const guard = readPiToolGuardDetails(result.details);
    expect(guard?.outcome).toBe("projection-applied");
    // File-based projections never claim noop (no inline comparison possible)
    expect(guard?.noop).toBeFalsy();
  });

  it("detects noop for inline projections that change nothing", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();

    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "line1\nline2" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "line1\nline2", // identical
    });

    const result = await executeBashGuarded(
      ctx, "c1", { command: "ls | tail -20" },
      new AbortController().signal, () => {}, {},
    );

    const guard = readPiToolGuardDetails(result.details);
    expect(guard?.noop).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error path: originalExecute throws
// ---------------------------------------------------------------------------

describe("executeBashGuarded error path", () => {
  it("delegates to rethrowGuardedError when originalExecute throws", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();

    mockOriginalExecute.mockRejectedValue(
      new Error("build failed\n\nCommand exited with code 1"),
    );
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "projected error",
    });

    await expect(
      executeBashGuarded(
        ctx, "c1", { command: "npm test | tail -5" },
        new AbortController().signal, () => {}, {},
      ),
    ).rejects.toThrow(/projected error[\s\S]*Command exited with code 1/);
  });

  it("rethrows unchanged when error is not a bash exit-code error", async () => {
    const { mockOriginalExecute, ctx } = makeContext();

    mockOriginalExecute.mockRejectedValue(new Error("connection reset"));

    await expect(
      executeBashGuarded(
        ctx, "c1", { command: "npm test | tail -5" },
        new AbortController().signal, () => {}, {},
      ),
    ).rejects.toThrow("connection reset");
  });
});

// ---------------------------------------------------------------------------
// Redirections and the background operator `&`
// ---------------------------------------------------------------------------

describe("executeBashGuarded redirections", () => {
  it("keeps an input redirect on the cleaned command and still projects the view", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "line1\nline2\nline3" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, stdout: "line1\nline2" });

    const result = await executeBashGuarded(
      ctx, "c1", { command: "grep foo < input.txt | head -2" },
      new AbortController().signal, () => {}, {},
    );

    // The redirect stays with the cleaned command; only `head -2` was stripped.
    expect(mockOriginalExecute.mock.calls[0]![1]).toEqual({ command: "grep foo < input.txt" });
    const guard = readPiToolGuardDetails(result.details);
    expect(guard?.outcome).toBe("projection-applied");
    expect(guard?.removedPipeline).toBe("head -2");
    expect(result.content[0]).toEqual({ type: "text", text: "line1\nline2" });
  });

  it("carries an output redirect on the view into removedPipeline", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "a\nb\nc" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, stdout: "" });

    const result = await executeBashGuarded(
      ctx, "c1", { command: "npm test | head -2 > out.txt" },
      new AbortController().signal, () => {}, {},
    );

    expect(mockOriginalExecute.mock.calls[0]![1]).toEqual({ command: "npm test" });
    const guard = readPiToolGuardDetails(result.details);
    expect(guard?.removedPipeline).toBe("head -2 > out.txt");
  });
});

describe("executeBashGuarded background operator", () => {
  it("does not strip when the final statement is backgrounded", async () => {
    const { mockOriginalExecute, ctx } = makeContext();
    const params = { command: "npm test 2>&1 | tail -20 &" };

    await executeBashGuarded(
      ctx, "c1", params,
      new AbortController().signal, () => {}, {},
    );

    // Untouched: the guard must not drop the trailing `&`.
    expect(mockOriginalExecute).toHaveBeenCalledWith(
      "c1", params, expect.anything(), expect.any(Function), {},
    );
  });

  it("leaves an earlier backgrounded statement untouched instead of stripping the final view", async () => {
    const { mockOriginalExecute, ctx } = makeContext();
    const params = { command: "command a | head & command b | tail" };

    await executeBashGuarded(
      ctx, "c1", params,
      new AbortController().signal, () => {}, {},
    );

    // The earlier `&` job can interleave with the final pipeline's stdout, so
    // the guard passes the whole command through unchanged.
    expect(mockOriginalExecute).toHaveBeenCalledWith(
      "c1", params, expect.anything(), expect.any(Function), {},
    );
  });

  it("hoists a stdout-sharing statement instead of projecting the whole command", async () => {
    const { mockOriginalExecute, ctx, mockCtx, mockPi } = makeContext();
    const params = { command: "seq 1 100 && seq 1000 1100 | head -n 5" };
    const sinks: string[] = [];
    mockOriginalExecute.mockImplementation(async (_id, modified: { command: string }) => {
      for (const match of modified.command.matchAll(/>> '([^']+)'/g)) {
        sinks.push(match[1]!);
        writeFileSync(match[1]!, "hoisted\n", "utf-8");
      }
      return { content: [{ type: "text", text: "line1\nline2\nline3" }], details: undefined };
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, stdout: "line1" });

    const result = await executeBashGuarded(
      ctx, "c1", params,
      new AbortController().signal, () => {}, {},
    );

    // `seq 1 100` is redirected into a side channel so `head -n 5` only ever
    // sees `seq 1000 1100`.
    const executed = (mockOriginalExecute.mock.calls[0]![1] as { command: string }).command;
    expect(executed).toMatch(/^\{ seq 1 100\n\} >> '[^']+' 2>&1 && seq 1000 1100$/);
    expect(sinks).toHaveLength(1);
    expect(existsSync(sinks[0]!)).toBe(false); // disposed in the finally

    const guard = readPiToolGuardDetails(result.details);
    expect(guard?.outcome).toBe("projection-applied");
    expect(guard?.removedPipeline).toBe("head -n 5");
    // Hoisted output is re-attached around the projection.
    expect(result.content[0]).toEqual({ type: "text", text: "hoisted\nline1" });
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
  });

  it("re-attaches a trailing statement around the projection", async () => {
    const { mockOriginalExecute, ctx, mockPi } = makeContext();
    const params = { command: 'npm test 2>&1 | tail -5; echo "done"' };
    mockOriginalExecute.mockImplementation(async (_id, modified: { command: string }) => {
      for (const match of modified.command.matchAll(/>> '([^']+)'/g)) {
        writeFileSync(match[1]!, match[1]!.includes("sink") ? "done\n" : "", "utf-8");
      }
      return { content: [{ type: "text", text: "a\nb\nc" }], details: undefined };
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, stdout: "b\nc" });

    const result = await executeBashGuarded(
      ctx, "c1", params,
      new AbortController().signal, () => {}, {},
    );

    const executed = (mockOriginalExecute.mock.calls[0]![1] as { command: string }).command;
    expect(executed).toMatch(/^npm test 2>&1; \{ echo "done"\n\} >> '[^']+' 2>&1$/);
    expect(result.content[0]).toEqual({ type: "text", text: "b\nc\ndone\n" });
    expect(readPiToolGuardDetails(result.details)?.removedPipeline).toBe("tail -5");
  });

  it("passes commands through when a statement cannot be hoisted", async () => {
    const { mockOriginalExecute, ctx, mockPi } = makeContext();
    // The earlier statement has its own extractor: hoisting would leave the
    // shell applying `head -3` while the guard projects `tail -5`.
    const params = { command: "cat x | head -3 && npm test | tail -5" };

    const result = await executeBashGuarded(
      ctx, "c1", params,
      new AbortController().signal, () => {}, {},
    );

    expect(mockOriginalExecute).toHaveBeenCalledWith(
      "c1", params, expect.anything(), expect.any(Function), {},
    );
    expect(mockPi.exec).not.toHaveBeenCalled();
    expect(readPiToolGuardDetails(result.details)).toBeUndefined();
  });
});

// -------------------------------------------------------------------------
// #1: extractor exit-code fidelity
// -------------------------------------------------------------------------

describe("executeBashGuarded extractor exit-code fidelity", () => {
  it("does not fail the command when a statement follows the window", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "" }],
      details: undefined,
    });
    // `grep` re-run finds nothing (exit 1), exactly like the shell's own grep.
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 1, stdout: "" });

    const result = await executeBashGuarded(
      ctx, "c1", { command: "npm test | grep FAIL; echo done" },
      new AbortController().signal, () => {}, {},
    );

    // The script exits 0 (the echo owns the status), so the guard must project
    // rather than throw `Command exited with code 1`.
    expect(readPiToolGuardDetails(result.details)?.outcome).toBe("projection-applied");
  });
  it("throws when the extractor pipeline exits non-zero (code 2)", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "line1\nline2\nline3" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 2,
      stdout: "",
    });

    await expect(
      executeBashGuarded(
        ctx, "c1", { command: "ls | head -2" },
        new AbortController().signal, () => {}, {},
      ),
    ).rejects.toThrow(/Command exited with code 2/);
  });

  it("includes the extractor stdout body in the thrown error", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "line1\nline2" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 3,
      stdout: "partial output",
    });

    await expect(
      executeBashGuarded(
        ctx, "c1", { command: "ls | head -2" },
        new AbortController().signal, () => {}, {},
      ),
    ).rejects.toThrow(/partial output[\s\S]*Command exited with code 3/);
  });

  it("throws with the (no output) placeholder when extractor stdout is empty", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "line1" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 2,
      stdout: "",
    });

    await expect(
      executeBashGuarded(
        ctx, "c1", { command: "ls | head -2" },
        new AbortController().signal, () => {}, {},
      ),
    ).rejects.toThrow(/\(no output\)[\s\S]*Command exited with code 2/);
  });

  it("throws with full-output path when source is a file", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "truncated..." }],
      details: { fullOutputPath: "/tmp/pi-bash-xyz.log" },
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 2,
      stdout: "",
    });

    await expect(
      executeBashGuarded(
        ctx, "c1", { command: "npm test | tail -5" },
        new AbortController().signal, () => {}, {},
      ),
    ).rejects.toThrow(/Command exited with code 2.*Full output: \/tmp\/pi-bash-xyz\.log/);
  });

  it("throws for exit code 1 (grep no match), matching pi's pipeline exit", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "line1\nline2" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 1,
      stdout: "",
    });

    await expect(
      executeBashGuarded(
        ctx, "c1", { command: "ls | grep nomatch" },
        new AbortController().signal, () => {}, {},
      ),
    ).rejects.toThrow(/Command exited with code 1/);
  });
});

// -------------------------------------------------------------------------
// #3: empty-output fidelity for inline projections
// -------------------------------------------------------------------------

describe("executeBashGuarded empty-output fidelity", () => {
  it("keeps (no output) placeholder when inline source is empty and projection yields empty", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "(no output)" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "",
    });

    const result = await executeBashGuarded(
      ctx, "c1", { command: "true | head -1" },
      new AbortController().signal, () => {}, {},
    );

    expect(result.content[0]).toEqual({ type: "text", text: "(no output)" });
    const guard = readPiToolGuardDetails(result.details);
    expect(guard?.outcome).toBe("projection-applied");
    // The placeholder projection is a noop (input === output)
    expect(guard?.noop).toBe(true);
  });

  it("does NOT keep (no output) when the projection produces real output", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "(no output)" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "real output",
    });

    const result = await executeBashGuarded(
      ctx, "c1", { command: "true | head -1" },
      new AbortController().signal, () => {}, {},
    );

    expect(result.content[0]).toEqual({ type: "text", text: "real output" });
  });

  it("does NOT keep (no output) when the inline source has real output", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "actual output" }],
      details: undefined,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "",
    });

    const result = await executeBashGuarded(
      ctx, "c1", { command: "echo actual | head -0" },
      new AbortController().signal, () => {}, {},
    );

    // The projection came back empty but the source was real, so we show the
    // empty string — not the placeholder.
    expect(result.content[0]).toEqual({ type: "text", text: "" });
  });
});

// -------------------------------------------------------------------------
// #2: persist-failure fallback
// -------------------------------------------------------------------------

describe("executeBashGuarded persist-failure fallback", () => {
  it("returns full output when slow and no source path available", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();

    // Simulate a slow command by delaying past FAST_THRESHOLD_MS.
    mockOriginalExecute.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                content: [{ type: "text", text: "line1\nline2\nline3" }],
                details: undefined,
              }),
            FAST_THRESHOLD_MS + 100,
          ),
        ),
    );
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "line1\nline2",
    });

    const result = await executeBashGuarded(
      ctx, "c1", { command: "slowcmd | head -2" },
      new AbortController().signal, () => {}, {},
    );

    // Without persist (persistFullOutput fails → undefined), the projection is
    // unsafe (slow + no sourcePath → canProject false), so we fall back to
    // full output with an LLM notice.
    const guard = readPiToolGuardDetails(result.details);
    expect(guard?.outcome).toBe("full-output");
    expect(guard?.slow).toBe(true);
    // The LLM notice is appended to the original output.
    const last = result.content[result.content.length - 1];
    if (last.type !== "text") throw new Error("expected a text content block");
    expect(last.text).toContain("slow command");
  }, 30000);

  it("applies the projection when a slow command persists its full output", async () => {
    const { mockPi, mockOriginalExecute, mockCtx, ctx } = makeContext();
    mockPersistFullOutput.mockReturnValueOnce("/tmp/pi-bash-guard-deadbeef.log");

    mockOriginalExecute.mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                content: [{ type: "text", text: "a\nb\nc" }],
                details: undefined,
              }),
            FAST_THRESHOLD_MS + 100,
          ),
        ),
    );
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "a\nb",
    });

    const result = await executeBashGuarded(
      ctx, "c1", { command: "slowcmd | head -2" },
      new AbortController().signal, () => {}, {},
    );

    const guard = readPiToolGuardDetails(result.details);
    expect(guard?.outcome).toBe("projection-applied");
    expect(guard?.slow).toBe(true);
    expect(guard?.sourcePath).toBe("/tmp/pi-bash-guard-deadbeef.log");
    // The guard's own persisted log is published as `details.fullOutputPath`
    // (pi did not truncate), so SoL-Pi's EPR can read the exact full log.
    expect((result.details as { fullOutputPath?: string }).fullOutputPath).toBe(
      "/tmp/pi-bash-guard-deadbeef.log",
    );
    const first = result.content[0];
    if (first.type !== "text") throw new Error("expected a text content block");
    expect(first.text).toContain("a\nb");
    // The LLM notice inlines the reducer-friendly `Full output: <path>` marker.
    expect(first.text).toContain("Full output: /tmp/pi-bash-guard-deadbeef.log");
    expect(mockCtx.ui.notify).toHaveBeenCalled();
  }, 30000);
});

// -------------------------------------------------------------------------
// pi's resolved non-zero exits: bash returns `isError` results instead of
// throwing (pi 0.99+/1.2.0) and stamps `structuredContent` for its
// `outputSchema` (c.codemode/programmatic callers).
// -------------------------------------------------------------------------

describe("executeBashGuarded resolved isError results", () => {
  it("keeps the cleaned command's status line out of the projection", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "FAIL a\nFAIL b\n\nCommand exited with code 1" }],
      details: undefined,
      isError: true,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      stdout: "FAIL b",
    });

    const result = await executeBashGuarded(
      ctx, "c1", { command: "npm test | grep FAIL" },
      new AbortController().signal, () => {}, {},
    );

    // The extractor never sees pi's status line…
    expect(mockPi.exec).toHaveBeenCalledWith("bash", [
      "-c",
      expect.stringContaining('"$1"'),
      "bash",
      "FAIL a\nFAIL b",
    ]);
    // …and the pipeline reports the view's exit (0), as pi would for
    // `npm test | grep FAIL` when the grep matched.
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toEqual({ type: "text", text: "FAIL b" });
    expect(readPiToolGuardDetails(result.details)?.outcome).toBe("projection-applied");
  });

  it("re-stamps structuredContent around the projection", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "x\ny\n\nCommand exited with code 1" }],
      details: undefined,
      isError: true,
      structuredContent: {
        output: "x\ny",
        truncated: true,
        full_output_path: "/tmp/pi-bash-abc.log",
        exit_code: 1,
        wall_time_seconds: 0.2,
      },
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, stdout: "y" });

    const result = await executeBashGuarded(
      ctx, "c1", { command: "npm test | grep y" },
      new AbortController().signal, () => {}, {},
    );

    // The bash `outputSchema` payload survives the guard: output becomes the
    // projection, exit_code the view's exit, wall time the guarded run — and
    // the truncation pointers to the unprojected log are kept as pi wrote them.
    expect(result.structuredContent).toMatchObject({
      output: "y",
      truncated: true,
      full_output_path: "/tmp/pi-bash-abc.log",
      exit_code: 0,
    });
    expect(
      (result.structuredContent as { wall_time_seconds: number }).wall_time_seconds,
    ).toBeTypeOf("number");
    expect(result.isError).toBeUndefined();
  });

  it("keeps the status line and failure flag when the view never runs", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }],
      details: undefined,
      isError: true,
      structuredContent: {
        output: "boom",
        truncated: false,
        exit_code: 1,
        wall_time_seconds: 0.1,
      },
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("exec failed"));

    const result = await executeBashGuarded(
      ctx, "c1", { command: "npm test | tail -5" },
      new AbortController().signal, () => {}, {},
    );

    // Nothing re-decided the exit, so pi's failure signal stays intact.
    expect(result.isError).toBe(true);
    const first = result.content[0];
    if (first.type !== "text") throw new Error("expected a text content block");
    expect(first.text).toContain("Command exited with code 1");
    expect(
      (result.structuredContent as { exit_code: number }).exit_code,
    ).toBe(1);
  });

  it("keeps the failure when a statement after the window owns the exit", async () => {
    const { mockPi, mockOriginalExecute, ctx } = makeContext();
    mockOriginalExecute.mockResolvedValue({
      content: [{ type: "text", text: "out\n\nCommand exited with code 1" }],
      details: undefined,
      isError: true,
    });
    (mockPi.exec as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, stdout: "out" });

    const result = await executeBashGuarded(
      ctx, "c1", { command: "npm test | head -2; false" },
      new AbortController().signal, () => {}, {},
    );

    // The guard changed no exit semantics (the trailing `false` owns the
    // status), so the flag pi resolved with is preserved.
    expect(readPiToolGuardDetails(result.details)?.outcome).toBe("projection-applied");
    expect(result.isError).toBe(true);
  });
});
