# Command Stage Artifact Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a `command` stage snapshot its output artifacts into the per-run directory (`runs/run-NNN/artifacts/`), so each run's command output is durably preserved instead of overwritten in the shared working directory.

**Architecture:** Mirror the existing `snapshotRoleArtifacts` (used for agent stages). Add a `snapshotCommandArtifacts` method to `Engine` and call it from `runCommandStage` right after the command succeeds (before gate evaluation, so a gate-rejected run still keeps its output).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), vitest.

**Source spec:** `docs/superpowers/specs/2026-05-20-quant-backtest-petri-run-design.md` § 3.1. This is plan 1 of 2; plan 2 (the quant-workspace landing) depends on it.

**Background:** A `command` stage writes its output to the shared `artifactBaseDir/<stage>/` directory. The engine's `clearStaleArtifacts` empties that directory at the start of every run, so run N+1 overwrites run N's command output. Agent stages avoid this because `runStage` calls `snapshotRoleArtifacts`, copying each role's artifacts into the run directory. Command stages have no equivalent — this plan adds it.

**Convention:** Commit messages end with the repo's standard `Co-Authored-By:` trailer.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/engine/engine.ts` | modify | Add `snapshotCommandArtifacts`; call it from `runCommandStage` after the command succeeds |
| `tests/engine/engine.test.ts` | modify | Test that a command stage's output appears in the run directory |

---

## Task 1: Snapshot command-stage output into the run directory

**Files:**
- Modify: `src/engine/engine.ts`
- Test: `tests/engine/engine.test.ts`

- [ ] **Step 1: Write the failing test**

Append this test inside the `describe("Engine", ...)` block in `tests/engine/engine.test.ts`:

```typescript
  it("snapshots a command stage's output into the run directory", async () => {
    const pipeline: PipelineConfig = {
      name: "cmd-snapshot",
      stages: [
        { name: "measure", command: "echo '{\"ok\": true}' > {artifact_dir}/result.json" },
      ],
    };
    const logger = new RunLogger(tmpDir, pipeline.name, "go");
    const engine = new Engine({
      provider: createStubProvider(() => {}),
      roles: {},
      artifactBaseDir: path.join(tmpDir, "artifacts"),
      logger,
    });
    const result = await engine.run(pipeline, "go");
    logger.finish(result.status, result.stage, result.reason);

    expect(result.status).toBe("done");
    const snapshot = path.join(logger.runDir, "artifacts", "001-measure", "result.json");
    expect(fs.existsSync(snapshot)).toBe(true);
    expect(JSON.parse(fs.readFileSync(snapshot, "utf-8"))).toEqual({ ok: true });
  });
```

`RunLogger` is already imported at the top of `tests/engine/engine.test.ts` (the existing "snapshots each role artifact" test uses it). `fs` and `path` are also already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/engine.test.ts -t "snapshots a command stage"`
Expected: FAIL — `runCommandStage` never copies output into the run directory, so the snapshot file does not exist.

- [ ] **Step 3: Add the `snapshotCommandArtifacts` method**

In `src/engine/engine.ts`, add this method to the `Engine` class, immediately after the existing `snapshotRoleArtifacts` method (and before the class's closing `}`):

```typescript
  /**
   * Snapshot a command stage's output artifacts into the run directory.
   * Command stages have no role dimension, so the snapshot directory is
   * just artifacts/{seq}-{stage}/. Mirrors snapshotRoleArtifacts.
   */
  private snapshotCommandArtifacts(stageName: string, artifactDir: string): void {
    if (!this.logger) return;

    const files = resolveArtifactFiles(artifactDir, []);
    if (files.length === 0) return;

    const seq = String(++this.artifactSnapshotSeq).padStart(3, "0");
    const snapshotDir = join(
      this.logger.runDir,
      "artifacts",
      `${seq}-${safePathPart(stageName)}`,
    );
    mkdirSync(snapshotDir, { recursive: true });

    const copied: string[] = [];
    for (const file of files) {
      const dest = uniqueDestination(snapshotDir, basename(file));
      try {
        copyFileSync(file, dest);
        copied.push(dest);
      } catch {
        // Best-effort archival should not affect pipeline execution.
      }
    }

    writeFileSync(join(snapshotDir, "_snapshot.json"), JSON.stringify({
      sequence: Number(seq),
      stage: stageName,
      kind: "command",
      source_artifact_dir: artifactDir,
      source_files: files,
      copied_files: copied,
      created_at: new Date().toISOString(),
    }, null, 2), "utf-8");
  }
```

This reuses the module-level helpers `resolveArtifactFiles`, `safePathPart`, and `uniqueDestination`, and the `basename`, `copyFileSync`, `mkdirSync`, `writeFileSync`, `join` imports — all already present in `engine.ts`. `resolveArtifactFiles(artifactDir, [])` with an empty artifact list reads every top-level file in the directory.

- [ ] **Step 4: Call it from `runCommandStage`**

In `src/engine/engine.ts`, `runCommandStage` currently has, right after the `execSync` try/catch block, a comment line `// The command ran. If it declares a gate, evaluate it against the output.` followed by `if (stage.gate) {`. Insert the snapshot call between the `catch` block's closing `}` and that comment, so the relevant section reads:

```typescript
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  Command stage "${stage.name}" FAILED: ${message}`);
      return { status: "blocked", stage: stage.name, reason: `Command failed: ${message}` };
    }

    // Snapshot the command's output into the run directory before the gate
    // runs — a gate-rejected run still keeps its output for the lineage.
    this.snapshotCommandArtifacts(stage.name, artifactDir);

    // The command ran. If it declares a gate, evaluate it against the output.
    if (stage.gate) {
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/engine/engine.test.ts`
Expected: PASS — all Engine tests, including the new snapshot test.

Run: `npx tsc --noEmit`
Expected: the ONLY error is the pre-existing `src/web/routes/sse.ts(37,7): 'logger' is possibly 'undefined'`. Any other error is a regression — fix it.

- [ ] **Step 6: Commit**

```bash
git add src/engine/engine.ts tests/engine/engine.test.ts
git commit -m "feat(engine): snapshot command-stage output into the run directory"
```

---

## Manual verification

In a scratch petri project with a `command` stage that writes a file to `{artifact_dir}`, run `petri run` and confirm the file is copied into `.petri/runs/run-NNN/artifacts/NNN-<stage>/` (alongside a `_snapshot.json`).

---

## Out of scope (later)

- Rich `RunLogger` structured stage records for command stages (`petri status` still does not list command stages — separate concern, deferred by the original command-stage plan).
- Snapshotting partial output when a command crashes (only successful command runs are snapshotted).
