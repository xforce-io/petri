/**
 * Pure unit-test harness selection for code-dev (#69).
 * Prefers pure runners (npm test / pytest); never defaults to lint-bundled
 * wrappers such as `tests/run_tests.sh unit` that run full-repo ruff first.
 *
 * Python interpreter discovery for worktrees / monorepos (#75):
 * VIRTUAL_ENV → workspace/.venv → **main repo** `.venv` (via git-common-dir).
 *
 * Note: `git rev-parse --show-toplevel` in a linked worktree returns the
 * worktree path, NOT the primary checkout — so we use git-common-dir.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

export type UnitTestResolution =
  | { kind: "npm"; command: string; runner: string }
  | { kind: "pytest"; command: string; runner: string; python: string }
  | { kind: "none"; reason: string };

const LINT_MARKERS =
  /\b(ruff|pylint|flake8|black --check|eslint|mypy)\b/i;

/** Candidate locations for a project Python interpreter (issue #75). */
export type PythonInterpreterHit = {
  python: string;
  source: "VIRTUAL_ENV" | "workspace.venv" | "git.main.venv";
};

export type PythonInterpreterMiss = {
  error: string;
  tried: string[];
};

export type PythonInterpreterResult = PythonInterpreterHit | PythonInterpreterMiss;

export function isPythonInterpreterHit(
  r: PythonInterpreterResult,
): r is PythonInterpreterHit {
  return "python" in r && typeof (r as PythonInterpreterHit).python === "string";
}

/**
 * Primary (main) worktree root for a git checkout or linked worktree.
 * Uses `git rev-parse --path-format=absolute --git-common-dir` then dirname
 * of the `.git` directory — unlike `--show-toplevel`, this is the main repo
 * when cwd is a linked worktree.
 */
export function resolveGitMainWorktreeRoot(cwd: string): string | null {
  try {
    let common = "";
    try {
      common = execFileSync(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { encoding: "utf8", cwd },
      ).trim();
    } catch {
      // Older git without --path-format
      common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        encoding: "utf8",
        cwd,
      }).trim();
      if (common && !common.startsWith("/")) {
        common = resolve(cwd, common);
      }
    }
    if (!common) return null;
    const normalized = resolve(common);
    // common-dir is typically <main>/.git
    if (basename(normalized) === ".git") {
      return dirname(normalized);
    }
    return dirname(normalized);
  } catch {
    return null;
  }
}

/**
 * Resolve project Python for unit gates.
 * Order: VIRTUAL_ENV → workspaceDir/.venv → main-repo/.venv (git-common-dir).
 * Checks bin/python and Windows Scripts/python.exe.
 */
export function resolvePythonInterpreter(opts: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
  /** Inject main-repo root; default uses resolveGitMainWorktreeRoot (not show-toplevel). */
  gitMainRoot?: (cwd: string) => string | null;
  /** @deprecated Use gitMainRoot — kept for tests that still pass this name. */
  gitToplevel?: (cwd: string) => string | null;
}): PythonInterpreterResult {
  const exists = opts.fileExists ?? existsSync;
  const env = opts.env ?? process.env;
  const tried: string[] = [];
  const workspaceDir = resolve(opts.workspaceDir);

  const candidates: Array<{ path: string; source: PythonInterpreterHit["source"] }> = [];

  const virtualEnv = env.VIRTUAL_ENV?.trim();
  if (virtualEnv) {
    candidates.push(
      { path: join(virtualEnv, "bin", "python"), source: "VIRTUAL_ENV" },
      { path: join(virtualEnv, "Scripts", "python.exe"), source: "VIRTUAL_ENV" },
    );
  }

  candidates.push(
    { path: join(workspaceDir, ".venv", "bin", "python"), source: "workspace.venv" },
    {
      path: join(workspaceDir, ".venv", "Scripts", "python.exe"),
      source: "workspace.venv",
    },
  );

  const resolveMain =
    opts.gitMainRoot ?? opts.gitToplevel ?? resolveGitMainWorktreeRoot;
  const mainRoot = resolveMain(workspaceDir);

  if (mainRoot) {
    const main = resolve(mainRoot);
    if (main !== workspaceDir) {
      candidates.push(
        { path: join(main, ".venv", "bin", "python"), source: "git.main.venv" },
        {
          path: join(main, ".venv", "Scripts", "python.exe"),
          source: "git.main.venv",
        },
      );
    }
  } else {
    tried.push("(git main worktree root unresolved — not a git repo or git-common-dir failed)");
  }

  for (const c of candidates) {
    tried.push(c.path);
    if (exists(c.path)) {
      return { python: c.path, source: c.source };
    }
  }

  return {
    error:
      "unit_test: no project Python venv found for pytest. " +
      "Tried: VIRTUAL_ENV, workspace/.venv, main-repo/.venv (via git-common-dir). " +
      "Create a venv with project deps, activate it, or set unit_test.command to an absolute interpreter " +
      "(e.g. /path/to/.venv/bin/python -m pytest).",
    tried,
  };
}

/**
 * Shell snippet: set PY to discovered project python or exit with diagnostics (#75).
 * Main-repo root via git-common-dir (not show-toplevel) so linked worktrees see main .venv.
 */
export function renderPythonDiscoveryShell(): string {
  return [
    `PY="";`,
    `if [ -n "\${VIRTUAL_ENV:-}" ] && [ -x "\$VIRTUAL_ENV/bin/python" ]; then PY="\$VIRTUAL_ENV/bin/python";`,
    `elif [ -n "\${VIRTUAL_ENV:-}" ] && [ -x "\$VIRTUAL_ENV/Scripts/python.exe" ]; then PY="\$VIRTUAL_ENV/Scripts/python.exe";`,
    `elif [ -x .venv/bin/python ]; then PY=".venv/bin/python";`,
    `elif [ -x .venv/Scripts/python.exe ]; then PY=".venv/Scripts/python.exe";`,
    `else`,
    `  COMMON=\$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || git rev-parse --git-common-dir 2>/dev/null || true);`,
    `  MAIN="";`,
    `  if [ -n "\$COMMON" ]; then`,
    `    case "\$COMMON" in`,
    `      /*) ;;`,
    `      *) COMMON="\$(pwd)/\$COMMON" ;;`,
    `    esac;`,
    `    MAIN=\$(dirname "\$COMMON");`,
    `  fi;`,
    `  if [ -n "\$MAIN" ] && [ -x "\$MAIN/.venv/bin/python" ]; then PY="\$MAIN/.venv/bin/python";`,
    `  elif [ -n "\$MAIN" ] && [ -x "\$MAIN/.venv/Scripts/python.exe" ]; then PY="\$MAIN/.venv/Scripts/python.exe";`,
    `  fi;`,
    `fi;`,
    `if [ -z "\$PY" ]; then`,
    `  echo "unit_test: no project Python venv found. Tried: VIRTUAL_ENV, .venv, main-repo/.venv via git-common-dir. Configure unit_test.command to an absolute interpreter (e.g. /path/to/.venv/bin/python -m pytest)." >&2;`,
    `  exit 1;`,
    `fi;`,
  ].join(" ");
}

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
 * Pytest uses discovered project venv python when available (#75).
 */
export function resolveUnitTestRunner(
  workspaceDir: string,
  opts?: {
    env?: NodeJS.ProcessEnv;
    fileExists?: (path: string) => boolean;
    gitToplevel?: (cwd: string) => string | null;
  },
): UnitTestResolution {
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
    const py = resolvePythonInterpreter({
      workspaceDir,
      env: opts?.env,
      fileExists: opts?.fileExists,
      gitToplevel: opts?.gitToplevel,
    });
    if (!isPythonInterpreterHit(py)) {
      return {
        kind: "none",
        reason: `${py.error} Tried paths: ${py.tried.join(", ")}`,
      };
    }
    const command = `${shellQuote(py.python)} -m pytest`;
    return {
      kind: "pytest",
      command,
      runner: `${py.python} -m pytest`,
      python: py.python,
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

function shellQuote(pathStr: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(pathStr)) return pathStr;
  return `'${pathStr.replace(/'/g, `'\\''`)}'`;
}

/**
 * Shell script embedded in code-dev pipeline unit_test.command.
 * artifactDirToken is substituted by the engine as {artifact_dir}.
 * Discovers project Python for pytest (#75); does not rewrite custom commands.
 */
export function renderUnitTestCommandScript(artifactDirToken: string): string {
  // Pure harness only: npm test or venv-aware python -m pytest.
  // Never defaults to tests/run_tests.sh unit (lint-bundled wrappers).
  const discover = renderPythonDiscoveryShell();
  return [
    `if [ -f package.json ] && node -e "const p=require('./package.json'); process.exit(p.scripts&&p.scripts.test?0:1)" 2>/dev/null; then`,
    `  npm test && printf '%s\\n' '{"tests_passed":true,"runner":"npm test"}' > "${artifactDirToken}/result.json";`,
    `elif [ -f pytest.ini ] || [ -f pyproject.toml ] || [ -d tests ]; then`,
    `  # pure unit gate — skip lint-bundled wrappers; discover project venv (#75)`,
    `  ${discover}`,
    `  "\$PY" -m pytest && printf '%s\\n' "{\\"tests_passed\\":true,\\"runner\\":\\"\$PY -m pytest\\"}" > "${artifactDirToken}/result.json";`,
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
