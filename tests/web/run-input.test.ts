import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveRunInput } from "../../src/web/run-input.js";

describe("resolveRunInput (issue #23)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-input-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("S1: explicit input wins", () => {
    fs.mkdirSync(path.join(dir, ".petri"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".petri", "goal.md"), "persisted");
    const r = resolveRunInput({ projectDir: dir, explicitInput: "explicit", pipelineGoal: "pipe" });
    expect(r).toMatchObject({ input: "explicit", source: "explicit" });
  });

  it("S1: persisted goal over pipeline goal", () => {
    fs.mkdirSync(path.join(dir, ".petri"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".petri", "goal.md"), "from-file");
    const r = resolveRunInput({ projectDir: dir, explicitInput: "", pipelineGoal: "pipe" });
    expect(r).toMatchObject({ input: "from-file", source: "persisted_goal" });
  });

  it("S1: pipeline goal fallback", () => {
    const r = resolveRunInput({ projectDir: dir, explicitInput: "  ", pipelineGoal: "pipe-goal" });
    expect(r).toMatchObject({ input: "pipe-goal", source: "pipeline_goal" });
  });

  it("S1: error when nothing available", () => {
    const r = resolveRunInput({ projectDir: dir, explicitInput: "", pipelineGoal: "" });
    expect("error" in r).toBe(true);
  });
});
