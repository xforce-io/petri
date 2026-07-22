import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  isLintBundledTestWrapper,
  isPythonInterpreterHit,
  resolveGitMainWorktreeRoot,
  resolvePythonInterpreter,
  resolveUnitTestRunner,
  renderUnitTestCommandScript,
  renderPythonDiscoveryShell,
  runResolvedUnitTest,
} from "../../src/engine/unit-test-command.js";

function tmpWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Create a fake .venv/bin/python (or Scripts/python.exe) so discovery succeeds. */
function plantVenvPython(root: string, rel = path.join(".venv", "bin", "python")): string {
  const py = path.join(root, rel);
  fs.mkdirSync(path.dirname(py), { recursive: true });
  fs.writeFileSync(py, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return py;
}

describe("unit-test-command pure harness selection (#69)", () => {
  it("detects lint-bundled wrappers such as ruff-before-pytest run_tests.sh", () => {
    const script = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "unit" ]; then
  ruff check .
  python -m pytest
fi
`;
    expect(isLintBundledTestWrapper(script)).toBe(true);
    expect(isLintBundledTestWrapper("python -m pytest -q\n")).toBe(false);
  });

  it("prefers pure pytest over lint-bundled tests/run_tests.sh when both exist", () => {
    const root = tmpWorkspace("petri-ut-pref-");
    try {
      const py = plantVenvPython(root);
      fs.mkdirSync(path.join(root, "tests"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "tests", "test_ok.py"),
        "def test_ok():\n    assert True\n",
      );
      // Unrelated lint noise that would fail full-repo ruff
      fs.writeFileSync(path.join(root, "noise.py"), "import os,sys\n");
      fs.writeFileSync(
        path.join(root, "tests", "run_tests.sh"),
        `#!/usr/bin/env bash
set -euo pipefail
ruff check .
python -m pytest
`,
        { mode: 0o755 },
      );

      const resolved = resolveUnitTestRunner(root, {
        env: {},
        gitToplevel: () => root,
      });
      expect(resolved.kind).toBe("pytest");
      if (resolved.kind !== "pytest") return;
      expect(resolved.runner).toMatch(/pytest/);
      expect(resolved.python).toBe(py);
      expect(resolved.command).toContain(py);
      expect(resolved.command).not.toMatch(/run_tests\.sh/);
      expect(isLintBundledTestWrapper(
        fs.readFileSync(path.join(root, "tests", "run_tests.sh"), "utf-8"),
      )).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("still yields tests_passed when lint wrapper would fail but pure suite is green", () => {
    const root = tmpWorkspace("petri-ut-green-");
    const artifactDir = path.join(root, "artifact");
    fs.mkdirSync(artifactDir, { recursive: true });
    try {
      // Fake project venv python: treat `python -m pytest` as success (pure gate path).
      const pyDir = path.join(root, ".venv", "bin");
      fs.mkdirSync(pyDir, { recursive: true });
      fs.writeFileSync(
        path.join(pyDir, "python"),
        `#!/bin/sh
# minimal stub: success for -m pytest (unit gate), fail otherwise
if [ "$1" = "-m" ] && [ "$2" = "pytest" ]; then exit 0; fi
exit 1
`,
        { mode: 0o755 },
      );
      fs.mkdirSync(path.join(root, "tests"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "tests", "test_ok.py"),
        "def test_ok():\n    assert 1 + 1 == 2\n",
      );
      // Fail ruff (unused import / E401 style noise)
      fs.writeFileSync(
        path.join(root, "lint_noise.py"),
        "import   os,sys\nx=1\n",
      );
      const wrapper = path.join(root, "tests", "run_tests.sh");
      fs.writeFileSync(
        wrapper,
        `#!/usr/bin/env bash
set -euo pipefail
echo "lint fail" >&2
exit 1
python -m pytest
`,
        { mode: 0o755 },
      );

      // Wrapper path fails (simulates lint-before-test)
      expect(() =>
        execFileSync("/bin/sh", ["-c", `"${wrapper}" unit`], {
          cwd: root,
          stdio: "pipe",
        }),
      ).toThrow();

      const outcome = runResolvedUnitTest(root, artifactDir);
      expect(outcome.ok).toBe(true);
      expect(outcome.runner).toMatch(/pytest|npm/);
      const result = JSON.parse(
        fs.readFileSync(path.join(artifactDir, "result.json"), "utf-8"),
      );
      expect(result.tests_passed).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders a pipeline script that never defaults to lint-bundled run_tests.sh unit", () => {
    const script = renderUnitTestCommandScript("{artifact_dir}");
    expect(script).toMatch(/pytest|npm test/);
    // Executable lines must not invoke the wrapper (comments may warn against it)
    const executable = script
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return t && !t.startsWith("#") && !t.startsWith("echo ");
      })
      .join("\n");
    expect(executable).not.toMatch(/run_tests\.sh/);
    expect(script).toMatch(/\$PY.*-m pytest|pytest/);
    expect(script).toMatch(/VIRTUAL_ENV|git rev-parse/);
  });

  it("code-dev pipeline.yaml embeds pure unit_test command (not lint wrapper default)", () => {
    const yamlPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/templates/code-dev/pipeline.yaml",
    );
    const yaml = fs.readFileSync(yamlPath, "utf-8");
    expect(yaml).toMatch(/unit_test/);
    expect(yaml).toMatch(/pytest|npm test/);
    // Command body must run pure pytest via discovered PY — not lint wrapper
    expect(yaml).toMatch(/"\$PY" -m pytest|\$PY -m pytest/);
    expect(yaml).not.toMatch(/command:[\s\S]*run_tests\.sh\s+unit[\s\S]*timeout:/);
    expect(yaml).toMatch(/pure|lint|venv/i);
  });
});

describe("Python interpreter discovery (#75)", () => {
  it("prefers VIRTUAL_ENV over workspace and main-repo .venv", () => {
    const workspace = tmpWorkspace("petri-py-ws-");
    const ve = tmpWorkspace("petri-py-ve-");
    const main = tmpWorkspace("petri-py-main-");
    try {
      const vePy = plantVenvPython(ve, path.join("bin", "python"));
      plantVenvPython(workspace);
      plantVenvPython(main);
      const hit = resolvePythonInterpreter({
        workspaceDir: workspace,
        env: { VIRTUAL_ENV: ve },
        gitMainRoot: () => main,
      });
      expect(isPythonInterpreterHit(hit)).toBe(true);
      if (!isPythonInterpreterHit(hit)) return;
      expect(hit.source).toBe("VIRTUAL_ENV");
      expect(hit.python).toBe(vePy);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(ve, { recursive: true, force: true });
      fs.rmSync(main, { recursive: true, force: true });
    }
  });

  it("uses workspace .venv before main-repo .venv", () => {
    const workspace = tmpWorkspace("petri-py-ws2-");
    const main = tmpWorkspace("petri-py-main2-");
    try {
      const wsPy = plantVenvPython(workspace);
      plantVenvPython(main);
      const hit = resolvePythonInterpreter({
        workspaceDir: workspace,
        env: {},
        gitMainRoot: () => main,
      });
      expect(isPythonInterpreterHit(hit)).toBe(true);
      if (!isPythonInterpreterHit(hit)) return;
      expect(hit.source).toBe("workspace.venv");
      expect(hit.python).toBe(wsPy);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(main, { recursive: true, force: true });
    }
  });

  it("falls back to main-repo .venv via gitMainRoot inject", () => {
    const main = tmpWorkspace("petri-py-main3-");
    const workspace = path.join(main, ".worktrees", "issue-63");
    fs.mkdirSync(workspace, { recursive: true });
    try {
      const mainPy = plantVenvPython(main);
      const hit = resolvePythonInterpreter({
        workspaceDir: workspace,
        env: {},
        gitMainRoot: () => main,
      });
      expect(isPythonInterpreterHit(hit)).toBe(true);
      if (!isPythonInterpreterHit(hit)) return;
      expect(hit.source).toBe("git.main.venv");
      expect(hit.python).toBe(mainPy);
    } finally {
      fs.rmSync(main, { recursive: true, force: true });
    }
  });

  it("REAL git worktree: discovers main-repo .venv without mocked gitMainRoot", () => {
    // Reproduces cortex case: deps in main .venv, unit_test cwd is linked worktree.
    // show-toplevel would return the worktree path and miss main .venv.
    const main = tmpWorkspace("petri-real-main-");
    const wtPath = path.join(main, ".worktrees", "issue-75");
    try {
      execFileSync("git", ["init"], { cwd: main, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "t@t.com"], {
        cwd: main,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "t"], {
        cwd: main,
        stdio: "ignore",
      });
      fs.writeFileSync(path.join(main, "README.md"), "base\n");
      fs.mkdirSync(path.join(main, "tests"), { recursive: true });
      fs.writeFileSync(path.join(main, "tests", "test_ok.py"), "def test_ok():\n  assert True\n");
      execFileSync("git", ["add", "."], { cwd: main, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: main, stdio: "ignore" });

      const mainPy = plantVenvPython(main);
      fs.mkdirSync(path.join(main, ".worktrees"), { recursive: true });
      execFileSync("git", ["worktree", "add", wtPath, "HEAD"], {
        cwd: main,
        stdio: "ignore",
      });

      const real = (p: string) => fs.realpathSync(path.resolve(p));

      // Prove show-toplevel is the worktree (the bug class) while main root differs
      const showTop = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        cwd: wtPath,
      }).trim();
      expect(real(showTop)).toBe(real(wtPath));
      expect(real(showTop)).not.toBe(real(main));

      const mainFromGit = resolveGitMainWorktreeRoot(wtPath);
      expect(mainFromGit).not.toBeNull();
      expect(real(mainFromGit!)).toBe(real(main));

      // Unmocked discovery from worktree cwd
      const hit = resolvePythonInterpreter({
        workspaceDir: wtPath,
        env: {}, // no VIRTUAL_ENV
      });
      expect(isPythonInterpreterHit(hit)).toBe(true);
      if (!isPythonInterpreterHit(hit)) return;
      expect(hit.source).toBe("git.main.venv");
      expect(real(hit.python)).toBe(real(mainPy));

      // Shell discovery used by pipeline must use git-common-dir for main root
      const shell = renderPythonDiscoveryShell();
      expect(shell).toMatch(/git-common-dir/);
      // Must not *invoke* show-toplevel for path resolution
      expect(shell).not.toMatch(/rev-parse[^\n]*show-toplevel/);

      // Execute the real shell snippet from the worktree (main has .venv only)
      const script = `${shell} echo "PY=\$PY"`;
      const out = execFileSync("/bin/sh", ["-c", script], {
        encoding: "utf8",
        cwd: wtPath,
        env: { ...process.env, VIRTUAL_ENV: "" },
      });
      expect(out).toMatch(/PY=/);
      const pyLine = out.trim().split("\n").find((l) => l.startsWith("PY="));
      expect(pyLine).toBeDefined();
      const pyPath = pyLine!.slice(3);
      expect(real(pyPath)).toBe(real(mainPy));

      // pipeline.yaml must not use show-toplevel for main .venv
      const yaml = fs.readFileSync(
        path.join(process.cwd(), "src/templates/code-dev/pipeline.yaml"),
        "utf-8",
      );
      expect(yaml).toMatch(/git-common-dir/);
      // Avoid show-toplevel in the discovery branch (comments may still mention it)
      const discovery = yaml.slice(yaml.indexOf("PY=\"\";"), yaml.indexOf("\"$PY\" -m pytest"));
      expect(discovery).not.toMatch(/show-toplevel/);
      expect(discovery).toMatch(/git-common-dir/);
    } finally {
      try {
        execFileSync("git", ["worktree", "remove", "--force", wtPath], {
          cwd: main,
          stdio: "ignore",
        });
      } catch {
        /* ignore */
      }
      fs.rmSync(main, { recursive: true, force: true });
    }
  });

  it("misses with diagnostic tried paths when no venv exists", () => {
    const workspace = tmpWorkspace("petri-py-miss-");
    try {
      const miss = resolvePythonInterpreter({
        workspaceDir: workspace,
        env: {},
        gitMainRoot: () => "/nonexistent-git-root-petri-test",
        fileExists: () => false,
      });
      expect(isPythonInterpreterHit(miss)).toBe(false);
      if (isPythonInterpreterHit(miss)) return;
      expect(miss.error).toMatch(/no project Python venv|unit_test\.command/i);
      expect(miss.tried.length).toBeGreaterThan(0);
      expect(miss.tried.some((p) => p.includes(".venv"))).toBe(true);

      fs.mkdirSync(path.join(workspace, "tests"), { recursive: true });
      const resolved = resolveUnitTestRunner(workspace, {
        env: {},
        fileExists: () => false,
        gitMainRoot: () => null,
      });
      expect(resolved.kind).toBe("none");
      if (resolved.kind !== "none") return;
      expect(resolved.reason).toMatch(/Tried paths|venv|unit_test\.command/i);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
