# Develop Model

Implement, train, and evaluate the model based on the architecture design.

## Steps

1. **Read the artifacts** — Load `problem_spec.md` and `architecture.md` from available artifacts. Understand what to build and how.

2. **Set up the environment** — Install required dependencies using pip if needed.

3. **Implement the training script** — Write `train.py` that:
   - Loads and preprocesses the dataset
   - Implements the feature engineering pipeline from the architecture
   - Splits data into train/validation/test sets
   - Trains the model following the architecture spec
   - Performs hyperparameter tuning if specified
   - Evaluates on the test set
   - Prints all metrics clearly
   - Saves the trained model to `model.pkl` (or appropriate format)
   - Saves evaluation results to `evaluation.json`

4. **Run the training** — Execute `python train.py` and capture the output.

5. **Write evaluation results** to `evaluation.json`:
   ```json
   {
     "primary_metric": "accuracy",
     "primary_value": 0.95,
     "metrics": {
       "accuracy": 0.95,
       "f1_score": 0.94,
       "precision": 0.93,
       "recall": 0.95
     },
     "training_time_seconds": 12.5,
     "model_size_bytes": 45000
   }
   ```

6. **Write gate artifact** `result.json`:
   ```json
   {
     "meets_threshold": true,
     "primary_metric": "accuracy",
     "primary_value": 0.95,
     "threshold": 0.90,
     "cv_mean": 0.94,
     "cv_std": 0.02
   }
   ```
   Set `meets_threshold` to `true` ONLY if:
   - The primary metric on the test set meets or exceeds the threshold from the problem spec
   - Cross-validation mean is also above the threshold (not just a lucky split)
   
   If training succeeds but metrics are below threshold, set `meets_threshold` to `false` — the gate will fail and you will be retried with feedback.

## On retry

If training fails:
1. Read the error output carefully
2. Check for missing dependencies, data loading issues, or code bugs
3. Fix the minimal issue and re-run
4. Do not redesign the architecture — work within the given spec

## Guidelines

- Always set `random_state=42` or equivalent for reproducibility
- Use cross-validation, not just a single train/test split
- Print metrics in a clear, parseable format
- Save all artifacts even if metrics are below threshold — the tester needs them
