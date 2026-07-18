Capture the user input as a structured issue brief.

## Steps

1. **Read the input** — Treat the pipeline input as the raw issue / request. If
   it begins with `# GitHub Issue Source`, preserve its source URL, metadata,
   body, and comments; do not discard decisions made in comments.
2. **Write `issue.md`** covering:
   - **Title** — one-line outcome
   - **Background** — why this matters
   - **Goals** — result-oriented outcomes
   - **Acceptance criteria** — checklist of observable pass conditions
   - **Out of scope** — explicit non-goals
   - **Open questions** — unknowns (or "none")
   - **Source and discussion** — for a GitHub Issue input, include the source
     URL plus the relevant comment decisions (or say that no comments exist)
3. **Write the gate artifact:**

```json
// {stage}/{role}/issue.json
{
  "accepted": true,
  "summary": "One-sentence summary of the issue",
  "source_url": "https://github.com/owner/repo/issues/123",
  "comment_count": 2
}
```

Set `"accepted": true` only when the brief is specific enough for design and TDD.
If the input is empty or nonsensical, still write `issue.md` explaining the gap
and set `"accepted": false`.
