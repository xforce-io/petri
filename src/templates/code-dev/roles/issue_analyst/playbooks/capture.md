Capture the user input as a structured issue brief.

## Steps

1. **Read the input** — Treat the pipeline input as the raw issue / request.
2. **Write `issue.md`** covering:
   - **Title** — one-line outcome
   - **Background** — why this matters
   - **Goals** — result-oriented outcomes
   - **Acceptance criteria** — checklist of observable pass conditions
   - **Out of scope** — explicit non-goals
   - **Open questions** — unknowns (or "none")
3. **Write the gate artifact:**

```json
// {stage}/{role}/issue.json
{
  "accepted": true,
  "summary": "One-sentence summary of the issue"
}
```

Set `"accepted": true` only when the brief is specific enough for design and TDD.
If the input is empty or nonsensical, still write `issue.md` explaining the gap
and set `"accepted": false`.
