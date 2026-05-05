# Design Architecture

Read the problem specification and design the model architecture.

## Steps

1. **Read the problem spec** — Load `problem_spec.md` from the available artifacts. Understand the problem type, data, metrics, and constraints.

2. **Analyze the problem** — Consider:
   - Data characteristics (size, dimensionality, class balance)
   - Feature types (numerical, categorical, text, image)
   - Computational constraints

3. **Write the architecture design** to `architecture.md` including:
   - **Candidate approaches**: list 2-3 viable model families with pros/cons
   - **Selected approach**: which model to use and why
   - **Feature engineering**: preprocessing steps, transformations, feature selection
   - **Model specification**: architecture details (layers, hyperparameters, loss function)
   - **Training plan**: optimizer, learning rate schedule, batch size, epochs, cross-validation strategy
   - **Expected performance**: estimated metric ranges based on problem complexity
   - **Implementation notes**: recommended libraries, code structure

4. **Write gate artifact** `architecture.json`:
   ```json
   {
     "has_justification": true,
     "selected_model": "RandomForestClassifier",
     "candidate_count": 3,
     "selection_reason": "Best accuracy-speed tradeoff for tabular data with <10k samples"
   }
   ```
   Set `has_justification` to `true` ONLY if the design includes:
   - At least 2 candidate approaches with pros/cons comparison
   - A clear reason for the selected approach
   - Concrete hyperparameter specifications

## Guidelines

- Start simple — prefer classical ML over deep learning unless the problem demands it
- Always include a cross-validation strategy
- Specify concrete hyperparameter ranges for tuning
- Consider the inference performance constraints from the problem spec
