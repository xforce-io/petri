# Evaluate Debate

Judge the debate by reading all arguments from both sides.

1. Read all artifacts:
   - Proposer's opening (opening stage)
   - Opponent's rebuttal (rebuttal stage)
   - Proposer's closing (closing stage)

2. Write your evaluation to `verdict.md`:
   - Summarize each side's strongest point
   - Score each side on 5 criteria (1-10): evidence, logic, responsiveness, persuasiveness, honesty
   - Show the scorecard as a table
   - Declare a winner with explanation
   - Note what each side could have done better

3. Write gate artifact `verdict.json`:
   ```json
   {
     "verdict_rendered": true,
     "winner": "proposer or opponent",
     "proposer_total": N,
     "opponent_total": N,
     "summary": "one line"
   }
   ```
