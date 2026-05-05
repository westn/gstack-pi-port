import type { TemplateContext } from '../types';

export function generateVendoringDeprecation(ctx: TemplateContext): string {
  return `If \`VENDORED_GSTACK\` is \`yes\`, warn once via ask the user in chat unless \`~/.gstack/.vendoring-warned-$SLUG\` exists:

> This project has gstack vendored in \`.pi/skills/gstack/\`. Vendoring is deprecated.
> Migrate to team mode?

Options:
- A) Yes, migrate to team mode now
- B) No, I'll handle it myself

If A:
1. Run \`git rm -r .pi/skills/gstack/\`
2. Run \`echo '.pi/skills/gstack/' >> .gitignore\`
3. Run \`${ctx.paths.binDir}/gstack-team-init required\` (or \`optional\`)
4. Run \`git add .pi/ .gitignore AGENTS.md && git commit -m "chore: migrate gstack from vendored to team mode"\`
5. Tell the user: "Done. Each developer now runs: \`cd ~/.pi/agent/skills/gstack && ./setup --team\`"

If B: say "OK, you're on your own to keep the vendored copy up to date."

Always run (regardless of choice):
\`\`\`bash
eval "$(${ctx.paths.binDir}/gstack-slug 2>/dev/null)" 2>/dev/null || true
touch ~/.gstack/.vendoring-warned-\${SLUG:-unknown}
\`\`\`

If marker exists, skip.`;
}
