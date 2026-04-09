import { describe, it, expect } from "vitest";
import * as path from "node:path";
import { validateProject } from "../../src/engine/validate.js";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

describe("validateProject", () => {
  it("returns valid for a correct project", () => {
    const result = validateProject(path.join(FIXTURES, "valid-project"));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns errors when pipeline references missing role", () => {
    const result = validateProject(path.join(FIXTURES, "missing-role"));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("ghost_role");
  });
});
