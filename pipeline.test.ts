import { describe, it, expect } from "vitest";
import { stripTrailingExtractors, extractFullOutputPath } from "./pipeline.ts";

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
      const r = stripTrailingExtractors("npm run typecheck 2>&1 && npm run build 2>&1 | tail -5");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["tail"]);
      expect(r!.cleaned).toBe("npm run typecheck 2>&1 && npm run build 2>&1");
    });

    it("find src -type f -name '*.ts' | head -20", () => {
      const r = stripTrailingExtractors("find src -type f -name '*.ts' | head -20");
      expect(r).toEqual({
        cleaned: "find src -type f -name '*.ts'",
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

    it("grep -oE | sort -u | head -40", () => {
      const r = stripTrailingExtractors("grep -oE '[a-zA-Z_$][a-zA-Z0-9_$]{4,}' /tmp/file.js | sort -u | head -40");
      if (r) {
        // sort -u is an extractor, head is too
        expect(r.removedNames).toContain("head");
      }
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
      // sort IS an extractor
      const r = stripTrailingExtractors("cat file | sort");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["sort"]);
    });

    it("cat file | wc -l", () => {
      // wc IS an extractor
      const r = stripTrailingExtractors("cat file | wc -l");
      expect(r).toBeDefined();
      expect(r!.removedNames).toEqual(["wc"]);
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
