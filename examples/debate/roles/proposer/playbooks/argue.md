# Argue

Present your argument on the given topic.

1. If this is the OPENING stage:
   - Read the user input for the debate topic
   - Write your opening argument to `argument.md` (400-600 words)
   - Structure: thesis, 3 main arguments with evidence, conclusion

2. If this is the CLOSING stage:
   - Read the opponent's rebuttal from the available artifacts (look for argument.md in the rebuttal stage)
   - Write your closing statement to `argument.md` (300-400 words)
   - Address the opponent's strongest points
   - Reinforce your best arguments
   - End with a powerful final statement

3. Write gate artifact `argument.json`:
   ```json
   {"submitted": true, "stage": "opening or closing", "word_count": N}
   ```
