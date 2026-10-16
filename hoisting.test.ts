import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { executeBashGuarded, type ExecuteContext, type ToolResult } from "./execute.ts";
import { readPiToolGuardDetails } from "./contract.ts";

// ---------------------------------------------------------------------------
// Hoisting, end to end against a real shell
// ---------------------------------------------------------------------------
//
// These cases run the *rewritten* command through bash and compare the guard's
// content with what the original command printed — including `$?`, exit codes
// and `&&` short-circuiting. That is the only way to prove the hoisted
// statements are spliced back in faithfully.

/** Never rejects: `pi.exec` resolves with the exit code instead. */
function execWithCode(
  file: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? ((err as { code?: unknown }).code ?? 1) : 0;
      resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
    });
  });
}

let cwd: string;

beforeAll(() => {
  cwd = mkdtempSync(join(tmpdir(), "pi-tool-guard-hoist-"));
});

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

/** `originalExecute` stand-in that runs bash and mimics pi's non-zero throw. */
function makeContext(seen: string[] = []) {
  const pi = {
    exec: (file: string, args: string[]) => execWithCode(file, args, cwd),
  } as unknown as ExtensionAPI;
  const ctx = {
    pi,
    ctx: { ui: { notify: () => {}, setStatus: () => {} }, mode: "tui" },
    originalExecute: async (_id: string, params: { command: string }): Promise<ToolResult> => {
      seen.push(params.command);
      const r = await execWithCode("bash", ["-c", params.command], cwd);
      if (r.code !== 0) {
        throw new Error(`${r.stdout}\n\nCommand exited with code ${r.code}`);
      }
      return { content: [{ type: "text", text: r.stdout }], details: undefined };
    },
  } as unknown as ExecuteContext;
  return { ctx, seen };
}

async function runBoth(command: string) {
  const { ctx, seen } = makeContext();
  const original = await execWithCode("bash", ["-c", command], cwd);
  const guarded = await executeBashGuarded(
    ctx,
    "c1",
    { command },
    new AbortController().signal,
    () => {},
    {},
  );
  const text = guarded.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { original, text, executed: seen[0]!, guard: readPiToolGuardDetails(guarded.details) };
}

describe("hoisting end to end", () => {
  it("reproduces the shell exactly for `echo && cmd | extractor; echo`", async () => {
    const command =
      'echo "=== prefix ===" && printf \'l1\\nl2\\nl3\\n\' | head -2; echo "=== suffix ==="';
    const { original, text, executed } = await runBoth(command);

    expect(original.code).toBe(0);
    expect(text.trimEnd()).toBe(original.stdout.trimEnd());
    // The projection really is limited to the window's output.
    expect(text).toBe("=== prefix ===\nl1\nl2\n=== suffix ===\n");
    expect(executed).toContain("{ echo \"=== prefix ===\"");
    expect(executed).toContain("{ echo \"=== suffix ===\"");
    expect(executed).not.toContain("head -2");
  });

  it("keeps a failing view's status visible to a trailing `echo $?`", async () => {
    const command = "printf 'a\\n' | grep nomatch; echo \"R=$?\"";
    const { original, text, executed, guard } = await runBoth(command);

    // bash: grep exits 1, the echo absorbs it, the script exits 0. The guard
    // must not touch this command: stripping `grep` would make `$?` observe
    // `printf` and print R=0 instead of R=1.
    expect(original.code).toBe(0);
    expect(original.stdout).toBe("R=1\n");
    expect(text).toBe("R=1\n");
    expect(executed).toBe(command);
    expect(guard).toBeUndefined();
  });

  it("keeps a `$?`-free trailing statement while stripping the view", async () => {
    const command = "printf 'l1\\nl2\\nl3\\n' | head -2; echo \"done\"";
    const { original, text, executed } = await runBoth(command);

    expect(text.trimEnd()).toBe(original.stdout.trimEnd());
    expect(text).toBe("l1\nl2\ndone\n");
    expect(executed).not.toContain("head -2");
  });

  it("reproduces the shell for a leading statement that prints first", async () => {
    const command = "echo one; echo two; printf 'x\\ny\\n' | head -1";
    const { original, text } = await runBoth(command);

    expect(text.trimEnd()).toBe(original.stdout.trimEnd());
    expect(text).toBe("one\ntwo\nx");
  });

  it("preserves `&&` short-circuiting when the hoisted statement fails", async () => {
    // `cd` into a missing directory: the pipeline must NOT run, but the trailing
    // statement still does (that is `;`).
    const command = "cd /nonexistent-dir-xyz && printf 'x\\n' | head -1; echo \"R=$?\"";
    const { original, text } = await runBoth(command);

    // bash: `cd` fails, `printf | head` is skipped, `; echo` still runs.
    expect(original.code).toBe(0);
    expect(original.stdout).toBe("R=1\n");
    expect(text).toBe("R=1\n");
  });

  it("still fails the command when a hoisted statement owns a non-zero exit", async () => {
    const { ctx } = makeContext();
    await expect(
      executeBashGuarded(
        ctx,
        "c1",
        { command: "printf 'a\\nb\\n' | tail -1; false" },
        new AbortController().signal,
        () => {},
        {},
      ),
    ).rejects.toThrow(/Command exited with code 1/);
  });

  it("caps hoisted sink text to pi's model-facing limit", async () => {
    const command = "seq 1 70000; printf 'p\\n' | head -1";
    const { text, guard } = await runBoth(command);

    // seq's ~340KB goes to the sink and comes back around the projection.
    // Pi would have capped that at 50KB for the model; the guard must too.
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(50 * 1024 + 400);
    expect(text.trimEnd().endsWith("p")).toBe(true);
    expect(guard?.capped).toBe(true);
  });

  it("disposes its side-channel sinks", async () => {
    const command = "echo hi; printf 'a\\n' | tail -1";
    const { executed } = await runBoth(command);
    const sink = />> '([^']+)'/.exec(executed)![1]!;

    // The path really was used by the shell…
    expect(executed).toContain(sink);
    // …and is gone once the guard is done with it.
    expect(existsSync(sink)).toBe(false);
  });
});
