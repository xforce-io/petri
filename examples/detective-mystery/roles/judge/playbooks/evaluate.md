# Evaluate

Compare the detective's accusation against the actual solution.

1. Read the storyteller's solution:
   - Use file_read to find and read `solution.json` from the storyteller's artifacts

2. Read the detective's accusation:
   - Use file_read to find and read `investigation.json` from the detective's artifacts
   - Also read `investigation_notes.md` for the full reasoning

3. Evaluate:
   - Did the detective name the correct killer?
   - Was the reasoning logically sound?
   - Did the detective use actual clues from the scene?

4. Write your verdict to `verdict.md` with:
   - Whether the accusation is CORRECT or INCORRECT
   - What the actual solution was
   - Evaluation of the detective's reasoning
   - A score from 1-10

5. Write the gate artifact `verdict.json`:
   ```json
   {
     "case_closed": true,
     "correct": true/false,
     "score": 1-10,
     "summary": "one line"
   }
   ```
