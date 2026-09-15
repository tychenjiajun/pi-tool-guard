import { describe, it, expect, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  executeBashGuarded,
  rethrowGuardedError,
  type ExecuteContext,
  type ToolResult,
} from "./execute.ts";
import { readPiToolGuardDetails } from "./contract.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

  it("passes a multi-statement command through unchanged (no unscoped projection)", async () => {
    const { mockOriginalExecute, ctx, mockCtx, mockPi } = makeContext();
    const params = { command: "seq 1 100 && seq 1000 1100 | head -n 5" };

    const result = await executeBashGuarded(
      ctx, "c1", params,
      new AbortController().signal, () => {}, {},
    );

    // Untouched: no stripping, no extractor subprocess, no guard contract.
    expect(mockOriginalExecute).toHaveBeenCalledWith(
      "c1", params, expect.anything(), expect.any(Function), {},
    );
    expect(mockPi.exec).not.toHaveBeenCalled();
    expect(mockCtx.ui.notify).not.toHaveBeenCalled();
    expect(readPiToolGuardDetails(result.details)).toBeUndefined();
  });
});
