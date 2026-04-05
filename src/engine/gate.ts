// src/engine/gate.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { GateConfig, GateStrategy } from "../types.js";

export interface GateInput {
  gate: GateConfig;
  roleName: string;
}

export interface GateResult {
  passed: boolean;
  reason: string;
  details: { roleName: string; passed: boolean; reason: string }[];
}

/**
 * Replaces {stage} and {role} placeholders in a template string.
 */
export function resolveGatePath(template: string, stage: string, role: string): string {
  return template.replaceAll("{stage}", stage).replaceAll("{role}", role);
}

/**
 * Checks all gates and returns a GateResult based on the strategy.
 */
export async function checkGates(
  gates: GateInput[],
  stageName: string,
  artifactBaseDir: string,
  strategy: GateStrategy,
): Promise<GateResult> {
  if (gates.length === 0) {
    return { passed: true, reason: "No gates to check", details: [] };
  }

  const details: GateResult["details"] = [];

  for (const { gate, roleName } of gates) {
    const resolvedPath = resolveGatePath(gate.evidence.path, stageName, roleName);
    const fullPath = path.join(artifactBaseDir, resolvedPath);

    if (!fs.existsSync(fullPath)) {
      details.push({
        roleName,
        passed: false,
        reason: `Artifact not found: ${resolvedPath}`,
      });
      continue;
    }

    if (gate.evidence.check) {
      const content = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      const { field, equals } = gate.evidence.check;
      const actual = content[field];

      if (equals !== undefined && actual !== equals) {
        details.push({
          roleName,
          passed: false,
          reason: `Field "${field}" is ${JSON.stringify(actual)}, expected ${JSON.stringify(equals)}`,
        });
        continue;
      }
    }

    details.push({ roleName, passed: true, reason: "Gate passed" });
  }

  const passedCount = details.filter((d) => d.passed).length;
  const total = details.length;

  let passed: boolean;
  switch (strategy) {
    case "all":
      passed = passedCount === total;
      break;
    case "majority":
      passed = passedCount > total / 2;
      break;
    case "any":
      passed = passedCount > 0;
      break;
  }

  const reason = passed
    ? `${passedCount}/${total} gates passed (strategy: ${strategy})`
    : `Only ${passedCount}/${total} gates passed (strategy: ${strategy})`;

  return { passed, reason, details };
}
