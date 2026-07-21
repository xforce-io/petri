Create a design document for the given task. Start from the issue brief.

## Steps

1. **Read the issue** — In the `Available artifacts` context, open the listed **absolute** paths for `issue.md` (and `issue.json` if present). Align design with acceptance criteria.
2. **Architecture** — High-level structure and how components fit together.
3. **Components** — Each module or unit, its responsibility, and its public interface.
4. **Data structures** — Key types, schemas, or models used across the system.
5. **Test plan** — What to test first (TDD), how to test it, and what constitutes passing. This feeds the developer and the deterministic `unit_test` command stage.
6. **Acceptance checklist** — Add a short `## Acceptance checklist` section with stable IDs (for example `S1`, `S2`) and observable pass conditions. State the delivery boundary and non-goals. The reviewer must report each ID in `review.json`; do not invent business-domain rules beyond the issue.

Write your design to `design.md` in the workspace.

When the design is complete, write the gate artifact:

```json
// {stage}/{role}/design.json
{
  "completed": true,
  "summary": "Brief summary of the design"
}
```

Keep the design concise and actionable. The developer should implement directly from it without guessing your intent.
