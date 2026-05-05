// src/engine/gate.ts

import * as fs from "node:fs";
import * as path from "node:path";
import { GateCheck, GateCheckClause, GateConfig, GateStrategy } from "../types.js";

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
 * Resolves a dot-notation field path on an object.
 * e.g. resolveField({summary: {total: 5}}, "summary.total") → 5
 */
function resolveField(obj: any, field: string): any {
  const parts = field.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Replaces {stage} and {role} placeholders in a template string.
 */
export function resolveGatePath(template: string, stage: string, role: string): string {
  return template.replaceAll("{stage}", stage).replaceAll("{role}", role);
}

function checkOne(content: unknown, check: GateCheckClause): string | null {
  const actual = resolveField(content, check.field);

  if (check.equals !== undefined && actual !== check.equals) {
    return `Field "${check.field}" is ${JSON.stringify(actual)}, expected ${JSON.stringify(check.equals)}`;
  }
  if (check.gte !== undefined && !(actual >= check.gte)) {
    return `Field "${check.field}" is ${actual}, expected >= ${check.gte}`;
  }
  if (check.lte !== undefined && !(actual <= check.lte)) {
    return `Field "${check.field}" is ${actual}, expected <= ${check.lte}`;
  }
  if (check.gt !== undefined && !(actual > check.gt)) {
    return `Field "${check.field}" is ${actual}, expected > ${check.gt}`;
  }
  if (check.lt !== undefined && !(actual < check.lt)) {
    return `Field "${check.field}" is ${actual}, expected < ${check.lt}`;
  }
  if (check.in !== undefined && !check.in.includes(actual)) {
    return `Field "${check.field}" is ${JSON.stringify(actual)}, expected one of ${JSON.stringify(check.in)}`;
  }

  return null;
}

function evaluateCheck(content: unknown, check: GateCheck): string | null {
  const checks = Array.isArray(check) ? check : [check];
  for (const c of checks) {
    const failure = checkOne(content, c);
    if (failure) return failure;
  }
  return null;
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
      const failReason = evaluateCheck(content, gate.evidence.check);

      if (failReason) {
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
