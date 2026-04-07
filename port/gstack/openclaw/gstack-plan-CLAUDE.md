# gstack-plan: Full Review Gauntlet

Injected by the orchestrator when the user wants to plan a pi project.
Append to existing AGENTS.md.

## Planning Pipeline
1. Read AGENTS.md and understand the project context.
2. Run /skill:office-hours to produce a design doc (problem statement, premises, alternatives).
3. Run /skill:autoplan to review the design (CEO + eng + design + DX reviews + codex adversarial).
4. Save the final reviewed plan to a file the orchestrator can reference later.
   Write it to: plans/<project-slug>-plan-<date>.md in the current repo.
   Include the design doc, all review decisions, and the implementation sequence.
5. Report back to the orchestrator:
   - Plan file path
   - One-paragraph summary of what was designed and the key decisions
   - List of accepted scope expansions (if any)
   - Recommended next step (usually: spawn a new session with gstack-full to implement)

Do not implement anything. This is planning only.
The orchestrator will persist the plan link to its own memory/knowledge store.
