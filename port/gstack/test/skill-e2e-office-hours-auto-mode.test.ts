/**
 * office-hours ask the user in chat-blocked regression (gate, paid, real-PTY).
 *
 * v1.21+ regression: Conductor launches pi with
 * `--disallowedTools ask the user in chat --permission-mode default` (verified
 * by inspecting the parent claude process via `ps`). office-hours' first
 * step issues a startup-vs-builder mode ask the user in chat
 * (office-hours/SKILL.md.tmpl:69); when ask the user in chat is disallowed at
 * the tool-registry level the model cannot ask and silently picks one mode,
 * breaking the whole interactive premise. This test asserts that question
 * still surfaces — fix must route through mcp__conductor__ask the user in chat
 * (when present) or plan-file + ExitPlanMode flow.
 *
 * Filename keeps `auto-mode` for branch-history continuity. Auto-mode (the
 * AUTO_DECIDE preamble path when QUESTION_TUNING=true) is a related but
 * distinct silencing mechanism; both share the same fix surface.
 */

import { describe, test, expect } from 'bun:test';
import { runPlanSkillObservation, planFileHasDecisionsSection } from './helpers/claude-pty-runner';

const shouldRun = !!process.env.EVALS && process.env.EVALS_TIER === 'gate';
const describeE2E = shouldRun ? describe : describe.skip;

describeE2E('office-hours ask the user in chat-blocked smoke (gate)', () => {
  // Pass envelope is ['asked', 'plan_ready']; failure signals are
  // 'auto_decided' + silent_write/exited/timeout.
  test('ask the user in chat surfaces when --disallowedTools ask the user in chat is set', async () => {
    const obs = await runPlanSkillObservation({
      skillName: 'office-hours',
      inPlanMode: true,
      extraArgs: ['--disallowedTools', 'ask the user in chat'],
      timeoutMs: 300_000,
    });

    if (
      obs.outcome === 'auto_decided' ||
      obs.outcome === 'silent_write' ||
      obs.outcome === 'exited' ||
      obs.outcome === 'timeout'
    ) {
      throw new Error(
        `office-hours ask the user in chat-blocked regression: outcome=${obs.outcome}\n` +
          `summary: ${obs.summary}\n` +
          `elapsed: ${obs.elapsedMs}ms\n` +
          `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
      );
    }
    if (obs.outcome === 'plan_ready') {
      if (!obs.planFile || !planFileHasDecisionsSection(obs.planFile)) {
        throw new Error(
          `office-hours ask the user in chat-blocked regression: plan_ready without a "## Decisions" section in ${obs.planFile ?? '<no plan file detected>'} — startup-vs-builder mode question was silently skipped.\n` +
            `--- evidence (last 2KB visible) ---\n${obs.evidence}`,
        );
      }
    }
    expect(['asked', 'plan_ready']).toContain(obs.outcome);
  }, 360_000);
});
