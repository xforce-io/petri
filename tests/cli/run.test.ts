import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunLogger } from "../../src/engine/logger.js";
import { resolveResumeSource } from "../../src/cli/run.js";

describe("petri run --resume-run", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-run-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("requires --skip-to and records a normalized existing source run", () => {
    const petriDir = path.join(tmpDir, ".petri");
    const source = new RunLogger(petriDir, "code-dev", "Issue #51");
    source.finish("blocked", "develop", "retry");

    expect(resolveResumeSource(petriDir, "1", "unit_test")).toEqual({
      runId: "001",
      stage: "unit_test",
    });
    expect(() => resolveResumeSource(petriDir, "001", undefined)).toThrow(/--skip-to/);
    expect(() => resolveResumeSource(petriDir, "999", "unit_test")).toThrow(/not found/);
  });
});
