import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Engine } from "../../src/engine/engine.js";
import type { AgentConfig, AgentProvider, LoadedRole } from "../../src/types.js";

function makeRole(): LoadedRole {
  return {
    name: "worker",
    persona: "worker",
    model: "default",
    playbooks: [],
    gate: null,
  };
}

function reviewRole(): LoadedRole {
  return {
    name: "reviewer",
    persona: "reviewer",
    model: "default",
    playbooks: [],
    gate: {
      id: "review-approved",
      evidence: {
        path: "{stage}/{role}/review.json",
        check: { field: "approved", equals: true },
      },
      contract: { type: "review" },
    },
  };
}

describe("workspace execution semantics", () => {
  it("gives agents a separate source workspace and evidence artifact directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "petri-workspace-"));
    const artifactBaseDir = path.join(root, "artifacts");
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir);
    let seen: AgentConfig | undefined;
    const provider: AgentProvider = {
      createAgent(config) {
        seen = config;
        return { async run() { return { artifacts: [] }; } };
      },
    };
    try {
      const engine = new Engine({
        provider,
        roles: { worker: makeRole() },
        artifactBaseDir,
        workspaceDir,
      });
      await engine.run({ name: "workspace", stages: [{ name: "work", roles: ["worker"] }] }, "do work");

      expect(seen?.workspaceDir).toBe(workspaceDir);
      expect(seen?.artifactDir).toBe(path.join(artifactBaseDir, "work", "worker"));
      expect(seen?.context).toContain(`Source workspace: ${workspaceDir}`);
      expect(seen?.context).toContain(`Evidence artifact directory: ${seen?.artifactDir}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs command stages in the source workspace while retaining evidence in artifacts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "petri-command-workspace-"));
    const artifactBaseDir = path.join(root, "artifacts");
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir);
    const provider: AgentProvider = { createAgent: () => ({ async run() { return { artifacts: [] }; } }) };
    try {
      const engine = new Engine({ provider, roles: {}, artifactBaseDir, workspaceDir });
      const result = await engine.run({
        name: "command-workspace",
        stages: [{
          name: "verify",
          command: 'pwd > "{artifact_dir}/cwd.txt"',
        }],
      }, "verify");

      expect(result.status).toBe("done");
      expect(fs.readFileSync(path.join(artifactBaseDir, "verify", "cwd.txt"), "utf-8").trim())
        .toBe(fs.realpathSync(workspaceDir));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes archived failed review evidence available to the next convergence iteration", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "petri-review-lineage-"));
    const artifactBaseDir = path.join(root, "artifacts");
    const workspaceDir = path.join(root, "workspace");
    fs.mkdirSync(workspaceDir);
    let calls = 0;
    const contexts: string[] = [];
    const provider: AgentProvider = {
      createAgent(config) {
        contexts.push(config.context);
        return {
          async run() {
            calls++;
            const review = calls === 1
              ? {
                approved: false,
                findings: [{ id: "F-1", severity: "HIGH", description: "missing auth" }],
                acceptance: [{ id: "S1", status: "passed" }],
              }
              : {
                approved: true,
                findings: [],
                previous_findings: [{ id: "F-1", status: "fixed" }],
                acceptance: [{ id: "S1", status: "passed" }],
              };
            fs.mkdirSync(config.artifactDir, { recursive: true });
            const output = path.join(config.artifactDir, "review.json");
            fs.writeFileSync(output, JSON.stringify(review));
            return { artifacts: [output] };
          },
        };
      },
    };
    try {
      const engine = new Engine({
        provider,
        roles: { reviewer: reviewRole() },
        artifactBaseDir,
        workspaceDir,
      });
      const result = await engine.run({
        name: "convergence",
        stages: [{ repeat: {
          name: "review-loop",
          max_iterations: 2,
          until: "review-approved",
          stages: [{ name: "review", roles: ["reviewer"], max_retries: 0 }],
        } }],
      }, "review");

      expect(result.status).toBe("done");
      expect(calls).toBe(2);
      expect(contexts[1]).toContain(path.join("review", "reviewer", "attempts", "1", "review.json"));
      expect(fs.existsSync(path.join(artifactBaseDir, "review", "reviewer", "attempts", "1", "review.json"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
