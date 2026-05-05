import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validateProject } from "./validate.js";
import { buildGeneratedManifest, saveGeneratedManifest } from "./manifest.js";
import { listFilesRecursive } from "../util/fs.js";
import type { AgentProvider } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface GenerateRequest {
  description: string;
  projectDir: string;
  model?: string;
}

export interface GenerateResult {
  status: "ok" | "validation_failed";
  files: string[];
  errors?: string[];
  retries: number;
}

/**
 * Build prompt for pipeline generation. Exported for testing.
 */
export function buildGenerationPrompt(description: string): string {
  // Load a few-shot example from the code-dev template
  const templateDir = path.join(__dirname, "..", "templates", "code-dev");
  const examplePipeline = safeRead(path.join(templateDir, "pipeline.yaml"));
  const exampleRole = safeRead(path.join(templateDir, "roles", "designer", "role.yaml"));
  const exampleSoul = safeRead(path.join(templateDir, "roles", "designer", "soul.md"));
  const exampleGate = safeRead(path.join(templateDir, "roles", "designer", "gate.yaml"));
  const examplePlaybook = safeRead(path.join(templateDir, "roles", "designer", "playbooks", "design.md"));

  return `You are a pipeline architect for the Petri multi-agent framework.

Given a user's description, generate a complete pipeline configuration.

## Output Format

Respond with a JSON object mapping file paths to file contents. Example:

\`\`\`json
{
  "pipeline.yaml": "name: ...",
  "roles/designer/role.yaml": "persona: soul.md\\nplaybooks:\\n  - design",
  "roles/designer/soul.md": "You are a ...",
  "roles/designer/gate.yaml": "id: design-complete\\n...",
  "roles/designer/playbooks/design.md": "# Design\\n..."
}
\`\`\`

Output ONLY the JSON object, no other text.

## File Formats

### pipeline.yaml

A pipeline has a top-level \`stages:\` list. A \`repeat:\` block IS a stage — it lives inside the \`stages:\` list, never at the top level.

\`\`\`yaml
# CORRECT shape:
name: <pipeline-name>
description: <short description>
stages:
  - repeat:                       # repeat: is one entry in stages:
      name: <loop-name>
      max_iterations: <int>
      until: <gate-id>
      stages:                     # nested stages inside the loop
        - name: <stage-name>
          roles: [<role-name>]    # plural "roles", a list — not "role: <single>"
        - ...
\`\`\`

\`\`\`yaml
# WRONG — DO NOT do this:
repeat:                           # ❌ repeat: at top level — must be inside stages:
  ...
\`\`\`

Full example:

\`\`\`yaml
${examplePipeline}
\`\`\`

### roles/{role_name}/role.yaml
\`\`\`yaml
${exampleRole}
\`\`\`

### roles/{role_name}/soul.md
\`\`\`markdown
${exampleSoul}
\`\`\`

### roles/{role_name}/gate.yaml
\`\`\`yaml
${exampleGate}
\`\`\`

### roles/{role_name}/playbooks/{playbook_name}.md
\`\`\`markdown
${examplePlaybook}
\`\`\`

## Rules

1. Every role referenced in pipeline stages MUST have a corresponding roles/{name}/ directory with role.yaml and soul.md
2. Every role SHOULD have a gate.yaml with a unique gate id
3. Gate evidence path AND check MUST be nested under the \`evidence\` key — not as siblings. Required structure:
   \`\`\`yaml
   id: <gate-id>
   evidence:
     path: "{stage}/{role}/<file>.json"
     check:
       field: <field-name>
       equals: <value>
   \`\`\`
   For multiple conditions on the same artifact, use a check array. Arrays are AND semantics — every entry must pass:
   \`\`\`yaml
   id: <gate-id>
   evidence:
     path: "{stage}/{role}/metrics.json"
     check:
       - field: results.annual_return
         gte: 0.09
       - field: results.max_drawdown
         gte: -0.10
   \`\`\`
   A flat layout (\`evidence: <string>\` with top-level \`check:\`) is invalid and will fail validation.
4. Gate checks verify JSON field values. A single check object verifies one field; a check array verifies multiple fields with AND semantics.
5. Playbooks referenced in role.yaml must have a matching file in playbooks/
6. Use "petri:file_operations" and "petri:shell_tools" as built-in prompt fragments when the role needs file or shell access
7. pipeline.yaml requirements must reference gate ids that exist in the roles
8. Keep personas concise and focused on the role's expertise
9. Keep playbooks actionable — tell the agent exactly what to produce and what gate artifact to write
10. Write personas, playbooks, descriptions, and any free-text in the SAME primary language as the user description below. If the description is mainly Chinese, keep generated prose Chinese; if English, English. Identifiers, YAML keys, and gate ids stay English.
11. The pipeline MUST contain at least one \`repeat:\` block. Petri is a feedback-loop-driven framework — a pipeline without iteration is not accepted. The \`repeat:\` block's \`until:\` field must reference a strong gate. The gate's \`evidence.check.field\` must NOT be a self-report boolean — that means NOT \`completed\`, \`done\`, \`finished\`, \`ready\`, \`written\`, or any \`*_completed\`/\`*_complete\`/\`*_done\`/\`*_finished\`/\`*_ready\`/\`*_written\` variant — because those gates fire the moment the role writes its artifact and the loop never iterates. Prefer numeric comparators (\`gt\`/\`lt\`/\`gte\`/\`lte\` against a result field, e.g. \`results.annual_return\` with \`gt: 0.09\`) or verifying booleans whose semantic clearly requires judgment (e.g. \`approved\` from a reviewer role, \`tests_passed\` from a test runner). Wrap whichever stages constitute the iterative work (typically implementation + validation) in the block.
12. Every \`repeat:\` block MUST include all of: \`name\` (string), \`max_iterations\` (positive integer ≥ 1), \`until\` (gate id string), and \`stages\` (non-empty list). Do NOT omit \`name\` or \`max_iterations\` — they are required, not optional.
13. \`requirements:\` (top-level) and \`repeat.until:\` are NOT synonyms. \`repeat.until\` is the loop's exit condition. \`requirements:\` lists additional gates verified at the end of the whole pipeline run. Do NOT duplicate the loop's exit gate id in \`requirements:\` — that is redundant. \`requirements:\` is typically empty when a \`repeat:\` block carries the success signal.
14. When the user's success target contains multiple numeric or measurable constraints (for example "annual return >= 9% AND max drawdown >= -10%", "tests pass AND coverage >= 80%"), the loop's final \`until\` gate MUST include every success constraint. Prefer one gate with an \`evidence.check\` array when all fields live in the same artifact. Do not silently gate only the easiest metric.
15. **Real ground-truth content** — petri cannot tell whether the value in a gate artifact was computed by an external tool (test runner, backtest CLI, training script, build, CI) or fabricated by the agent in-prompt. So when the loop's \`until\` gate is on a real metric (numeric comparator, e.g. \`oos_annual_return > 0.09\`, \`tests_passed: true\`, \`loss < 0.1\`), the role producing that artifact MUST invoke an external tool and capture its real output into the artifact JSON. The role's playbook must also write a small command-evidence field or sibling artifact with the exact command, exit code, and source output path. Self-grading where the agent synthesizes the metric value from the hypothesis or mental model is the anti-pattern this rule blocks. Path stays per rule 3 (\`{stage}/{role}/<file>.json\`); the discipline is on HOW the file is populated, not where it lives. When the external tool produces a canonical file elsewhere in the project (e.g. \`data/backtest_results/<run_id>/metrics.json\`), the role's playbook should instruct the agent to run that tool, read its output, and write the verified values into the gate's \`{stage}/{role}/<file>.json\`.

## User Description

${description}`;
}

/**
 * Parse LLM output into a file map. Exported for testing.
 */
export function parseGeneratedFiles(output: string): Map<string, string> {
  // Try to extract JSON from markdown code block
  const codeBlockMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const jsonStr = codeBlockMatch ? codeBlockMatch[1] : output.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error("Failed to parse LLM output as JSON. Raw output:\n" + output.slice(0, 500));
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object mapping file paths to contents");
  }

  const files = new Map<string, string>();
  for (const [filePath, content] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof content !== "string") {
      throw new Error(`File "${filePath}" content must be a string`);
    }
    // Security: reject absolute paths and path traversal
    if (path.isAbsolute(filePath) || filePath.includes("..")) {
      throw new Error(`Invalid file path: ${filePath}`);
    }
    files.set(filePath, content);
  }

  if (files.size === 0) {
    throw new Error("LLM generated an empty file map");
  }

  return files;
}

const MAX_RETRIES = 3;

/**
 * Generate a pipeline + roles from a description.
 * Calls LLM, writes files to .petri/generated/, validates, retries on failure.
 */
export async function generatePipeline(
  req: GenerateRequest,
  provider: AgentProvider,
): Promise<GenerateResult> {
  const generatedDir = path.join(req.projectDir, ".petri", "generated");

  const basePrompt = buildGenerationPrompt(req.description);
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Reconstruct prompt with latest errors (avoid accumulating multiple error sections)
    let prompt = basePrompt;
    if (attempt > 0 && lastErrors.length > 0) {
      prompt += `\n\n## Validation Errors from Previous Attempt\n\nThe following errors were found. Fix them:\n${lastErrors.map((e) => `- ${e}`).join("\n")}`;
    }

    // Use a temp subdirectory for the LLM call (provider writes _prompt.md, _result.md there)
    const llmWorkDir = path.join(generatedDir, "_llm_work");
    fs.mkdirSync(llmWorkDir, { recursive: true });

    // Call LLM
    const agent = provider.createAgent({
      persona: "You are a pipeline architect for the Petri framework.",
      playbooks: [],
      context: prompt,
      artifactDir: llmWorkDir,
      model: req.model ?? "default",
    });

    await agent.run();

    // Read the result — claude-code provider writes _result.md to artifactDir
    const resultPath = path.join(llmWorkDir, "_result.md");
    let outputText: string;
    if (fs.existsSync(resultPath)) {
      outputText = fs.readFileSync(resultPath, "utf-8");
    } else {
      // Surface what the provider actually saw so failures are debuggable.
      const errFile = path.join(llmWorkDir, "_error.txt");
      const parseErrFile = path.join(llmWorkDir, "_parse_error.txt");
      const hint = fs.existsSync(errFile)
        ? fs.readFileSync(errFile, "utf-8").trim()
        : fs.existsSync(parseErrFile)
        ? fs.readFileSync(parseErrFile, "utf-8").trim()
        : "no provider error file written; check provider logs";
      throw new Error(`LLM did not produce output. Provider hint:\n${hint}`);
    }

    // Parse files
    let files: Map<string, string>;
    try {
      files = parseGeneratedFiles(outputText);
    } catch (err) {
      lastErrors = [err instanceof Error ? err.message : String(err)];
      if (fs.existsSync(llmWorkDir)) fs.rmSync(llmWorkDir, { recursive: true });
      continue;
    }

    // Write parsed files to .petri/generated/ (clear previous contents, including _llm_work)
    writeGeneratedFiles(generatedDir, files);

    // Copy petri.yaml from project root to generated dir for validation
    const petriYamlSrc = path.join(req.projectDir, "petri.yaml");
    if (fs.existsSync(petriYamlSrc)) {
      fs.copyFileSync(petriYamlSrc, path.join(generatedDir, "petri.yaml"));
    }

    // Validate
    const validation = validateProject(generatedDir);
    if (validation.valid) {
      // Remove copied petri.yaml from generated (we don't want to promote it)
      const copiedPetri = path.join(generatedDir, "petri.yaml");
      if (fs.existsSync(copiedPetri)) fs.unlinkSync(copiedPetri);
      saveGeneratedManifest(
        generatedDir,
        buildGeneratedManifest(generatedDir, req.description),
      );

      return {
        status: "ok",
        files: Array.from(files.keys()),
        retries: attempt,
      };
    }

    lastErrors = validation.errors;
  }

  // Failed after all retries — clean up temp files and return what we have with errors
  // Remove copied petri.yaml from generated dir (it must not be left on disk)
  const copiedPetri = path.join(generatedDir, "petri.yaml");
  if (fs.existsSync(copiedPetri)) fs.unlinkSync(copiedPetri);
  // Remove _llm_work directory if it exists
  const llmWorkDirFinal = path.join(generatedDir, "_llm_work");
  if (fs.existsSync(llmWorkDirFinal)) fs.rmSync(llmWorkDirFinal, { recursive: true });

  const finalFiles = listFilesRecursive(generatedDir)
    .filter((f) => f !== "petri.yaml" && !f.startsWith("_llm_work/") && f !== "_llm_work");
  return {
    status: "validation_failed",
    files: finalFiles,
    errors: lastErrors,
    retries: MAX_RETRIES,
  };
}

function writeGeneratedFiles(dir: string, files: Map<string, string>): void {
  // Clear previous contents
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true });
  }
  fs.mkdirSync(dir, { recursive: true });

  for (const [filePath, content] of files) {
    const absPath = path.join(dir, filePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, "utf-8");
  }
}

function safeRead(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "(file not found)";
  }
}
