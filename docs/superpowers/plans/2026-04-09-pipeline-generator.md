# Pipeline Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Create" tab to the web dashboard that generates a complete pipeline + roles from a natural language description.

**Architecture:** New `src/engine/generator.ts` builds a prompt with few-shot examples, calls the existing provider abstraction, parses structured output into files, writes them to `.petri/generated/`, and validates using the existing config loaders. New `src/engine/promote.ts` copies confirmed files to the project root. Frontend adds a Create tab with input view and file review/edit view.

**Tech Stack:** TypeScript, existing AgentProvider interface, existing config loaders for validation, vanilla JS frontend (matches existing app.js pattern).

---

### Task 1: Extract programmatic validation function

**Files:**
- Create: `src/engine/validate.ts`
- Test: `tests/engine/validate.test.ts`

The existing `src/cli/validate.ts` only logs to console and calls `process.exit`. We need a programmatic version that returns structured results.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/engine/validate.test.ts
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
```

- [ ] **Step 2: Create test fixtures**

Create `tests/fixtures/valid-project/` with minimal valid files:

```yaml
# tests/fixtures/valid-project/petri.yaml
providers:
  default:
    type: claude_code
models:
  haiku:
    provider: default
    model: haiku
defaults:
  model: haiku
  gate_strategy: all
  max_retries: 2
```

```yaml
# tests/fixtures/valid-project/pipeline.yaml
name: test
description: Test pipeline
goal: Test
stages:
  - name: work
    roles: [worker]
```

```yaml
# tests/fixtures/valid-project/roles/worker/role.yaml
persona: soul.md
skills: []
```

```markdown
# tests/fixtures/valid-project/roles/worker/soul.md
You are a test worker.
```

Create `tests/fixtures/missing-role/` with a pipeline referencing a nonexistent role:

```yaml
# tests/fixtures/missing-role/petri.yaml
providers:
  default:
    type: claude_code
models:
  haiku:
    provider: default
    model: haiku
defaults:
  model: haiku
  gate_strategy: all
  max_retries: 2
```

```yaml
# tests/fixtures/missing-role/pipeline.yaml
name: test
description: Test
goal: Test
stages:
  - name: work
    roles: [ghost_role]
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/engine/validate.test.ts`
Expected: FAIL — module `../../src/engine/validate.js` not found

- [ ] **Step 4: Write the implementation**

```typescript
// src/engine/validate.ts
import { loadPetriConfig, loadPipelineConfig, loadRole } from "../config/loader.js";
import { isRepeatBlock, type StageEntry } from "../types.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateProject(projectDir: string): ValidationResult {
  const errors: string[] = [];

  // 1. Load petri.yaml
  let defaultModel = "default";
  try {
    const petriConfig = loadPetriConfig(projectDir);
    defaultModel = petriConfig.defaults.model;
  } catch (err: unknown) {
    errors.push(`petri.yaml: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Load pipeline.yaml
  const roleNames = new Set<string>();
  try {
    const pipelineConfig = loadPipelineConfig(projectDir);
    function collectRoles(stages: StageEntry[]): void {
      for (const entry of stages) {
        if (isRepeatBlock(entry)) {
          collectRoles(entry.repeat.stages);
        } else {
          for (const role of entry.roles) {
            roleNames.add(role);
          }
        }
      }
    }
    collectRoles(pipelineConfig.stages);
  } catch (err: unknown) {
    errors.push(`pipeline.yaml: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3. Load each role
  for (const name of roleNames) {
    try {
      loadRole(projectDir, name, defaultModel);
    } catch (err: unknown) {
      errors.push(`role "${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { valid: errors.length === 0, errors };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/engine/validate.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/engine/validate.ts tests/engine/validate.test.ts tests/fixtures/
git commit -m "feat: extract programmatic validation function from CLI validate"
```

---

### Task 2: Implement generator core

**Files:**
- Create: `src/engine/generator.ts`
- Test: `tests/engine/generator.test.ts`

This module builds a prompt from the user's description + few-shot examples, calls the LLM provider, parses structured output, writes files to `.petri/generated/`, and runs validation with retry.

- [ ] **Step 1: Write the failing test for prompt building**

```typescript
// tests/engine/generator.test.ts
import { describe, it, expect } from "vitest";
import { buildGenerationPrompt } from "../../src/engine/generator.js";

describe("buildGenerationPrompt", () => {
  it("includes user description and example structure", () => {
    const prompt = buildGenerationPrompt("Build a code review pipeline with designer, developer, and reviewer");
    expect(prompt).toContain("Build a code review pipeline");
    expect(prompt).toContain("pipeline.yaml");
    expect(prompt).toContain("role.yaml");
    expect(prompt).toContain("soul.md");
    expect(prompt).toContain("gate.yaml");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/generator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write buildGenerationPrompt**

```typescript
// src/engine/generator.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadPetriConfig } from "../config/loader.js";
import { validateProject } from "./validate.js";
import type { AgentProvider } from "../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface GenerateRequest {
  description: string;
  projectDir: string;
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
3. Gate evidence paths use {stage}/{role}/filename.json format
4. Gate checks verify a JSON field value (e.g. field: completed, equals: true)
5. Skills referenced in role.yaml must have a matching file in skills/
6. Use "petri:file_operations" and "petri:shell_tools" as built-in skills when the role needs file or shell access
7. pipeline.yaml requirements must reference gate ids that exist in the roles
8. Keep personas concise and focused on the role's expertise
9. Keep skills actionable — tell the agent exactly what to produce and what gate artifact to write

## User Description

${description}`;
}

function safeRead(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "(file not found)";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/generator.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing test for parseGeneratedFiles**

```typescript
// Add to tests/engine/generator.test.ts
import { parseGeneratedFiles } from "../../src/engine/generator.js";

describe("parseGeneratedFiles", () => {
  it("parses JSON file map from LLM output", () => {
    const output = JSON.stringify({
      "pipeline.yaml": "name: test\nstages: []",
      "roles/worker/role.yaml": "persona: soul.md\nskills: []",
    });
    const files = parseGeneratedFiles(output);
    expect(files.size).toBe(2);
    expect(files.get("pipeline.yaml")).toContain("name: test");
    expect(files.get("roles/worker/role.yaml")).toContain("persona: soul.md");
  });

  it("extracts JSON from markdown code block", () => {
    const output = "Here is the pipeline:\n```json\n{\"pipeline.yaml\": \"name: test\"}\n```\n";
    const files = parseGeneratedFiles(output);
    expect(files.size).toBe(1);
    expect(files.get("pipeline.yaml")).toBe("name: test");
  });

  it("throws on invalid output", () => {
    expect(() => parseGeneratedFiles("not json at all")).toThrow();
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run tests/engine/generator.test.ts`
Expected: FAIL — parseGeneratedFiles not exported

- [ ] **Step 7: Implement parseGeneratedFiles**

Add to `src/engine/generator.ts`:

```typescript
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
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npx vitest run tests/engine/generator.test.ts`
Expected: PASS

- [ ] **Step 9: Implement generatePipeline (main function)**

Add to `src/engine/generator.ts`:

```typescript
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

  let prompt = buildGenerationPrompt(req.description);
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Add validation errors from previous attempt
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
      model: "default",
    });

    await agent.run();

    // Read the result — claude-code provider writes _result.md to artifactDir
    const resultPath = path.join(llmWorkDir, "_result.md");
    let outputText: string;
    if (fs.existsSync(resultPath)) {
      outputText = fs.readFileSync(resultPath, "utf-8");
    } else {
      throw new Error("LLM did not produce output");
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

  // Failed after all retries — return what we have with errors
  const finalFiles = listFilesRecursive(generatedDir)
    .filter((f) => f !== "petri.yaml"); // exclude copied petri.yaml
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

function listFilesRecursive(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}
```

- [ ] **Step 10: Commit**

```bash
git add src/engine/generator.ts tests/engine/generator.test.ts
git commit -m "feat: implement pipeline generator core with prompt building, parsing, and validation retry"
```

---

### Task 3: Implement promote module

**Files:**
- Create: `src/engine/promote.ts`
- Test: `tests/engine/promote.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/engine/promote.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { promoteGenerated } from "../../src/engine/promote.js";

describe("promoteGenerated", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "petri-promote-"));
    // Create .petri/generated/ with test files
    const genDir = path.join(tmpDir, ".petri", "generated");
    fs.mkdirSync(path.join(genDir, "roles", "worker"), { recursive: true });
    fs.writeFileSync(path.join(genDir, "pipeline.yaml"), "name: test");
    fs.writeFileSync(path.join(genDir, "roles", "worker", "role.yaml"), "persona: soul.md");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("copies files from .petri/generated/ to project root", () => {
    const files = promoteGenerated(tmpDir);
    expect(files).toContain("pipeline.yaml");
    expect(files).toContain("roles/worker/role.yaml");
    expect(fs.readFileSync(path.join(tmpDir, "pipeline.yaml"), "utf-8")).toBe("name: test");
    expect(fs.readFileSync(path.join(tmpDir, "roles", "worker", "role.yaml"), "utf-8")).toBe("persona: soul.md");
  });

  it("returns empty array when no generated files exist", () => {
    fs.rmSync(path.join(tmpDir, ".petri", "generated"), { recursive: true });
    const files = promoteGenerated(tmpDir);
    expect(files).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/engine/promote.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement promoteGenerated**

```typescript
// src/engine/promote.ts
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Copy files from .petri/generated/ to the project root directory.
 * Returns list of relative file paths that were promoted.
 */
export function promoteGenerated(projectDir: string): string[] {
  const generatedDir = path.join(projectDir, ".petri", "generated");
  if (!fs.existsSync(generatedDir)) return [];

  const files = listFilesRecursive(generatedDir);
  for (const relPath of files) {
    const src = path.join(generatedDir, relPath);
    const dest = path.join(projectDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }

  return files;
}

function listFilesRecursive(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(path.join(dir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/engine/promote.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/promote.ts tests/engine/promote.test.ts
git commit -m "feat: add promote module to copy generated files to project root"
```

---

### Task 4: Add generate API endpoints

**Files:**
- Modify: `src/web/routes/api.ts`
- Modify: `src/web/server.ts` (pass provider info to route handler)

- [ ] **Step 1: Add generate endpoints to api.ts**

Add the following imports at the top of `src/web/routes/api.ts`:

```typescript
import { generatePipeline } from "../../engine/generator.js";
import { promoteGenerated } from "../../engine/promote.js";
import { validateProject } from "../../engine/validate.js";
```

Update the `handleApiRequest` signature to accept a provider factory, and add new route handlers. Insert the following route matches **before** the final `sendJson(res, 404, ...)` at line 98:

```typescript
  // POST /api/generate — generate pipeline from description
  if (pathname === "/api/generate" && method === "POST") {
    try {
      const body = await readBody(req);
      let parsed: { description?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        sendJson(res, 400, { error: "Invalid JSON body" });
        return;
      }

      if (!parsed.description || typeof parsed.description !== "string") {
        sendJson(res, 400, { error: "Missing required field: description" });
        return;
      }

      const provider = createProvider(projectDir);
      const result = await generatePipeline(
        { description: parsed.description, projectDir },
        provider,
      );
      sendJson(res, 200, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  // POST /api/generate/promote — promote generated files to project root
  if (pathname === "/api/generate/promote" && method === "POST") {
    try {
      const files = promoteGenerated(projectDir);
      sendJson(res, 200, { files });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: message });
    }
    return;
  }

  // GET /api/generate/files — list generated files
  if (pathname === "/api/generate/files" && method === "GET") {
    const genDir = path.join(projectDir, ".petri", "generated");
    if (!fs.existsSync(genDir)) {
      sendJson(res, 200, []);
      return;
    }
    const files = listGeneratedFiles(genDir);
    sendJson(res, 200, files);
    return;
  }

  // GET /api/generate/file — read a generated file
  if (pathname === "/api/generate/file" && method === "GET") {
    const relPath = url.searchParams.get("path");
    if (!relPath) {
      sendJson(res, 400, { error: "Missing path parameter" });
      return;
    }
    const genDir = path.join(projectDir, ".petri", "generated");
    const absPath = path.resolve(genDir, relPath);
    if (!absPath.startsWith(genDir) || !fs.existsSync(absPath)) {
      sendJson(res, 404, { error: "File not found" });
      return;
    }
    const content = fs.readFileSync(absPath, "utf-8");
    sendJson(res, 200, { path: relPath, content });
    return;
  }

  // PUT /api/generate/file — write a generated file
  if (pathname === "/api/generate/file" && method === "PUT") {
    const relPath = url.searchParams.get("path");
    if (!relPath) {
      sendJson(res, 400, { error: "Missing path parameter" });
      return;
    }
    const genDir = path.join(projectDir, ".petri", "generated");
    const absPath = path.resolve(genDir, relPath);
    if (!absPath.startsWith(genDir)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    const body = await readBody(req);
    let parsed: { content?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }
    if (typeof parsed.content !== "string") {
      sendJson(res, 400, { error: "Missing content field" });
      return;
    }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, parsed.content, "utf-8");
    sendJson(res, 200, { path: relPath, saved: true });
    return;
  }

  // POST /api/generate/validate — validate generated files
  if (pathname === "/api/generate/validate" && method === "POST") {
    const genDir = path.join(projectDir, ".petri", "generated");
    // Copy petri.yaml temporarily for validation
    const petriSrc = path.join(projectDir, "petri.yaml");
    const petriDst = path.join(genDir, "petri.yaml");
    let copiedPetri = false;
    if (fs.existsSync(petriSrc) && !fs.existsSync(petriDst)) {
      fs.mkdirSync(genDir, { recursive: true });
      fs.copyFileSync(petriSrc, petriDst);
      copiedPetri = true;
    }
    try {
      const result = validateProject(genDir);
      sendJson(res, 200, result);
    } finally {
      if (copiedPetri && fs.existsSync(petriDst)) {
        fs.unlinkSync(petriDst);
      }
    }
    return;
  }
```

Add helper function at end of file:

```typescript
function listGeneratedFiles(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...listGeneratedFiles(path.join(dir, entry.name), rel));
    } else {
      results.push(rel);
    }
  }
  return results;
}
```

- [ ] **Step 2: Add createProvider helper to api.ts**

Add a function to create a provider from project config (reuse pattern from `src/web/runner.ts:67-87`):

```typescript
import { ClaudeCodeProvider } from "../../providers/claude-code.js";
import { PiProvider } from "../../providers/pi.js";
import { loadPetriConfig } from "../../config/loader.js";
import type { AgentProvider } from "../../types.js";

function createProvider(projectDir: string): AgentProvider {
  const petriConfig = loadPetriConfig(projectDir);
  const providerEntries = Object.entries(petriConfig.providers);
  const hasClaudeCode = providerEntries.some(([, v]) => v.type === "claude_code");
  const defaultModel = petriConfig.defaults.model;

  if (hasClaudeCode) {
    return new ClaudeCodeProvider(defaultModel);
  }

  const modelMappings: Record<string, { piProvider: string; piModel: string }> = {};
  for (const [modelAlias, modelCfg] of Object.entries(petriConfig.models ?? {})) {
    const provCfg = petriConfig.providers[modelCfg.provider];
    if (provCfg) {
      modelMappings[modelAlias] = { piProvider: modelCfg.provider, piModel: modelCfg.model };
    }
  }
  return new PiProvider(modelMappings);
}
```

- [ ] **Step 3: Build and verify compilation**

Run: `npm run build`
Expected: No TypeScript errors

- [ ] **Step 4: Commit**

```bash
git add src/web/routes/api.ts
git commit -m "feat: add generate API endpoints (generate, promote, validate, file read/write)"
```

---

### Task 5: Add Create tab to frontend HTML

**Files:**
- Modify: `src/web/public/index.html`

- [ ] **Step 1: Add Create tab button to navigation**

In `src/web/public/index.html`, add a new tab button after the Config button (line 15):

```html
      <button class="tab" data-tab="create">Create</button>
```

- [ ] **Step 2: Add Create tab content section**

After the Config tab section closing `</section>` (line 155), add:

```html
    <!-- Create Tab -->
    <section id="tab-create" class="tab-content">
      <!-- Input view -->
      <div id="create-input-view" class="create-input-view">
        <div class="create-form">
          <h3>Create Pipeline from Description</h3>
          <p class="create-hint">Describe what your pipeline should do. The system will generate pipeline.yaml and all role definitions.</p>
          <textarea id="create-description" rows="8" placeholder="Example: Build a code review pipeline with three stages — a designer creates the architecture, a developer implements it, then a reviewer checks code quality and test coverage..."></textarea>
          <div class="create-actions">
            <button id="create-generate-btn" class="btn-primary">Generate</button>
          </div>
          <div id="create-error" class="error-msg"></div>
          <div id="create-loading" class="create-loading" style="display:none;">
            <div class="spinner"></div>
            <span>Generating pipeline... This may take 10-30 seconds.</span>
          </div>
        </div>
      </div>

      <!-- Review view (hidden by default) -->
      <div id="create-review-view" style="display:none;">
        <div id="create-status-banner" class="create-status-banner"></div>
        <div class="config-layout">
          <aside class="file-tree-panel">
            <h3>Generated Files</h3>
            <div id="gen-file-tree" class="file-tree"></div>
          </aside>
          <div class="editor-panel">
            <div class="editor-header">
              <span id="gen-editor-filename" class="editor-filename">No file selected</span>
              <button id="gen-editor-save-btn" class="btn-primary" disabled>Save</button>
            </div>
            <div id="gen-editor-status" class="editor-status"></div>
            <textarea id="gen-editor-content" class="editor-textarea" disabled placeholder="Select a file to view..."></textarea>
          </div>
        </div>
        <div class="create-review-actions">
          <button id="create-validate-btn" class="btn-secondary">Validate</button>
          <button id="create-confirm-btn" class="btn-primary">Confirm & Run</button>
          <button id="create-regen-btn" class="btn-secondary">Regenerate</button>
        </div>
      </div>
    </section>
```

- [ ] **Step 3: Verify HTML is well-formed**

Open the file in browser or run build to check for issues:
Run: `npm run build`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/web/public/index.html
git commit -m "feat: add Create tab HTML structure to web dashboard"
```

---

### Task 6: Add Create tab styles

**Files:**
- Modify: `src/web/public/style.css`

- [ ] **Step 1: Add CSS for Create tab**

Append to `src/web/public/style.css`:

```css
/* ── Create Tab ── */

.create-input-view {
  padding: 1.5rem;
  overflow-y: auto;
  height: 100%;
  display: flex;
  justify-content: center;
}

.create-form {
  max-width: 700px;
  width: 100%;
}

.create-form h3 {
  font-size: 1rem;
  margin-bottom: 0.5rem;
}

.create-hint {
  font-size: 0.85rem;
  color: var(--text-muted);
  margin-bottom: 1rem;
}

.create-form textarea {
  width: 100%;
  background: var(--bg-secondary);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.75rem;
  font-size: 0.875rem;
  font-family: inherit;
  resize: vertical;
  line-height: 1.5;
}

.create-form textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(88, 166, 255, 0.2);
}

.create-actions {
  margin-top: 0.75rem;
}

.create-loading {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-top: 1rem;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.create-status-banner {
  padding: 0.6rem 1rem;
  font-size: 0.85rem;
  border-bottom: 1px solid var(--border);
}

.create-status-banner.success {
  background: rgba(45, 106, 79, 0.15);
  color: var(--success-bright);
}

.create-status-banner.warning {
  background: rgba(210, 153, 34, 0.15);
  color: var(--warning);
}

.create-review-actions {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--border);
  background: var(--bg-secondary);
}

.btn-secondary {
  background: transparent;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 0.5rem 1.25rem;
  font-size: 0.875rem;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.btn-secondary:hover {
  color: var(--text);
  border-color: var(--text-muted);
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/public/style.css
git commit -m "feat: add Create tab styles"
```

---

### Task 7: Add Create tab JavaScript logic

**Files:**
- Modify: `src/web/public/app.js`

- [ ] **Step 1: Add state variables**

Add after line 10 (`let currentConfigPath = null;`):

```javascript
// Create tab state
let generateDescription = null;
let generatedFiles = [];
let generatedStatus = null;
let generatedErrors = [];
let selectedGeneratedFile = null;
```

- [ ] **Step 2: Add tab switching for Create tab**

In the tab switching handler (around line 83-85), add:

```javascript
      if (target === "create") loadCreateTab();
```

- [ ] **Step 3: Add event listener registrations in DOMContentLoaded**

After the existing event listener registrations (after line 107), add:

```javascript
  // Create tab buttons
  $("#create-generate-btn").addEventListener("click", startGenerate);
  $("#gen-editor-save-btn").addEventListener("click", saveGeneratedFile);
  $("#create-validate-btn").addEventListener("click", validateGenerated);
  $("#create-confirm-btn").addEventListener("click", confirmAndRun);
  $("#create-regen-btn").addEventListener("click", showCreateInput);
```

- [ ] **Step 4: Add Create tab functions**

Add before the Utilities section (before line 667 `// ── Utilities`):

```javascript
// ══════════════════════════════════════
// ── Create Tab
// ══════════════════════════════════════

function loadCreateTab() {
  // If we have generated files, show review view; otherwise show input view
  if (generatedFiles.length > 0) {
    showCreateReview();
  } else {
    showCreateInput();
  }
}

function showCreateInput() {
  $("#create-input-view").style.display = "";
  $("#create-review-view").style.display = "none";
  if (generateDescription) {
    $("#create-description").value = generateDescription;
  }
}

function showCreateReview() {
  $("#create-input-view").style.display = "none";
  $("#create-review-view").style.display = "";
  renderGeneratedFileTree();
  renderStatusBanner();
}

async function startGenerate() {
  const btn = $("#create-generate-btn");
  const errorEl = $("#create-error");
  const loadingEl = $("#create-loading");
  const description = $("#create-description").value.trim();

  errorEl.textContent = "";
  if (!description) {
    errorEl.textContent = "Please enter a description.";
    return;
  }

  generateDescription = description;
  btn.disabled = true;
  loadingEl.style.display = "flex";

  const res = await api("/api/generate", {
    method: "POST",
    body: JSON.stringify({ description }),
  });

  btn.disabled = false;
  loadingEl.style.display = "none";

  if (res.status === 200 && res.data.files) {
    generatedFiles = res.data.files;
    generatedStatus = res.data.status;
    generatedErrors = res.data.errors || [];
    selectedGeneratedFile = null;
    showCreateReview();
  } else {
    errorEl.textContent = (res.data && res.data.error) || "Generation failed.";
  }
}

function renderStatusBanner() {
  const banner = $("#create-status-banner");
  if (generatedStatus === "ok") {
    banner.className = "create-status-banner success";
    banner.textContent = "Pipeline generated successfully. Review the files below, then confirm to run.";
  } else if (generatedStatus === "validation_failed") {
    banner.className = "create-status-banner warning";
    banner.textContent = "Generated with validation errors: " + generatedErrors.join("; ");
  }
}

function renderGeneratedFileTree() {
  const tree = $("#gen-file-tree");
  const files = generatedFiles;

  const groups = {};
  files.forEach((f) => {
    const parts = f.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    if (!groups[dir]) groups[dir] = [];
    groups[dir].push(f);
  });

  const sortedDirs = Object.keys(groups).sort((a, b) => {
    if (a === ".") return -1;
    if (b === ".") return 1;
    return a.localeCompare(b);
  });

  let html = "";
  for (const dir of sortedDirs) {
    const label = dir === "." ? "Project Root" : dir;
    html += `<div class="file-group-label">${escHtml(label)}</div>`;
    groups[dir].sort().forEach((f) => {
      const name = f.split("/").pop();
      const activeClass = f === selectedGeneratedFile ? " active" : "";
      html += `<div class="file-item${activeClass}" data-path="${escAttr(f)}">${escHtml(name)}</div>`;
    });
  }

  tree.innerHTML = html;
  tree.querySelectorAll(".file-item").forEach((el) => {
    el.addEventListener("click", () => {
      loadGeneratedFile(el.dataset.path);
      tree.querySelectorAll(".file-item").forEach((e) => e.classList.remove("active"));
      el.classList.add("active");
    });
  });

  // Auto-select first file
  if (files.length > 0 && !selectedGeneratedFile) {
    loadGeneratedFile(files[0]);
    tree.querySelector(".file-item")?.classList.add("active");
  }
}

async function loadGeneratedFile(filePath) {
  selectedGeneratedFile = filePath;
  const editor = $("#gen-editor-content");
  const filenameEl = $("#gen-editor-filename");
  const saveBtn = $("#gen-editor-save-btn");
  const statusEl = $("#gen-editor-status");

  filenameEl.textContent = filePath;
  statusEl.textContent = "";
  statusEl.className = "editor-status";
  editor.disabled = true;
  saveBtn.disabled = true;

  const res = await api("/api/generate/file?path=" + encodeURIComponent(filePath));
  if (res.status === 200) {
    editor.value = typeof res.data === "string" ? res.data : res.data.content || "";
    editor.disabled = false;
    saveBtn.disabled = false;
  } else {
    editor.value = "Failed to load file.";
  }
}

async function saveGeneratedFile() {
  if (!selectedGeneratedFile) return;
  const saveBtn = $("#gen-editor-save-btn");
  const statusEl = $("#gen-editor-status");
  const content = $("#gen-editor-content").value;

  saveBtn.disabled = true;
  statusEl.textContent = "Saving...";
  statusEl.className = "editor-status";

  const res = await api("/api/generate/file?path=" + encodeURIComponent(selectedGeneratedFile), {
    method: "PUT",
    body: JSON.stringify({ content }),
  });

  saveBtn.disabled = false;
  if (res.status === 200) {
    statusEl.textContent = "Saved";
    statusEl.className = "editor-status success";
  } else {
    statusEl.textContent = (res.data && res.data.error) || "Save failed.";
    statusEl.className = "editor-status error";
  }
}

async function validateGenerated() {
  const btn = $("#create-validate-btn");
  btn.disabled = true;
  btn.textContent = "Validating...";

  const res = await api("/api/generate/validate", { method: "POST" });

  btn.disabled = false;
  btn.textContent = "Validate";

  if (res.status === 200) {
    if (res.data.valid) {
      generatedStatus = "ok";
      generatedErrors = [];
    } else {
      generatedStatus = "validation_failed";
      generatedErrors = res.data.errors || [];
    }
    renderStatusBanner();
  }
}

async function confirmAndRun() {
  const btn = $("#create-confirm-btn");
  btn.disabled = true;
  btn.textContent = "Promoting...";

  // 1. Promote files
  const promoteRes = await api("/api/generate/promote", { method: "POST" });
  if (promoteRes.status !== 200) {
    btn.disabled = false;
    btn.textContent = "Confirm & Run";
    return;
  }

  // 2. Start a run with the generated pipeline
  btn.textContent = "Starting run...";
  const input = generateDescription || "";
  const runRes = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify({ input }),
  });

  btn.disabled = false;
  btn.textContent = "Confirm & Run";

  if (runRes.status === 200 && runRes.data.runId) {
    // Reset create state
    generatedFiles = [];
    generatedStatus = null;
    generatedErrors = [];
    selectedGeneratedFile = null;
    // Navigate to run detail
    openRunDetail(runRes.data.runId);
  }
}
```

- [ ] **Step 5: Build and test manually**

Run: `npm run build`
Expected: No errors

Start the dev server and verify the Create tab appears and the UI structure works:
Run: `npm run dev -- web`

- [ ] **Step 6: Commit**

```bash
git add src/web/public/app.js
git commit -m "feat: add Create tab JavaScript logic for pipeline generation"
```

---

### Task 8: Adjust Create tab layout height

**Files:**
- Modify: `src/web/public/style.css`

The review view uses `.config-layout` which is `height: 100%`, but the Create review view also has a status banner and action bar. We need to adjust the height.

- [ ] **Step 1: Add layout override for Create review**

Add to `src/web/public/style.css`:

```css
#create-review-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

#create-review-view .config-layout {
  flex: 1;
  overflow: hidden;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/web/public/style.css
git commit -m "fix: adjust Create tab review view layout height"
```

---

### Task 9: End-to-end manual test and fix issues

- [ ] **Step 1: Build the project**

Run: `npm run build`
Expected: No TypeScript compilation errors

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All tests pass

- [ ] **Step 3: Manual smoke test**

Start the web server in a project directory that has `petri.yaml`:
Run: `npm run dev -- web`

1. Open http://localhost:3000
2. Verify "Create" tab appears in navigation
3. Click Create tab → verify input textarea and Generate button appear
4. Enter a description → click Generate → verify loading spinner shows
5. After generation completes → verify review view shows file list and editor
6. Click a file → verify content loads in editor
7. Edit content → click Save → verify "Saved" confirmation
8. Click Validate → verify validation runs and status banner updates
9. Click Confirm & Run → verify files promoted and run starts

- [ ] **Step 4: Fix any issues found during smoke test**

Address any bugs discovered. Common issues to watch for:
- Provider creation failing (check petri.yaml exists and is valid)
- LLM output parsing (may need to adjust `parseGeneratedFiles` regex)
- Path resolution issues (ensure `.petri/generated/` paths are correct)

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "fix: address issues found during pipeline generator smoke test"
```
