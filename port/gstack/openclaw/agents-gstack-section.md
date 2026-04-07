## Coding Tasks (gstack)

### Rules (non-negotiable)

1. **Always spawn, never redirect.** When user asks to use ANY gstack skill,
   ALWAYS spawn a pi session via sessions_spawn. Never tell user to
   open pi himself. Never say "this needs to run in pi."
   Never say "you'll need to open pi for that." Just do it.

2. **Resolve the repo.** If user names a repo or project, set the working
   directory to that repo path. If the repo path isn't known, ask which
   repo — don't punt to telling the user to open pi.

3. **Autoplan runs end-to-end.** For /skill:autoplan specifically: spawn the session,
   let it run the full review pipeline (CEO → design → eng), and when it
   finishes, report the plan back here in chat. Write the plan to memory so
   the user can find it later. User should never have to leave Telegram.

### Dispatch Routing

When asked for coding work, pick the dispatch tier:

**SIMPLE:** "fix this typo," "update that config," single-file changes
→ sessions_spawn(runtime: "acp", prompt: "<just the task>")

**MEDIUM:** multi-file features, refactors, skill edits
→ sessions_spawn(runtime: "acp", prompt: "<gstack-lite content>\n\n<task>")

**HEAVY:** needs a specific gstack methodology
→ sessions_spawn(runtime: "acp", prompt: "Load gstack. Run /skill:qa https://...")
  Skills: /skill:cso, /skill:review, /skill:qa, /skill:ship, /skill:investigate, /skill:design-review, /skill:benchmark, /skill:gstack-upgrade

**FULL:** build a complete feature, multi-day scope, needs planning + review
→ sessions_spawn(runtime: "acp", prompt: "<gstack-full content>\n\n<task>")
  pi runs: /skill:autoplan → implement → /skill:ship → report back

**PLAN:** user wants to plan a pi project, spec out a feature, or design
  something before any code is written
→ sessions_spawn(runtime: "acp", prompt: "<gstack-plan content>\n\n<task>")
  pi runs: /skill:office-hours → /skill:autoplan → saves plan file → reports back
  Persist the plan link to memory/knowledge store.
  When the user is ready to implement, spawn a new FULL session pointing at the plan.

### Decision Heuristic

- Can it be done in <10 lines of code? → **SIMPLE**
- Does it touch multiple files but the approach is obvious? → **MEDIUM**
- Does the user name a specific skill (/skill:cso, /skill:review, /skill:qa)? → **HEAVY**
- "Upgrade gstack", "update gstack" → **HEAVY** with `Run /skill:gstack-upgrade`
- Is it a feature, project, or objective (not a task)? → **FULL**
- Does the user want to PLAN something without implementing yet? → **PLAN**
