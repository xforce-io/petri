import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { validateProject } from "./validate.js";
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
  const exampleSkill = safeRead(path.join(templateDir, "roles", "designer", "skills", "design.md"));

  return `You are a pipeline architect for the Petri multi-agent framework.

Given a user's description, generate a complete pipeline configuration.

## Output Format

Respond with a JSON object mapping file paths to file contents. Example:

\`\`\`json
{
  "pipeline.yaml": "name: ...",
  "roles/designer/role.yaml": "persona: soul.md\\nskills:\\n  - design",
  "roles/designer/soul.md": "You are a ...",
  "roles/designer/gate.yaml": "id: design-complete\\n...",
  "roles/designer/skills/design.md": "# Design\\n..."
}
\`\`\`

Output ONLY the JSON object, no other text.

## File Formats

### pipeline.yaml
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

### roles/{role_name}/skills/{skill_name}.md
\`\`\`markdown
${exampleSkill}
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
   A flat layout (\`evidence: <string>\` with top-level \`check:\`) is invalid and will fail validation.
4. Gate checks verify a JSON field value (e.g. field: completed, equals: true)
5. Skills referenced in role.yaml must have a matching file in skills/
6. Use "petri:file_operations" and "petri:shell_tools" as built-in skills when the role needs file or shell access
7. pipeline.yaml requirements must reference gate ids that exist in the roles
8. Keep personas concise and focused on the role's expertise
9. Keep skills actionable — tell the agent exactly what to produce and what gate artifact to write
10. Write personas, skills, descriptions, and any free-text in the SAME primary language as the user description below. If the description is mainly Chinese, keep generated prose Chinese; if English, English. Identifiers, YAML keys, and gate ids stay English.
11. The pipeline MUST contain at least one \`repeat:\` block. Petri is a feedback-loop-driven framework — a pipeline without iteration is not accepted. The \`repeat:\` block's \`until:\` field must reference a strong gate. The gate's \`evidence.check.field\` must NOT be a self-report boolean — that means NOT \`completed\`, \`done\`, \`finished\`, \`ready\`, \`written\`, or any \`*_completed\`/\`*_complete\`/\`*_done\`/\`*_finished\`/\`*_ready\`/\`*_written\` variant — because those gates fire the moment the role writes its artifact and the loop never iterates. Prefer numeric comparators (\`gt\`/\`lt\`/\`gte\`/\`lte\` against a result field, e.g. \`results.annual_return\` with \`gt: 0.09\`) or verifying booleans whose semantic clearly requires judgment (e.g. \`approved\` from a reviewer role, \`tests_passed\` from a test runner). Wrap whichever stages constitute the iterative work (typically implementation + validation) in the block.
12. Every \`repeat:\` block MUST include all of: \`name\` (string), \`max_iterations\` (positive integer ≥ 1), \`until\` (gate id string), and \`stages\` (non-empty list). Do NOT omit \`name\` or \`max_iterations\` — they are required, not optional.
13. \`requirements:\` (top-level) and \`repeat.until:\` are NOT synonyms. \`repeat.until\` is the loop's exit condition. \`requirements:\` lists additional gates verified at the end of the whole pipeline run. Do NOT duplicate the loop's exit gate id in \`requirements:\` — that is redundant. \`requirements:\` is typically empty when a \`repeat:\` block carries the success signal.

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
      skills: [],
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
