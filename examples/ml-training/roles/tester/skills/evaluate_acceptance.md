# Evaluate Acceptance

Perform acceptance testing on the trained model against the problem specification.

## Steps

1. **Read the artifacts** — Load:
   - `problem_spec.md` — success criteria, metrics, performance constraints
   - `architecture.md` — expected model characteristics
   - `evaluation.json` — reported metrics from training

2. **Write the acceptance test script** — Write `acceptance_test.py` that:
   - Loads the trained model from `model.pkl`
   - Loads the test dataset (same source as training)
   - **Accuracy tests**:
     - Verify primary metric meets threshold from problem spec
     - Report all secondary metrics
     - Check per-class performance (precision, recall per class)
   - **Inference performance tests**:
     - Measure average inference time per sample (over 100+ samples)
     - Measure peak memory usage during inference
     - Report throughput (samples/second)
   - **Robustness tests**:
     - Test with edge-case inputs if applicable
     - Check prediction consistency (same input → same output)
   - Print all results clearly

3. **Run the acceptance tests** — Execute `python acceptance_test.py` and capture the output.

4. **Write the acceptance report** to `acceptance_report.md` including:
   - **Summary**: PASS or FAIL with one-line reason
   - **Accuracy results**: metric values vs. thresholds, per-class breakdown
   - **Performance results**: latency, throughput, memory
   - **Robustness results**: edge case handling
   - **Verdict**: final recommendation with evidence

5. **Write gate artifact** `acceptance.json`:
   ```json
   {
     "all_passed": true,
     "accuracy_passed": true,
     "performance_passed": true,
     "robustness_passed": true,
     "primary_metric": "accuracy",
     "primary_value": 0.95,
     "threshold": 0.90,
     "avg_inference_ms": 0.5,
     "samples_per_second": 2000,
     "consistency_check": true
   }
   ```

   Set `all_passed` to `true` ONLY if ALL three sub-checks pass:
   - `accuracy_passed`: primary metric meets or exceeds the success threshold
   - `performance_passed`: inference time within acceptable limits (< 100ms per sample unless specified otherwise)
   - `robustness_passed`: model produces consistent predictions on repeated identical inputs

## On retry

If acceptance fails, provide specific feedback:
- Which metrics failed and by how much
- Suggestions for improvement (e.g. "accuracy is 0.85 vs 0.90 threshold — consider feature engineering or hyperparameter tuning")

## Guidelines

- Never modify the model — your job is to evaluate, not fix
- Be strict on the success threshold — close is not passing
- Measure performance on the same machine for consistency
- Report all numbers with appropriate precision
