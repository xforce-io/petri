Implement the project based on the design artifact.

## Steps

1. **Read the design** — Load `design.md` from the workspace. Understand the architecture, components, and test plan before writing any code.
2. **Create the project** — Set up the project structure, dependencies, and configuration files.
3. **Write tests first** — Implement the tests described in the design's test plan. Tests should fail initially (there is no implementation yet).
4. **Write the implementation** — Build each component according to the design. Run tests frequently as you go.
5. **Run all tests** — Execute the full test suite. Every test must pass.
6. **Write the gate artifact:**

```json
// {stage}/{role}/result.json
{
  "tests_passed": true,
  "test_summary": "Brief summary of test results"
}
```

## On retry

If tests fail and you are retried:

1. Read the error output carefully.
2. State a hypothesis for why it failed.
3. Make the minimal change needed to fix it.
4. Run the tests again to verify.

Do not rewrite large sections of code on retry. Targeted fixes are more reliable than rewrites.
