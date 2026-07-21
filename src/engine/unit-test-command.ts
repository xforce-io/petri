/**
 * Pure unit-test harness selection for code-dev (#69).
 * Prefers pure runners (npm test / pytest); never defaults to lint-bundled
 * wrappers such as `tests/run_tests.sh unit` that run full-repo ruff first.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

export type UnitTestResolution =
  | { kind: "npm"; command: string; runner: string }
  | { kind: "pytest"; command: string; runner: string }
  | { kind: "none"; reason: string };

const LINT_MARKERS =
  /\b(ruff|pylint|flake8|black --check|eslint|mypy)\b/i;

/**
 * True when a shell script appears to gate tests behind a full-repo lint step.
 */
export function isLintBundledTestWrapper(scriptSource: string): boolean {
  if (!scriptSource || typeof scriptSource !== "string") return false;
  const hasLint = LINT_MARKERS.test(scriptSource);
  const hasTest =
    /\b(pytest|python\s+-m\s+pytest|npm\s+test|vitest|go\s+test)\b/i.test(
      scriptSource,
    );
  return hasLint && hasTest;
}

function readIfExists(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

function packageJsonHasTestScript(workspaceDir: string): boolean {
  const raw = readIfExists(join(workspaceDir, "package.json"));
  if (!raw) return false;
  try {
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    return typeof pkg.scripts?.test === "string" && pkg.scripts.test.trim() !== "";
  } catch {
    return false;
  }
}

function hasPytestIndicators(workspaceDir: string): boolean {
  if (existsSync(join(workspaceDir, "pytest.ini"))) return true;
  if (existsSync(join(workspaceDir, "tests"))) return true;
  const pyproject = readIfExists(join(workspaceDir, "pyproject.toml"));
  if (pyproject && /\[tool\.pytest|pytest/i.test(pyproject)) return true;
  if (existsSync(join(workspaceDir, "pyproject.toml"))) return true;
  return false;
}

/**
 * Resolve the pure unit-test runner for a source workspace.
 * Lint-bundled wrappers are detected and skipped in favor of pure pytest/npm.
 */
export function resolveUnitTestRunner(workspaceDir: string): UnitTestResolution {
  if (packageJsonHasTestScript(workspaceDir)) {
    return {
      kind: "npm",
      command: "npm test",
      runner: "npm test",
    };
  }

  // Prefer pure pytest whenever the workspace looks like a Python test tree.
  // Even if tests/run_tests.sh exists and bundles lint, harness stays pure.
  if (hasPytestIndicators(workspaceDir)) {
    const wrapperPath = join(workspaceDir, "tests", "run_tests.sh");
    const wrapper = readIfExists(wrapperPath);
    if (wrapper && isLintBundledTestWrapper(wrapper)) {
      // Explicitly avoid the wrapper — pure pytest is the unit gate.
      return {
        kind: "pytest",
        command: "python -m pytest",
        runner: "python -m pytest",
      };
    }
    return {
      kind: "pytest",
      command: "python -m pytest",
      runner: "python -m pytest",
    };
  }

  // No package.json test and no pytest indicators — fail closed.
  const wrapperOnly = readIfExists(join(workspaceDir, "tests", "run_tests.sh"));
  if (wrapperOnly && isLintBundledTestWrapper(wrapperOnly)) {
    return {
      kind: "none",
      reason:
        "unit_test: tests/run_tests.sh appears lint-bundled; configure unit_test.command to a pure test command (e.g. python -m pytest) or add package.json test / pytest suite",
    };
  }

  return {
    kind: "none",
    reason:
      "unit_test: no supported pure test runner found in source workspace; configure unit_test.command for this project",
  };
}

/**
 * Shell script embedded in code-dev pipeline unit_test.command.
 * artifactDirToken is substituted by the engine as {artifact_dir}.
 */
export function renderUnitTestCommandScript(artifactDirToken: string): string {
  // Pure harness only: npm test or python -m pytest.
  // Never defaults to tests/run_tests.sh unit (lint-bundled wrappers).
  return [
    `if [ -f package.json ] && node -e "const p=require('./package.json'); process.exit(p.scripts&&p.scripts.test?0:1)" 2>/dev/null; then`,
    `  npm test && printf '%s\\n' '{"tests_passed":true,"runner":"npm test"}' > "${artifactDirToken}/result.json";`,
    `elif [ -f pytest.ini ] || [ -f pyproject.toml ] || [ -d tests ]; then`,
    `  # pure unit gate — skip lint-bundled wrappers such as tests/run_tests.sh unit`,
    `  python -m pytest && printf '%s\\n' '{"tests_passed":true,"runner":"python -m pytest"}' > "${artifactDirToken}/result.json";`,
    `else`,
    `  echo "unit_test: no supported pure test runner found in source workspace; configure unit_test.command for this project (do not use lint-bundled wrappers as the harness unit gate)" >&2;`,
    `  exit 1;`,
    `fi`,
  ].join("\n");
}

export interface RunUnitTestOutcome {
  ok: boolean;
  runner?: string;
  reason?: string;
}

/**
 * Resolve and execute the pure unit-test command; write result.json on success.
 */
export function runResolvedUnitTest(
  workspaceDir: string,
  artifactDir: string,
): RunUnitTestOutcome {
  const resolved = resolveUnitTestRunner(workspaceDir);
  if (resolved.kind === "none") {
    return { ok: false, reason: resolved.reason };
  }

  mkdirSync(artifactDir, { recursive: true });
  try {
    execFileSync("/bin/sh", ["-c", resolved.command], {
      cwd: workspaceDir,
      stdio: "pipe",
      env: process.env,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, runner: resolved.runner, reason: message };
  }

  writeFileSync(
    join(artifactDir, "result.json"),
    JSON.stringify({ tests_passed: true, runner: resolved.runner }) + "\n",
    "utf-8",
  );
  return { ok: true, runner: resolved.runner };
}
