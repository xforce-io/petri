import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  isLintBundledTestWrapper,
  isPythonInterpreterHit,
  resolvePythonInterpreter,
  resolveUnitTestRunner,
  renderUnitTestCommandScript,
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
  it("prefers VIRTUAL_ENV over workspace and git toplevel .venv", () => {
    const workspace = tmpWorkspace("petri-py-ws-");
    const ve = tmpWorkspace("petri-py-ve-");
    const top = tmpWorkspace("petri-py-top-");
    try {
      const vePy = plantVenvPython(ve, path.join("bin", "python"));
      plantVenvPython(workspace);
      plantVenvPython(top);
      const hit = resolvePythonInterpreter({
        workspaceDir: workspace,
        env: { VIRTUAL_ENV: ve },
        gitToplevel: () => top,
      });
      expect(isPythonInterpreterHit(hit)).toBe(true);
      if (!isPythonInterpreterHit(hit)) return;
      expect(hit.source).toBe("VIRTUAL_ENV");
      expect(hit.python).toBe(vePy);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(ve, { recursive: true, force: true });
      fs.rmSync(top, { recursive: true, force: true });
    }
  });

  it("uses workspace .venv before git toplevel", () => {
    const workspace = tmpWorkspace("petri-py-ws2-");
    const top = tmpWorkspace("petri-py-top2-");
    try {
      const wsPy = plantVenvPython(workspace);
      plantVenvPython(top);
      const hit = resolvePythonInterpreter({
        workspaceDir: workspace,
        env: {},
        gitToplevel: () => top,
      });
      expect(isPythonInterpreterHit(hit)).toBe(true);
      if (!isPythonInterpreterHit(hit)) return;
      expect(hit.source).toBe("workspace.venv");
      expect(hit.python).toBe(wsPy);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
      fs.rmSync(top, { recursive: true, force: true });
    }
  });

  it("falls back to git toplevel .venv from a worktree-like workspace", () => {
    const top = tmpWorkspace("petri-py-top3-");
    const workspace = path.join(top, ".worktrees", "issue-63");
    fs.mkdirSync(workspace, { recursive: true });
    try {
      const topPy = plantVenvPython(top);
      const hit = resolvePythonInterpreter({
        workspaceDir: workspace,
        env: {},
        gitToplevel: () => top,
      });
      expect(isPythonInterpreterHit(hit)).toBe(true);
      if (!isPythonInterpreterHit(hit)) return;
      expect(hit.source).toBe("git.toplevel.venv");
      expect(hit.python).toBe(topPy);
    } finally {
      fs.rmSync(top, { recursive: true, force: true });
    }
  });

  it("misses with diagnostic tried paths when no venv exists", () => {
    const workspace = tmpWorkspace("petri-py-miss-");
    try {
      const miss = resolvePythonInterpreter({
        workspaceDir: workspace,
        env: {},
        gitToplevel: () => "/nonexistent-git-root-petri-test",
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
        gitToplevel: () => null,
      });
      expect(resolved.kind).toBe("none");
      if (resolved.kind !== "none") return;
      expect(resolved.reason).toMatch(/Tried paths|venv|unit_test\.command/i);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
