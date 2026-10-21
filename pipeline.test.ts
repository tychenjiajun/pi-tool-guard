import { describe, it, expect } from "vitest";
import {
  stripTrailingExtractors,
  extractFullOutputPath,
  classifyExtractor,
  VIEW_EXTRACTORS,
  TRANSFORM_EXTRACTORS,
} from "./pipeline.ts";

// ---------------------------------------------------------------------------
// Real-world cases from ~/.pi/agent/sessions/
// ---------------------------------------------------------------------------

describe("stripTrailingExtractors", () => {

  // ── Simple tail/head ─────────────────────────────────────────────────

  describe("simple tail/head", () => {
    it("npm run build 2>&1 | tail -20", () => {
      const r = stripTrailingExtractors("npm run build 2>&1 | tail -20");
      expect(r).toEqual({
        cleaned: "npm run build 2>&1",
        execCommand: "npm run build 2>&1",
        hoistedPrefix: [],
        hoistedSuffix: [],
        hasFollowingStatement: false,
        removedNames: ["tail"],
        removedPipeline: "tail -20",
      });
    });

    it("npm run build 2>&1 | tail -5", () => {
      const r = stripTrailingExtractors("npm run build 2>&1 | tail -5");
      expect(r!.cleaned).toBe("npm run build 2>&1");
      expect(r!.removedNames).toEqual(["tail"]);
    });

    it("npm run build 2>&1 | tail -30", () => {
      const r = stripTrailingExtractors("npm run build 2>&1 | tail -30");
      expect(r!.cleaned).toBe("npm run build 2>&1");
    });

    it("npm run typecheck 2>&1 && npm run build 2>&1 | tail -5", () => {
      // `typecheck` writes to stdout before the piped `build`, so re-applying
      // `tail` to the stripped command would tail typecheck's output too.
      expect(
        stripTrailingExtractors("npm run typecheck 2>&1 && npm run build 2>&1 | tail -5"),
      ).toBeUndefined();
    });

    it("find src -type f -name '*.ts' | head -20", () => {
      const r = stripTrailingExtractors("find src -type f -name '*.ts' | head -20");
      expect(r).toEqual({
        cleaned: "find src -type f -name '*.ts'",
        execCommand: "find src -type f -name '*.ts'",
        hoistedPrefix: [],
        hoistedSuffix: [],
        hasFollowingStatement: false,
        removedNames: ["head"],
        removedPipeline: "head -20",
      });
    });

    it("./dist/cli.js 2>&1 | head -30", () => {
      const r = stripTrailingExtractors("./dist/cli.js 2>&1 | head -30");
      expect(r!.cleaned).toBe("./dist/cli.js 2>&1");
      expect(r!.removedNames).toEqual(["head"]);
    });
  });

  // ── pytest patterns (the main anti-pattern) ──────────────────────────

  describe("pytest with tail/head", () => {
    it(".venv/bin/python -m pytest tests/ -v --tb=short 2>&1 | tail -30", () => {
      const r = stripTrailingExtractors(".venv/bin/python -m pytest tests/ -v --tb=short 2>&1 | tail -30");
      expect(r!.cleaned).toBe(".venv/bin/python -m pytest tests/ -v --tb=short 2>&1");
      expect(r!.removedNames).toEqual(["tail"]);
    });

    it("pytest with -xvs and tail -60 (repeated anti-pattern)", () => {
      const r = stripTrailingExtractors(".venv/bin/python -m pytest tests/test_time_varying_universe_equivalence.py::TestTimeVaryingUniverseEquivalence::test_metrics_equivalence -xvs 2>&1 | tail -60");
      expect(r!.cleaned).toContain("test_metrics_equivalence -xvs 2>&1");
      expect(r!.removedNames).toEqual(["tail"]);
    });

    it("pytest with -xvs and tail -80 (same test, bigger tail)", () => {
      const r = stripTrailingExtractors(".venv/bin/python -m pytest tests/test_time_varying_universe_equivalence.py::TestTimeVaryingUniverseEquivalence::test_metrics_equivalence -xvs 2>&1 | tail -80");
      expect(r!.removedNames).toEqual(["tail"]);
    });

    it("pytest with tail -100", () => {
      const r = stripTrailingExtractors(".venv/bin/python -m pytest tests/ -x -q --tb=short 2>&1 | tail -100");
      expect(r!.cleaned).toBe(".venv/bin/python -m pytest tests/ -x -q --tb=short 2>&1");
    });

    it("pytest with head -100", () => {
      const r = stripTrailingExtractors(".venv/bin/python -m pytest tests/ -v --tb=short 2>&1 | head -100");
      expect(r!.cleaned).toBe(".venv/bin/python -m pytest tests/ -v --tb=short 2>&1");
      expect(r!.removedNames).toEqual(["head"]);
    });

    it("pytest with head -50", () => {
      const r = stripTrailingExtractors(".venv/bin/python -m pytest tests/test_metric_caching_and_list.py -v --tb=short 2>&1 | head -50");
      expect(r!.removedNames).toEqual(["head"]);
    });

    it("pytest with head -80", () => {
      const r = stripTrailingExtractors(".venv/bin/python -m pytest tests/test_metric_caching_and_list.py -v --tb=short 2>&1 | head -80");
      expect(r!.removedNames).toEqual(["head"]);
    });

    it("pytest with tail -5", () => {
      const r = stripTrailingExtractors("cd /Users/chenjiajun/projects/insight-alpha-server-qlib && uv run pytest -v 2>&1 | tail -5");
      expect(r).toBeDefined();
      expect(r!.cleaned).toBe("cd /Users/chenjiajun/projects/insight-alpha-server-qlib && uv run pytest -v 2>&1");
      expect(r!.removedNames).toEqual(["tail"]);
    });
  });

  // ── pytest with grep (context lines) ─────────────────────────────────

  describe("pytest with grep -A (context lines)", () => {
    it("pytest | grep -A 50 FAILED", () => {
      const r = stripTrailingExtractors('.venv/bin/python -m pytest tests/test_group_return_with_benchmark.py::TestBenchmarkEquivalence::test_benchmark_data_matches -v 2>&1 | grep -A 50 "FAILED"');
      expect(r!.cleaned).toContain("test_benchmark_data_matches -v 2>&1");
      expect(r!.removedNames).toEqual(["grep"]);
    });

    it("pytest | grep -A 100 FAILED", () => {
      const r = stripTrailingExtractors('.venv/bin/python -m pytest tests/test_group_return_with_benchmark.py::TestBenchmarkEquivalence::test_benchmark_data_matches -v 2>&1 | grep -A 100 "FAILED"');
      expect(r!.removedNames).toEqual(["grep"]);
    });

    it("pytest | grep -A 30 pattern", () => {
      const r = stripTrailingExtractors('.venv/bin/python -m pytest tests/test_group_return_with_benchmark.py::TestBenchmarkEquivalence::test_group_return_benchmark_matches_standalone -v 2>&1 | grep -A 30 "assert"');
      expect(r!.removedNames).toEqual(["grep"]);
    });

    it("pytest | grep -A 10 pattern", () => {
      const r = stripTrailingExtractors('.venv/bin/python -m pytest tests/test_time_varying_universe_equivalence.py::TestTimeVaryingUniverseEquivalence::test_metrics_equivalence -xvs 2>&1 | grep -A 10 "Error"');
      expect(r!.removedNames).toEqual(["grep"]);
    });

    it("pytest | grep -A 5 pattern", () => {
      const r = stripTrailingExtractors('.venv/bin/python -m pytest tests/test_time_varying_universe_equivalence.py::TestTimeVaryingUniverseEquivalence::test_metrics_equivalence -xvs 2>&1 | grep -A 5 "assert"');
      expect(r!.removedNames).toEqual(["grep"]);
    });
  });

  // ── Multi-pipe extractors ────────────────────────────────────────────

  describe("multi-pipe extractors", () => {
    it("npm test | grep FAIL | head -5", () => {
      const r = stripTrailingExtractors("npm test | grep FAIL | head -5");
      expect(r).toEqual({
        cleaned: "npm test",
        execCommand: "npm test",
        hoistedPrefix: [],
        hoistedSuffix: [],
        hasFollowingStatement: false,
        removedNames: ["grep", "head"],
        removedPipeline: "grep FAIL | head -5",
      });
    });

    it("cmd | grep -v grep | head -5", () => {
      const r = stripTrailingExtractors("ps aux | grep uvicorn | grep -v grep");
      // grep -v grep is also grep — should be stripped
      if (r) {
        expect(r.removedNames).toEqual(["grep", "grep"]);
      }
    });
  });

  // ── Complex pipelines ────────────────────────────────────────────────

  describe("complex pipelines", () => {
    it("curl | python json.tool | head -40", () => {
      const r = stripTrailingExtractors("curl -s http://localhost:8000/tasks 2>&1 | python3 -m json.tool 2>&1 | head -30");
      // python3 -m json.tool is not an extractor, head is
      if (r) {
        expect(r.removedNames).toEqual(["head"]);
        expect(r.cleaned).toContain("python3 -m json.tool 2>&1");
      }
    });

    it("cat | cat -v | head -10", () => {
      const r = stripTrailingExtractors("head -c 2000 /tmp/file.js | cat -v | head -10");
      if (r) {
        expect(r.removedNames).toEqual(["head"]);
      }
    });

    it("grep -oE | sort -u | head -40 strips only the view", () => {
      const r = stripTrailingExtractors("grep -oE '[a-zA-Z_$][a-zA-Z0-9_$]{4,}' /tmp/file.js | sort -u | head -40");
      expect(r).toBeDefined();
      // `sort -u` is a transform and stops the walk; `head` is the view that
      // is removed, and the shell keeps applying `sort -u`.
      expect(r!.removedNames).toEqual(["head"]);
      expect(r!.removedPipeline).toBe("head -40");
      expect(r!.cleaned).toBe(
        "grep -oE '[a-zA-Z_$][a-zA-Z0-9_$]{4,}' /tmp/file.js | sort -u",
      );
    });

    it("sed | cat -n", () => {
      const r = stripTrailingExtractors("sed -n '130,140p' /path/to/file.ts | cat -n");
      // cat is not an extractor
      expect(r).toBeUndefined();
    });

    it("npm build | grep | head (multi-step)", () => {
      const r = stripTrailingExtractors("pnpm build:css 2>&1 && grep 'color-tag' styles/theme.css | grep -v 'on' | head -10");
      if (r) {
        expect(r.removedNames).toContain("head");
      }
    });
  });

  // ── Non-pipeline commands (should return undefined) ──────────────────

  describe("non-pipeline commands", () => {
    it("simple ls", () => {
      expect(stripTrailingExtractors("ls -la")).toBeUndefined();
    });

    it("simple cat", () => {
      expect(stripTrailingExtractors("cat file.txt")).toBeUndefined();
    });

    it("simple npm test", () => {
      expect(stripTrailingExtractors("npm test")).toBeUndefined();
    });

    it("simple pytest", () => {
      expect(stripTrailingExtractors(".venv/bin/python -m pytest tests/ -v")).toBeUndefined();
    });

    it("cd && command", () => {
      expect(stripTrailingExtractors("cd /tmp && npm install")).toBeUndefined();
    });
  });

  // ── Pipeline with non-extractor at end ───────────────────────────────

  describe("pipeline with non-extractor at end", () => {
    it("echo hello | cat", () => {
      expect(stripTrailingExtractors("echo hello | cat")).toBeUndefined();
    });

    it("cat file | sort", () => {
      // sort is a TRANSFORM extractor (F7): stripping it would silently drop
      // the transformation, so the command is left completely untouched.
      const r = stripTrailingExtractors("cat file | sort");
      expect(r).toBeUndefined();
    });

    it("cat file | wc -l", () => {
      // wc is a TRANSFORM extractor (F7): the command is left untouched.
      const r = stripTrailingExtractors("cat file | wc -l");
      expect(r).toBeUndefined();
    });
  });

  // ── Commands with 2>&1 ───────────────────────────────────────────────

  describe("stderr redirection", () => {
    it("cmd 2>&1 | tail -30", () => {
      const r = stripTrailingExtractors(".venv/bin/python -m pytest tests/test_factor.py -v --tb=short 2>&1 | tail -40");
      expect(r!.cleaned).toBe(".venv/bin/python -m pytest tests/test_factor.py -v --tb=short 2>&1");
      expect(r!.removedNames).toEqual(["tail"]);
    });

    it("pnpm install 2>&1 | tail -5", () => {
      const r = stripTrailingExtractors("cd /tmp/resume-test && pnpm install 2>&1 | tail -5");
      expect(r).toBeDefined();
      expect(r!.cleaned).toBe("cd /tmp/resume-test && pnpm install 2>&1");
      expect(r!.removedNames).toEqual(["tail"]);
    });
  });

  // ── view-logs and scripts ────────────────────────────────────────────

  describe("script pipelines", () => {
    it("./view-logs.sh all | tail -80", () => {
      const r = stripTrailingExtractors("./view-logs.sh all | tail -80");
      expect(r!.cleaned).toBe("./view-logs.sh all");
      expect(r!.removedNames).toEqual(["tail"]);
    });

    it("./view-logs.sh all | grep -i pattern", () => {
      const r = stripTrailingExtractors('./view-logs.sh all | grep -i "error"');
      expect(r!.cleaned).toBe("./view-logs.sh all");
      expect(r!.removedNames).toEqual(["grep"]);
    });

    it("cat /tmp/server.log | tail -100", () => {
      const r = stripTrailingExtractors("cat /tmp/server.log 2>/dev/null | tail -100");
      expect(r!.removedNames).toEqual(["tail"]);
    });

    it("tail -30 /tmp/server.log (standalone tail, not pipeline)", () => {
      // This is NOT a pipeline — tail is the only command
      expect(stripTrailingExtractors("tail -30 /tmp/server.log")).toBeUndefined();
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("empty string", () => {
      expect(stripTrailingExtractors("")).toBeUndefined();
    });

    it("whitespace only", () => {
      expect(stripTrailingExtractors("   ")).toBeUndefined();
    });

    it("single pipe with non-extractor", () => {
      expect(stripTrailingExtractors("echo hello | cat")).toBeUndefined();
    });

    it("command with env vars", () => {
      const r = stripTrailingExtractors("PAT_TOKEN=abc ./scripts/calc.py 2>&1 | head -50");
      expect(r!.removedNames).toEqual(["head"]);
    });

    it("command with && before pipe", () => {
      const r = stripTrailingExtractors("cd /path && npm test 2>&1 | tail -20");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["tail"]);
      expect(r!.cleaned).toBe("cd /path && npm test 2>&1");
    });

    it("multiple && with head pipelines (TOP CPU/MEM case)", () => {
      // The `echo` labels and the first `head -15` all write to the same
      // stdout; stripping the final `head -10` would scope it to the whole
      // script instead of just the last `ps`.
      const cmd = 'echo "=== TOP CPU ===" && ps aux --sort=-%cpu 2>/dev/null | head -15 && echo "=== TOP MEM ===" && ps aux --sort=-%mem 2>/dev/null | head -10';
      expect(stripTrailingExtractors(cmd)).toBeUndefined();
    });
  });

  describe("multiple ;-separated statements", () => {
    it("ignores an extractor that is not in the final statement", () => {
      // `head` ends the first statement, not the whole command. Nothing
      // trailing should be stripped, and `echo b` must survive.
      expect(stripTrailingExtractors("echo a | head; echo b")).toBeUndefined();
    });

    it("leaves `echo a; ls | head` untouched (echo writes to the same stdout)", () => {
      expect(stripTrailingExtractors("echo a; ls | head")).toBeUndefined();
    });

    it("leaves a command untouched when an intervening statement writes to stdout", () => {
      const cmd = 'cd /tmp && grep -n "x" f.ts | head -20; echo ====; grep -n "y" f.ts | grep -n "z"';
      expect(stripTrailingExtractors(cmd)).toBeUndefined();
    });

    it("leaves `ls | head; echo done | tail` untouched (earlier pipeline emits)", () => {
      expect(stripTrailingExtractors("ls | head; echo done | tail")).toBeUndefined();
    });
  });

  // ── F7: transforms are never removed (but a following view still is) ─

  describe("F7 transform guard", () => {
    it("leaves a pure transform pipeline untouched", () => {
      // `sort` is a transform — stripping it would drop the ordering.
      expect(stripTrailingExtractors("npm test | sort")).toBeUndefined();
    });

    it("strips a view that follows a transform, leaving the transform in place", () => {
      // `sort` (transform) precedes `head` (view); only `head` is removed so
      // the shell still runs `sort -rh` before the guard re-applies the view.
      const r = stripTrailingExtractors("du -sh * | sort -rh | head -15");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["head"]);
      expect(r!.removedPipeline).toBe("head -15");
      expect(r!.cleaned).toBe("du -sh * | sort -rh");
    });

    it("stops the walk at the first transform in a longer chain", () => {
      const r = stripTrailingExtractors("grep err out.log | awk '{print $1}' | sort -u | head -40");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["head"]);
      expect(r!.cleaned).toBe("grep err out.log | awk '{print $1}' | sort -u");
    });

    it("strips view-only pipelines", () => {
      const r = stripTrailingExtractors("npm test | grep FAIL | head -5");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["grep", "head"]);
      expect(r!.cleaned).toBe("npm test");
    });

    it("strips a view pipeline with redirections", () => {
      const r = stripTrailingExtractors("npm test 2>&1 | tail -20");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["tail"]);
      expect(r!.cleaned).toBe("npm test 2>&1");
    });

    it("leaves a trailing transform in a multi-statement command untouched", () => {
      // `sort` is a transform in the final statement's pipeline.
      expect(stripTrailingExtractors("echo hello | cat; npm run build | sort")).toBeUndefined();
    });
  });

  // ── Unbounded producers: the removed view may be the only terminator ──

  describe("unbounded producer guard", () => {
    it("refuses to strip a view after `tail -f`", () => {
      expect(stripTrailingExtractors('tail -f /tmp/build.log | grep -m 1 "BINGO"')).toBeUndefined();
      expect(stripTrailingExtractors("tail -F app.log | head -50")).toBeUndefined();
      expect(stripTrailingExtractors("tail --follow=name app.log | tail -50")).toBeUndefined();
    });

    it("refuses to strip `yes | head`", () => {
      expect(stripTrailingExtractors("yes | head -5")).toBeUndefined();
    });

    it("refuses a removed `tail -f`, which would hang the guard's own re-run", () => {
      expect(stripTrailingExtractors("cat app.log | tail -f")).toBeUndefined();
    });

    it("refuses `journalctl -f` and an un-counted `ping`", () => {
      expect(stripTrailingExtractors("journalctl -f | head -20")).toBeUndefined();
      expect(stripTrailingExtractors("ping example.com | head -5")).toBeUndefined();
    });

    it("still strips when the producer is bounded", () => {
      const r = stripTrailingExtractors("timeout 5 tail -f /tmp/x.log | head -20");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["head"]);
      expect(r!.cleaned).toBe("timeout 5 tail -f /tmp/x.log");

      const ping = stripTrailingExtractors("ping -c 3 example.com | head -5");
      expect(ping).toBeDefined();
      expect(ping!.removedNames).toEqual(["head"]);
    });

    it("does not confuse `grep -f patterns` with a follow", () => {
      const r = stripTrailingExtractors("grep -f patterns.txt src/*.ts | head -10");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["head"]);
    });
  });

  // ── Redirections: `<` / `>` travel with their command ─────────────────

  describe("redirections", () => {
    it("strips a trailing view while keeping an input redirect on the cleaned command", () => {
      const r = stripTrailingExtractors("grep foo < input.txt | head -5");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["head"]);
      expect(r!.removedPipeline).toBe("head -5");
      expect(r!.cleaned).toBe("grep foo < input.txt");
    });

    it("keeps an input redirect on the cleaned command when several views are stripped", () => {
      const r = stripTrailingExtractors("cat < in.txt | grep x | tail -2");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["grep", "tail"]);
      expect(r!.removedPipeline).toBe("grep x | tail -2");
      expect(r!.cleaned).toBe("cat < in.txt");
    });

    it("keeps an output redirect on the cleaned command out of the extracted pipeline", () => {
      const r = stripTrailingExtractors("npm test > out.txt | head -5");
      expect(r).toBeDefined();
      expect(r!.cleaned).toBe("npm test > out.txt");
      expect(r!.removedNames).toEqual(["head"]);
      expect(r!.removedPipeline).toBe("head -5");
    });

    it("moves an output redirect that sits on the trailing view into removedPipeline", () => {
      // The redirect belongs to `head`, so it is re-applied with the view
      // rather than left on the cleaned command.
      const r = stripTrailingExtractors("npm test | head -5 > out.txt");
      expect(r).toBeDefined();
      expect(r!.cleaned).toBe("npm test");
      expect(r!.removedNames).toEqual(["head"]);
      expect(r!.removedPipeline).toBe("head -5 > out.txt");
    });

    it("strips a view after a combined stderr+stdout redirect", () => {
      const r = stripTrailingExtractors("npm test 2>&1 > out.log | tail -20");
      expect(r).toBeDefined();
      expect(r!.cleaned).toBe("npm test 2>&1 > out.log");
      expect(r!.removedNames).toEqual(["tail"]);
      expect(r!.removedPipeline).toBe("tail -20");
    });

    it("leaves a standalone extractor with an input redirect untouched", () => {
      // `head -5 < file` is the whole command, not a trailing pipeline step.
      expect(stripTrailingExtractors("head -5 < file")).toBeUndefined();
    });

    it("leaves a command with only an input redirect untouched", () => {
      expect(stripTrailingExtractors("cat < file")).toBeUndefined();
    });
  });

  // ── Background operator `&` ──────────────────────────────────────────

  describe("background operator &", () => {
    it("leaves an earlier backgrounded statement untouched (its output can interleave)", () => {
      // A backgrounded job inherits the script's stdout, so its output can
      // interleave with the final pipeline and would be caught by the
      // re-applied extractor.
      expect(stripTrailingExtractors("command a | head & command b | tail")).toBeUndefined();
    });

    it("leaves multiple earlier backgrounded pipelines untouched", () => {
      expect(stripTrailingExtractors("cmd | head & cmd2 | tail & cmd3 | grep x")).toBeUndefined();
    });

    it("does not strip when the final statement itself is backgrounded", () => {
      // Slicing out `head` here would drop the trailing `&` and turn the
      // background job into a foreground one.
      expect(stripTrailingExtractors("command a | head &")).toBeUndefined();
      expect(stripTrailingExtractors("npm test 2>&1 | tail -20 &")).toBeUndefined();
      expect(stripTrailingExtractors("npm test 2>&1 | tail -20 > out.txt &")).toBeUndefined();
    });

    it("leaves an earlier backgrounded view alone when the last statement is not a pipeline", () => {
      const r = stripTrailingExtractors("command a | head -5 & command b");
      expect(r).toBeUndefined();
    });

    it("leaves a backgrounded subshell before a view untouched", () => {
      expect(stripTrailingExtractors("(command a | head) & command b | tail")).toBeUndefined();
    });
  });

  // ── Multi-statement / bracket safety ───────────────────────────────

  describe("multi-statement and bracket safety", () => {
    it("leaves the reported `a | head && b | tail` case untouched", () => {
      expect(
        stripTrailingExtractors("slow-command-a | head -n 10 && slow-command-b | tail -n 20"),
      ).toBeUndefined();
    });

    it("leaves `a && b | head` untouched (head would capture a, not b)", () => {
      expect(stripTrailingExtractors("a && b | head")).toBeUndefined();
    });

    it("leaves `a && b | tail` untouched", () => {
      expect(stripTrailingExtractors("a && b | tail")).toBeUndefined();
    });

    it("leaves `a | head; b | tail` untouched", () => {
      expect(stripTrailingExtractors("a | head; b | tail")).toBeUndefined();
    });

    it("leaves `a | head || b | tail` untouched", () => {
      expect(stripTrailingExtractors("a | head || b | tail")).toBeUndefined();
    });

    it("leaves `(a | head) && (b | tail)` untouched", () => {
      expect(stripTrailingExtractors("(a | head) && (b | tail)")).toBeUndefined();
    });

    it("leaves `{ a | head; } && { b | tail; }` untouched", () => {
      expect(stripTrailingExtractors("{ a | head; } && { b | tail; }")).toBeUndefined();
    });

    it("leaves `a && (b | tail)` untouched", () => {
      expect(stripTrailingExtractors("a && (b | tail)")).toBeUndefined();
    });

    it("leaves `(a | head) && b | tail` untouched", () => {
      expect(stripTrailingExtractors("(a | head) && b | tail")).toBeUndefined();
    });

    it("strips a view after a grouped producer: `(a | head && b) | tail`", () => {
      // A Subshell as the producer of a single pipeline is exactly what the
      // extractor consumed, so stripping is faithful.
      const r = stripTrailingExtractors("(a | head && b) | tail");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["tail"]);
      expect(r!.removedPipeline).toBe("tail");
      expect(r!.cleaned).toBe("(a | head && b)");
    });

    it("strips a view after a subshell producer: `(a; b) | head`", () => {
      const r = stripTrailingExtractors("(a; b) | head");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["head"]);
      expect(r!.cleaned).toBe("(a; b)");
    });

    it("strips a view after a brace-group producer: `{ a; b; } | head`", () => {
      const r = stripTrailingExtractors("{ a; b; } | head");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["head"]);
      expect(r!.cleaned).toBe("{ a; b; }");
    });

    it("leaves a bracketed trailing command untouched: `a | (head)`", () => {
      expect(stripTrailingExtractors("a | (head)")).toBeUndefined();
    });
  });

  // ── Silent prefixes may still be stripped ──────────────────────────

  describe("silent prefix", () => {
    it("strips after an assignment prefix", () => {
      const r = stripTrailingExtractors("FOO=bar && npm test | tail -5");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["tail"]);
      expect(r!.cleaned).toBe("FOO=bar && npm test");
    });

    it("strips after `cd`", () => {
      const r = stripTrailingExtractors("cd /tmp && npm test | tail -5");
      expect(r).toBeDefined();
      expect(r!.cleaned).toBe("cd /tmp && npm test");
    });

    it("strips after a `cd` statement separated by `;`", () => {
      const r = stripTrailingExtractors("cd /tmp; npm test | head -5");
      expect(r).toBeDefined();
      expect(r!.cleaned).toBe("cd /tmp; npm test");
    });

    it("strips after `true`/`test` prefixes", () => {
      expect(stripTrailingExtractors("true && npm test | tail")).toBeDefined();
      expect(stripTrailingExtractors("test -f x && npm test | tail")).toBeDefined();
    });

    it("does not treat `export` as silent (it prints when called bare)", () => {
      expect(stripTrailingExtractors("export FOO=1 && npm test | tail")).toBeUndefined();
    });

    it("does not treat a merged-stderr prefix as silent", () => {
      expect(stripTrailingExtractors("cd /nonexistent 2>&1 && npm test | tail")).toBeUndefined();
    });

    it("does not treat a grouped prefix as silent", () => {
      expect(stripTrailingExtractors("(cd /tmp) && npm test | tail")).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// classifyExtractor
// ---------------------------------------------------------------------------

describe("classifyExtractor", () => {
  it("classifies view extractors", () => {
    for (const name of VIEW_EXTRACTORS) {
      expect(classifyExtractor(name)).toBe("view");
    }
    expect(classifyExtractor("head")).toBe("view");
    expect(classifyExtractor("tail")).toBe("view");
    expect(classifyExtractor("grep")).toBe("view");
    expect(classifyExtractor("rg")).toBe("view");
  });

  it("classifies transform extractors", () => {
    for (const name of TRANSFORM_EXTRACTORS) {
      expect(classifyExtractor(name)).toBe("transform");
    }
    expect(classifyExtractor("sed")).toBe("transform");
    expect(classifyExtractor("awk")).toBe("transform");
    expect(classifyExtractor("sort")).toBe("transform");
    expect(classifyExtractor("jq")).toBe("transform");
  });

  it("returns undefined for non-extractors", () => {
    expect(classifyExtractor("npm")).toBeUndefined();
    expect(classifyExtractor("cat")).toBeUndefined();
    expect(classifyExtractor("bash")).toBeUndefined();
    expect(classifyExtractor("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractFullOutputPath
// ---------------------------------------------------------------------------

describe("extractFullOutputPath", () => {
  it("extracts path from truncated output", () => {
    const text = "some output\n\n[Showing lines 1-100 of 500. Full output: /tmp/pi-bash-abc123]";
    expect(extractFullOutputPath(text)).toBe("/tmp/pi-bash-abc123");
  });

  it("extracts path from bytes-limited truncation", () => {
    const text = "some output\n\n[Showing lines 1-100 of 500 (50KB limit). Full output: /tmp/pi-bash-xyz]";
    expect(extractFullOutputPath(text)).toBe("/tmp/pi-bash-xyz");
  });

  it("extracts path from last-line truncation", () => {
    const text = "output\n\n[Showing last 50KB of line 500 (line is 1.2MB). Full output: /tmp/pi-bash-foo]";
    expect(extractFullOutputPath(text)).toBe("/tmp/pi-bash-foo");
  });

  it("returns undefined for non-truncated output", () => {
    expect(extractFullOutputPath("no truncation here")).toBeUndefined();
  });

  it("returns undefined for error without truncation", () => {
    expect(extractFullOutputPath("error output\n\nCommand exited with code 1")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(extractFullOutputPath("")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Hoisted statements (side channels)
// ---------------------------------------------------------------------------

describe("stripTrailingExtractors hoisting", () => {
  const sinks = { prefix: "/tmp/pfx.out", suffix: "/tmp/sfx.out" };

  it("hoists a non-silent AndOr prefix", () => {
    const command =
      'cd /Users/chenjiajun/projects/gf-trader-app && echo "=== tscheck ===" && ' +
      'timeout 900 npm exec flh -- --tscheck --only-changes 2>&1 | tail -12';
    const r = stripTrailingExtractors(command, sinks)!;

    // `cleaned` stays sink-free: it is what the contract publishes.
    expect(r.cleaned).toBe(
      'cd /Users/chenjiajun/projects/gf-trader-app && echo "=== tscheck ===" && ' +
        'timeout 900 npm exec flh -- --tscheck --only-changes 2>&1',
    );
    expect(r.execCommand).toBe(
      "cd /Users/chenjiajun/projects/gf-trader-app && " +
        `{ echo "=== tscheck ==="\n} >> '${sinks.prefix}' 2>&1 && ` +
        "timeout 900 npm exec flh -- --tscheck --only-changes 2>&1",
    );
    expect(r.removedPipeline).toBe("tail -12");
    expect(r.hoistedPrefix).toEqual(['echo "=== tscheck ==="']);
    expect(r.hoistedSuffix).toEqual([]);
    expect(r.hasFollowingStatement).toBe(false);
  });

  it("refuses a trailing statement that reads `$?` instead of printing a wrong status", () => {
    // bash: `printf 'a\n' | grep nomatch; echo "R=$?"` prints R=1. Stripping
    // the extractor would make `$?` observe `printf` (R=0), so the guard must
    // leave the command completely alone.
    expect(
      stripTrailingExtractors('npm exec flh 2>&1 | grep nomatch; echo "R=$?"', sinks),
    ).toBeUndefined();
    expect(stripTrailingExtractors("npm test | tail -5; echo ${PIPESTATUS[0]}", sinks)).toBeUndefined();
    expect(stripTrailingExtractors("npm test | tail -5; true", sinks)).toBeDefined();
  });

  it("leaves a command untouched when a `$?` suffix blocks it without sinks", () => {
    const command = 'echo "=== t ===" && npm test 2>&1 | tail -12; echo "R=$?"';
    expect(stripTrailingExtractors(command)).toBeUndefined();
    // …and with sinks too: the reason is the status read, not the missing sink.
    expect(stripTrailingExtractors(command, sinks)).toBeUndefined();
  });

  it("hoists a trailing statement that does not read the status", () => {
    const r = stripTrailingExtractors('echo "=== t ===" && npm test 2>&1 | tail -12; echo "done"', sinks)!;
    expect(r.hoistedSuffix).toEqual(['echo "done"']);
    expect(r.hasFollowingStatement).toBe(true);
  });

  it("hoists a leading statement", () => {
    const r = stripTrailingExtractors("echo hi; npm test | tail -5", sinks)!;
    expect(r.execCommand).toBe(`{ echo hi\n} >> '${sinks.prefix}' 2>&1; npm test`);
    expect(r.hoistedPrefix).toEqual(["echo hi"]);
    expect(r.hoistedSuffix).toEqual([]);
  });

  it("hoists a trailing statement", () => {
    const r = stripTrailingExtractors("npm test | tail -5; echo done", sinks)!;
    expect(r.execCommand).toBe(`npm test; { echo done\n} >> '${sinks.suffix}' 2>&1`);
    expect(r.hoistedSuffix).toEqual(["echo done"]);
  });

  it("hoists an `||` member", () => {
    const r = stripTrailingExtractors("a || b | tail -3", sinks)!;
    expect(r.execCommand).toBe(`{ a\n} >> '${sinks.prefix}' 2>&1 || b`);
  });

  it("hoists several statements in execution order", () => {
    const r = stripTrailingExtractors("echo one; echo two; npm test | tail -5; echo three", sinks)!;
    expect(r.hoistedPrefix).toEqual(["echo one", "echo two"]);
    expect(r.hoistedSuffix).toEqual(["echo three"]);
  });

  it("keeps silently-prefixed pipelines untouched (no needless sink)", () => {
    const r = stripTrailingExtractors("cd /tmp && npm test 2>&1 | tail -5", sinks)!;
    expect(r.execCommand).toBe("cd /tmp && npm test 2>&1");
    expect(r.hoistedPrefix).toEqual([]);
    expect(r.hoistedSuffix).toEqual([]);
  });

  it("refuses to hoist a statement that carries its own extractor", () => {
    expect(stripTrailingExtractors("cat x | head -3 && npm test | tail -5", sinks)).toBeUndefined();
    expect(stripTrailingExtractors("npm test | tail -5; cat x | head -3", sinks)).toBeUndefined();
  });

  it("refuses to hoist a backgrounded statement", () => {
    expect(stripTrailingExtractors("npm test | tail -5; sleep 1 &", sinks)).toBeUndefined();
    expect(stripTrailingExtractors("sleep 1 & npm test | tail -5", sinks)).toBeUndefined();
  });

  it("refuses to hoist a here-document statement", () => {
    expect(
      stripTrailingExtractors("cat <<EOF\nhi\nEOF\nnpm test | tail -5", sinks),
    ).toBeUndefined();
  });

  it("refuses when any other statement carries its own extractor", () => {
    // Whichever statement is picked as the window, the other one would have to
    // be hoisted with the shell still applying its extractor.
    expect(stripTrailingExtractors("grep x f | head -2; npm test | tail -5", sinks)).toBeUndefined();
  });

  it("flags a following statement so a failing view is not reported as a failure", () => {
    // `a | grep x; echo done` exits 0 in bash — the echo owns the status.
    expect(stripTrailingExtractors("npm test | grep x")!.hasFollowingStatement).toBe(false);
    expect(stripTrailingExtractors("npm test | grep x; echo done", sinks)!.hasFollowingStatement).toBe(true);
    expect(stripTrailingExtractors("npm test | grep x; true")!.hasFollowingStatement).toBe(true);
    // A non-silent following statement still needs a sink.
    expect(stripTrailingExtractors("npm test | grep x; echo done")).toBeUndefined();
  });

  it("strips behind a trailing silent statement without needing a sink", () => {
    // `true` writes nothing to stdout, so it can simply stay in place.
    const r = stripTrailingExtractors("npm test | tail -5; true")!;
    expect(r.execCommand).toBe("npm test; true");
    expect(r.hoistedSuffix).toEqual([]);
    expect(r.hasFollowingStatement).toBe(true);
  });
});
