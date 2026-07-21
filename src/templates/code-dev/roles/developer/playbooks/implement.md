Implement the project with **TDD**, based on the issue brief and design artifact.

## Steps

1. **Read the issue and design** — In the `Available artifacts` context, open the listed **absolute** paths for `issue.md` and `design.md`. Understand acceptance criteria, architecture, components, and the test plan before writing production code.
2. **Work in the source workspace** — The context names a **Source workspace** and a separate evidence artifact directory. Read and modify project source, dependencies, and configuration only in the source workspace. Do not create a replacement project inside the artifact directory.
3. **Write tests first (TDD red)** — Implement the tests described in the design's test plan. Tests should fail initially when there is no implementation yet.
4. **Write the implementation (TDD green)** — Build each component according to the design. Run tests frequently as you go.
5. **Run all tests** — Execute the full test suite. Every test must pass.
6. **Leave the real project runnable** — The deterministic `unit_test` stage runs a **pure** suite from the source workspace root (`npm test` or `python -m pytest`). Do not rely on lint-bundled wrappers (e.g. `tests/run_tests.sh unit` that runs full-repo ruff first) for the harness gate; if the project needs a custom pure command, configure `unit_test.command` in the pipeline. Write only the role gate artifact to the evidence directory.
7. **Write the gate artifact:**

```json
// {stage}/{role}/result.json
{
  "tests_passed": true,
  "test_summary": "Brief summary of test results"
}
```

## On retry

If tests fail and you are retried (or review rejected the last iteration):

1. Read the error / review findings carefully.
2. State a hypothesis for why it failed.
3. Make the minimal change needed to fix it.
4. Run the tests again to verify.

Do not rewrite large sections of code on retry. Targeted fixes are more reliable than rewrites.
