# Create Mystery

Create a murder mystery scenario:

1. Write the mystery narrative to `mystery_narrative.md` in your artifact directory. Include:
   - The scene (where, when, atmosphere)
   - The victim (who they are, how they died)
   - 3 suspects with brief descriptions
   - 5 clues found at the scene

2. Write the solution (hidden from the detective) to `solution.json`:
   ```json
   {
     "killer": "suspect name",
     "method": "how they did it",
     "motive": "why",
     "key_clues": ["which clues point to the killer"]
   }
   ```

3. Write the gate artifact `mystery.json`:
   ```json
   {"complete": true, "num_suspects": 3, "num_clues": 5}
   ```

Keep it concise — the entire narrative should be under 500 words.
