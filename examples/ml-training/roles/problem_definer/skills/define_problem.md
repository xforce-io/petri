# Define Problem

Analyze the user input and produce a formal ML problem specification.

## Steps

1. **Understand the task** — Read the user input carefully. Identify the core ML problem type (classification, regression, clustering, etc.).

2. **Write the problem spec** to `problem_spec.md` including:
   - **Problem type**: classification / regression / clustering / etc.
   - **Input description**: what features the model receives
   - **Output description**: what the model should predict
   - **Dataset**: where to get data, expected size, format. Prefer well-known datasets (sklearn built-in, UCI, etc.) or synthetic data generation.
   - **Evaluation metrics**: primary metric (e.g. accuracy, F1, RMSE) and secondary metrics
   - **Success criteria**: quantitative thresholds the model must meet (e.g. accuracy >= 0.90)
   - **Performance constraints**: max inference time per sample, max model size if applicable
   - **Baseline**: a naive baseline to beat (e.g. majority class, mean prediction)

3. **Write gate artifact** `problem_spec.json`:
   ```json
   {
     "has_success_criteria": true,
     "problem_type": "classification",
     "primary_metric": "accuracy",
     "success_threshold": 0.90,
     "performance_constraint_ms": 100
   }
   ```
   Set `has_success_criteria` to `true` ONLY if the spec includes:
   - A quantitative primary metric threshold (e.g. accuracy >= 0.90)
   - At least one secondary metric
   - A baseline to beat

## Guidelines

- Keep the problem scope realistic for a single training run
- Prefer Python with scikit-learn, PyTorch, or standard ML libraries
- If the user input is vague, make reasonable assumptions and document them
