// src/engine/gate.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { GateConfig, GateStrategy } from "../types.js";

export interface GateInput {
  gate: GateConfig;
  roleName: string;
}

export interface GateDetail {
  gateId: string;
  roleName: string;
  passed: boolean;
  reason: string;
}

export interface GateResult {
  passed: boolean;
  reason: string;
  details: GateDetail[];
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

  const details: GateDetail[] = [];

  for (const { gate, roleName } of gates) {
    const resolvedPath = resolveGatePath(gate.evidence.path, stageName, roleName);
    const fullPath = path.join(artifactBaseDir, resolvedPath);

    if (!fs.existsSync(fullPath)) {
      details.push({
        gateId: gate.id,
        roleName,
        passed: false,
        reason: `Artifact not found: ${resolvedPath}`,
      });
      continue;
    }

    if (gate.evidence.check) {
      const content = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      const check = gate.evidence.check;
      const actual = content[check.field];
      let failed = false;
      let failReason = "";

      if (check.equals !== undefined && actual !== check.equals) {
        failed = true;
        failReason = `Field "${check.field}" is ${JSON.stringify(actual)}, expected ${JSON.stringify(check.equals)}`;
      }
      if (!failed && check.gte !== undefined && !(actual >= check.gte)) {
        failed = true;
        failReason = `Field "${check.field}" is ${actual}, expected >= ${check.gte}`;
      }
      if (!failed && check.lte !== undefined && !(actual <= check.lte)) {
        failed = true;
        failReason = `Field "${check.field}" is ${actual}, expected <= ${check.lte}`;
      }
      if (!failed && check.gt !== undefined && !(actual > check.gt)) {
        failed = true;
        failReason = `Field "${check.field}" is ${actual}, expected > ${check.gt}`;
      }
      if (!failed && check.lt !== undefined && !(actual < check.lt)) {
        failed = true;
        failReason = `Field "${check.field}" is ${actual}, expected < ${check.lt}`;
      }
      if (!failed && check.in !== undefined && !check.in.includes(actual)) {
        failed = true;
        failReason = `Field "${check.field}" is ${JSON.stringify(actual)}, expected one of ${JSON.stringify(check.in)}`;
      }

      if (failed) {
        details.push({
          gateId: gate.id,
          roleName,
          passed: false,
          reason: failReason,
        });
        continue;
      }
    }

    details.push({ gateId: gate.id, roleName, passed: true, reason: "Gate passed" });
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
