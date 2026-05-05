Create a design document for the given task. Your design should cover:

1. **Architecture** — High-level structure and how components fit together.
2. **Components** — Each module or unit, its responsibility, and its public interface.
3. **Data structures** — Key types, schemas, or models used across the system.
4. **Test plan** — What to test, how to test it, and what constitutes passing.

Write your design to `design.md` in the workspace.

When the design is complete, write the gate artifact:

```json
// {stage}/{role}/design.json
{
  "completed": true,
  "summary": "Brief summary of the design"
}
```

Keep the design concise and actionable. The developer should be able to implement directly from it without guessing your intent.
