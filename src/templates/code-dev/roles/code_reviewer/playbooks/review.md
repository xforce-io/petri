Review the developer's code against the issue brief and design document.
You run through the Agent Provider selected by this role's `role.yaml`; when no
role provider is set, the project default applies (the bundled code-dev default
is the **Grok CLI**).

## Steps

1. **Read the issue and design** — In the `Available artifacts` context, open the listed **absolute** paths for `issue.md` and `design.md` to understand intent and acceptance criteria.
2. **Read the code** — Examine source files produced by the developer.
3. **Check tests** — Confirm unit tests exist and that the deterministic `unit_test` stage evidence is consistent with a green suite when available.
4. **Check against the design** — Verify architecture, components, data structures, and interfaces.
5. **Categorize findings** by severity:
   - **CRITICAL** — Bugs, security issues, correctness problems.
   - **HIGH** — Significant design violations, missing error handling, untested paths.
   - **MEDIUM** — Code quality issues, unclear naming, minor design deviations.
   - **LOW** — Style nits, optional improvements.
6. **Write the gate artifact:**

```json
// {stage}/{role}/review.json
{
  "approved": true,
  "findings": [
    {
      "severity": "MEDIUM",
      "file": "src/example.ts",
      "description": "Description of the finding"
    }
  ],
  "summary": "Brief summary of the review"
}
```

Set `"approved": true` only if there are no CRITICAL or HIGH findings. If there are CRITICAL or HIGH findings, set `"approved": false` and clearly explain what needs to change so the next develop iteration can fix it.
