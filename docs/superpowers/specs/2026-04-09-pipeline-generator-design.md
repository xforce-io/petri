# Pipeline Generator — Design Spec

Generate a complete pipeline + roles from a natural language description via the web dashboard.

## Decisions

- **Generation scope:** pipeline.yaml + full roles skeleton (role.yaml, soul.md, gate.yaml, skills/*.md). petri.yaml is not generated — reuse existing or template.
- **Interaction model:** One-shot generation → file review/edit → validate → run. No multi-step wizard or chat.
- **LLM integration:** Reuse existing provider abstraction (claude_code / pi). No separate API keys.
- **Generation approach:** Single LLM call produces all files in one structured response.
- **Validation:** Auto-validate after generation; on failure, inject errors and retry (max 3). If still failing, return files + errors for user to hand-fix.
- **Staging directory:** Files generated to `.petri/generated/`, promoted to project root on user confirmation. Supports future multi-candidate extension.

## Backend

### New module: `src/engine/generator.ts`

```typescript
interface GenerateRequest {
  description: string;
  projectDir: string;
}

interface GenerateResult {
  status: "ok" | "validation_failed";
  files: string[];           // relative paths of generated files
  errors?: string[];         // validation errors (if status is validation_failed)
  retries: number;           // number of retries consumed
}

async function generatePipeline(req: GenerateRequest): Promise<GenerateResult>
```

**Responsibilities:**

1. Load provider from project's petri.yaml (use default model)
2. Build prompt:
   - System: "You are a pipeline architect for the Petri framework"
   - Include few-shot examples: pipeline.yaml format, role directory structure (role.yaml, soul.md, gate.yaml, skills/*.md)
   - Source examples from `src/templates/` and `examples/`
   - Specify output format: structured JSON with file path → content mapping
3. Call provider with prompt + user's description
4. Parse response into `Map<string, string>` (relative path → file content)
5. Write files to `.petri/generated/` (clear previous contents first)
6. Run validation programmatically against `.petri/generated/` (reuse existing validate logic, passing the staging dir as the project root)
7. On validation failure:
   - Inject error messages into prompt context
   - Retry (up to 3 times)
   - Include attempt history to avoid repeating same mistakes
8. Return `GenerateResult`

### New module: `src/engine/promote.ts`

```typescript
async function promoteGenerated(projectDir: string): Promise<string[]>
```

Copy files from `.petri/generated/` to project root directory. Returns list of promoted file paths. Overwrites existing files.

### New API endpoint in `src/web/routes/api.ts`

**POST /api/generate**

```json
// Request
{ "description": "Build a code review pipeline with..." }

// Response (success)
{
  "status": "ok",
  "files": ["pipeline.yaml", "roles/designer/role.yaml", ...],
  "retries": 1
}

// Response (validation failed after max retries)
{
  "status": "validation_failed",
  "files": ["pipeline.yaml", "roles/designer/role.yaml", ...],
  "errors": ["role 'reviewer' referenced in pipeline but not defined"]
}
```

**POST /api/generate/promote**

```json
// Request (empty body)

// Response
{ "files": ["pipeline.yaml", "roles/designer/role.yaml", ...] }
```

**GET /api/generate/files**

List files in `.petri/generated/`. Same format as existing `/api/config/files`.

**GET /api/generate/file?path=...**

Read a file from `.petri/generated/`. Same format as existing `/api/config/file`.

**PUT /api/generate/file?path=...**

Write a file in `.petri/generated/`. Same format as existing `/api/config/file`. Used when user edits generated files before promoting.

**POST /api/generate/validate**

Run validation on the files in `.petri/generated/`. Returns validation result.

```json
// Response (pass)
{ "valid": true }

// Response (fail)
{ "valid": false, "errors": ["..."] }
```

## Frontend

### New "Create" tab in web dashboard

**Input view:**
- Textarea for pipeline description
- "Generate" button
- Loading state while LLM is working (this can take 10-30s)

**Review view (shown after generation):**
- Status banner: green "Generated successfully" or yellow "Generated with validation errors: ..."
- File list sidebar: all generated files, clickable
- Editor panel: show selected file content, editable (reuse existing config editor logic)
- Save button per file (writes to `.petri/generated/` via `PUT /api/generate/file`)
- Bottom action bar:
  - "Validate" — run validation on current state of `.petri/generated/`
  - "Confirm & Run" — promote files to project root, then start a run (calls promote API, then existing `POST /api/runs`)
  - "Regenerate" — go back to input view, pre-fill the description

### State management

```javascript
// New state variables
let generateDescription = null;   // user's input text
let generatedFiles = [];          // file list from generation
let generatedStatus = null;       // "ok" | "validation_failed"
let generatedErrors = [];         // validation errors
let selectedGeneratedFile = null; // currently viewed file
```

### UI flow

```
Create Tab
  ├─ Input View
  │    user types description → click Generate
  │    POST /api/generate
  │    show loading spinner
  │    on response → switch to Review View
  │
  └─ Review View
       show file list + editor
       user clicks file → load content via GET /api/generate/file
       user edits → save via PUT /api/generate/file
       user clicks Validate → POST /api/generate/validate
       user clicks Confirm & Run → POST /api/generate/promote → POST /api/runs
       user clicks Regenerate → back to Input View
```

## Extensibility: Multi-candidate (future)

Current design stages files in `.petri/generated/`. To support multiple candidates:

1. Change staging path to `.petri/generated/{candidate-id}/`
2. `POST /api/generate` returns `{ candidates: [{ id, files, summary }, ...] }`
3. Frontend adds a candidate selector above the file list
4. Promote API takes a candidate ID parameter
5. Candidates could be generated in parallel (multiple provider calls)

No changes needed to the review/edit/validate flow — it operates on whichever candidate is selected.

## Files to create/modify

**New files:**
- `src/engine/generator.ts` — generation logic + prompt building
- `src/engine/promote.ts` — promote generated files to project root

**Modified files:**
- `src/web/routes/api.ts` — add generate endpoints
- `src/web/public/app.js` — add Create tab UI
- `src/web/public/style.css` — styles for Create tab
- `src/web/public/index.html` — add Create tab to navigation
