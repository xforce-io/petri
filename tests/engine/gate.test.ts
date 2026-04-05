import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveGatePath, checkGates, GateInput, GateResult } from "../../src/engine/gate.js";
import { GateConfig } from "../../src/types.js";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "petri-gate-test-"));
}

describe("resolveGatePath", () => {
  it("replaces {stage} and {role} placeholders", () => {
    const result = resolveGatePath("artifacts/{stage}/{role}/output.json", "review", "critic");
    expect(result).toBe("artifacts/review/critic/output.json");
  });

  it("returns template unchanged when no placeholders", () => {
    const result = resolveGatePath("fixed/path.json", "review", "critic");
    expect(result).toBe("fixed/path.json");
  });

  it("replaces multiple occurrences", () => {
    const result = resolveGatePath("{stage}/{role}/{stage}", "s1", "r1");
    expect(result).toBe("s1/r1/s1");
  });
});

describe("checkGates", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeGate(pathTemplate: string, check?: { field: string; equals?: unknown }): GateConfig {
    return {
      requires: {},
      evidence: {
        type: "artifact",
        path: pathTemplate,
        ...(check ? { check } : {}),
      },
    };
  }

  it("passes with no gates (empty array)", async () => {
    const result = await checkGates([], "review", tmpDir, "all");
    expect(result.passed).toBe(true);
    expect(result.details).toEqual([]);
  });

  it("passes when artifact file exists (no check)", async () => {
    const artifactPath = path.join(tmpDir, "review", "critic", "output.json");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ status: "ok" }));

    const gates: GateInput[] = [
      { gate: makeGate("{stage}/{role}/output.json"), roleName: "critic" },
    ];
    const result = await checkGates(gates, "review", tmpDir, "all");
    expect(result.passed).toBe(true);
    expect(result.details[0].passed).toBe(true);
  });

  it("fails when artifact file is missing", async () => {
    const gates: GateInput[] = [
      { gate: makeGate("{stage}/{role}/output.json"), roleName: "critic" },
    ];
    const result = await checkGates(gates, "review", tmpDir, "all");
    expect(result.passed).toBe(false);
    expect(result.details[0].passed).toBe(false);
    expect(result.details[0].reason).toMatch(/not found|missing|does not exist/i);
  });

  it("passes when artifact field matches expected value", async () => {
    const artifactPath = path.join(tmpDir, "review", "critic", "output.json");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ approved: true }));

    const gates: GateInput[] = [
      {
        gate: makeGate("{stage}/{role}/output.json", { field: "approved", equals: true }),
        roleName: "critic",
      },
    ];
    const result = await checkGates(gates, "review", tmpDir, "all");
    expect(result.passed).toBe(true);
    expect(result.details[0].passed).toBe(true);
  });

  it("fails when artifact field does not match expected value", async () => {
    const artifactPath = path.join(tmpDir, "review", "critic", "output.json");
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, JSON.stringify({ approved: false }));

    const gates: GateInput[] = [
      {
        gate: makeGate("{stage}/{role}/output.json", { field: "approved", equals: true }),
        roleName: "critic",
      },
    ];
    const result = await checkGates(gates, "review", tmpDir, "all");
    expect(result.passed).toBe(false);
    expect(result.details[0].passed).toBe(false);
    expect(result.details[0].reason).toMatch(/approved/i);
  });

  it("majority strategy passes with 2/3 gates passing", async () => {
    // Create artifacts for 2 out of 3 roles
    for (const role of ["alice", "bob"]) {
      const p = path.join(tmpDir, "review", role, "output.json");
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, JSON.stringify({ done: true }));
    }

    const gates: GateInput[] = [
      { gate: makeGate("{stage}/{role}/output.json"), roleName: "alice" },
      { gate: makeGate("{stage}/{role}/output.json"), roleName: "bob" },
      { gate: makeGate("{stage}/{role}/output.json"), roleName: "charlie" },
    ];
    const result = await checkGates(gates, "review", tmpDir, "majority");
    expect(result.passed).toBe(true);
    expect(result.details.filter((d) => d.passed).length).toBe(2);
    expect(result.details.filter((d) => !d.passed).length).toBe(1);
  });

  it("majority strategy fails with 1/3 gates passing", async () => {
    const p = path.join(tmpDir, "review", "alice", "output.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ done: true }));

    const gates: GateInput[] = [
      { gate: makeGate("{stage}/{role}/output.json"), roleName: "alice" },
      { gate: makeGate("{stage}/{role}/output.json"), roleName: "bob" },
      { gate: makeGate("{stage}/{role}/output.json"), roleName: "charlie" },
    ];
    const result = await checkGates(gates, "review", tmpDir, "majority");
    expect(result.passed).toBe(false);
  });

  it("any strategy passes when at least one gate passes", async () => {
    const p = path.join(tmpDir, "review", "bob", "output.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ done: true }));

    const gates: GateInput[] = [
      { gate: makeGate("{stage}/{role}/output.json"), roleName: "alice" },
      { gate: makeGate("{stage}/{role}/output.json"), roleName: "bob" },
    ];
    const result = await checkGates(gates, "review", tmpDir, "any");
    expect(result.passed).toBe(true);
  });
});
