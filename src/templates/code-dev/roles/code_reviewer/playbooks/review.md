Review the developer's code against the issue brief and design document.
You run through the Agent Provider selected by this role's `role.yaml`. The
bundled code-dev template routes this role to **Codex** (`gpt-5.6-terra`) with
**reasoning effort high**; other roles keep the project default (Grok).

## Steps

1. **Read the issue and design** — In the `Available artifacts` context, open the listed **absolute** paths for `issue.md` and `design.md` to understand intent and acceptance criteria, including the design's `Acceptance checklist`.
2. **Read the source workspace** — Examine the real project source in the `Source workspace` from context, not an artifact-only replacement project.
3. **Check tests** — Confirm unit tests exist and that the deterministic `unit_test` stage evidence is consistent with a green suite when available.
4. **Check against the design** — Verify architecture, components, data structures, and interfaces.
5. **Reconcile the previous review first** — If `Available artifacts` includes an archived earlier `review.json`, list every prior finding ID in `previous_findings` as `fixed`, `still_open`, or `deferred` (with a reason). You may report new findings, including new CRITICAL/HIGH risks, but they never replace this regression pass.
6. **Categorize findings** by severity:
   - **CRITICAL** — Bugs, security issues, correctness problems.
   - **HIGH** — Significant design violations, missing error handling, untested paths.
   - **MEDIUM** — Code quality issues, unclear naming, minor design deviations.
   - **LOW** — Style nits, optional improvements.
7. **Write the gate artifact:**

```json
// {stage}/{role}/review.json
{
  "approved": true,
  "findings": [
    {
      "id": "F-001",
      "severity": "MEDIUM",
      "file": "src/example.ts",
      "description": "Description of the finding"
    }
  ],
  "previous_findings": [
    { "id": "F-000", "status": "fixed" }
  ],
  "acceptance": [
    { "id": "S1", "status": "passed" }
  ],
  "summary": "Brief summary of the review"
}
```

Each finding needs a stable, unique `id`. The `acceptance` array must cover every checklist ID in the design and each item is `passed`, `failed`, or `not_tested`.

Set `"approved": true` only if every acceptance item is `passed`, every prior finding is `fixed`, and there are no CRITICAL or HIGH findings. If there are CRITICAL or HIGH findings, unresolved prior findings, or incomplete acceptance items, set `"approved": false` and clearly explain what needs to change so the next develop iteration can fix it. `deferred` is allowed only with a reason and cannot accompany approval.
