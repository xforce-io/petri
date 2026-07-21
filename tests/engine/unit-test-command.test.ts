import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  isLintBundledTestWrapper,
  resolveUnitTestRunner,
  renderUnitTestCommandScript,
  runResolvedUnitTest,
} from "../../src/engine/unit-test-command.js";

function tmpWorkspace(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

      const resolved = resolveUnitTestRunner(root);
      expect(resolved.kind).toBe("pytest");
      if (resolved.kind !== "pytest") return;
      expect(resolved.runner).toMatch(/pytest/);
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
    expect(script).toMatch(/python -m pytest|pytest/);
  });

  it("code-dev pipeline.yaml embeds pure unit_test command (not lint wrapper default)", () => {
    const yamlPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../src/templates/code-dev/pipeline.yaml",
    );
    const yaml = fs.readFileSync(yamlPath, "utf-8");
    expect(yaml).toMatch(/unit_test/);
    expect(yaml).toMatch(/python -m pytest|npm test/);
    // Command body must run pure pytest/npm — comments may mention run_tests.sh as anti-pattern
    expect(yaml).toMatch(/python -m pytest &&/);
    expect(yaml).not.toMatch(/command:[\s\S]*run_tests\.sh\s+unit[\s\S]*timeout:/);
    expect(yaml).toMatch(/pure|lint/i);
  });
});
