Review the developer's code against the design document.

## Steps

1. **Read the design** — Load `design.md` to understand what was intended.
2. **Read the code** — Examine all source files produced by the developer.
3. **Check against the design** — Verify the implementation matches the architecture, components, data structures, and interfaces specified in the design.
4. **Categorize findings** by severity:
   - **CRITICAL** — Bugs, security issues, correctness problems.
   - **HIGH** — Significant design violations, missing error handling, untested paths.
   - **MEDIUM** — Code quality issues, unclear naming, minor design deviations.
   - **LOW** — Style nits, optional improvements.
5. **Write the gate artifact:**

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

Set `"approved": true` only if there are no CRITICAL or HIGH findings. If there are CRITICAL or HIGH findings, set `"approved": false` and clearly explain what needs to change.
