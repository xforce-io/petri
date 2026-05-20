import { describe, it, expect } from "vitest";
import { isCommandStage, isRepeatBlock } from "../src/types.js";
import type { CommandStage, RepeatBlock, StageConfig } from "../src/types.js";

describe("isCommandStage", () => {
  it("returns true for a command stage", () => {
    const entry: CommandStage = { name: "measure", command: "python run.py" };
    expect(isCommandStage(entry)).toBe(true);
  });

  it("returns true for a command stage with an optional timeout", () => {
    const entry: CommandStage = { name: "measure", command: "python run.py", timeout: 5000 };
    expect(isCommandStage(entry)).toBe(true);
  });

  it("returns false for an agent stage", () => {
    const entry: StageConfig = { name: "design", roles: ["designer"] };
    expect(isCommandStage(entry)).toBe(false);
  });

  it("returns false for a repeat block", () => {
    const entry: RepeatBlock = {
      repeat: { name: "loop", max_iterations: 3, until: "done", stages: [] },
    };
    expect(isCommandStage(entry)).toBe(false);
    expect(isRepeatBlock(entry)).toBe(true);
  });
});
