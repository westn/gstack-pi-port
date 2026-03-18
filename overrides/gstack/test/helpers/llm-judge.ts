/**
 * Shared LLM-as-judge helpers for eval and E2E tests.
 *
 * Provides callJudge (generic JSON-from-LLM), judge (doc quality scorer),
 * and outcomeJudge (planted-bug detection scorer).
 *
 * Requires: pi CLI configured with any supported provider/model.
 * Optional overrides:
 * - PI_EVAL_PROVIDER
 * - PI_EVAL_MODEL
 * - PI_EVAL_THINKING
 */

import { spawnSync } from 'child_process';

export interface JudgeScore {
  clarity: number;       // 1-5
  completeness: number;  // 1-5
  actionability: number; // 1-5
  reasoning: string;
}

export interface OutcomeJudgeResult {
  detected: string[];
  missed: string[];
  false_positives: number;
  detection_rate: number;
  evidence_quality: number;
  reasoning: string;
}

function extractAssistantTextFromJsonl(stdout: string): string {
  const lines = stdout.split('\n').filter(l => l.trim());
  let latest = '';

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      if (event?.type === 'turn_end' && event?.message?.role === 'assistant') {
        const chunks = (event.message.content || [])
          .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
          .map((c: any) => c.text);
        if (chunks.length > 0) latest = chunks.join('\n').trim();
      }

      if (event?.type === 'agent_end' && Array.isArray(event?.messages)) {
        for (const msg of event.messages) {
          if (msg?.role !== 'assistant') continue;
          const chunks = (msg.content || [])
            .filter((c: any) => c?.type === 'text' && typeof c.text === 'string')
            .map((c: any) => c.text);
          if (chunks.length > 0) latest = chunks.join('\n').trim();
        }
      }
    } catch {
      // ignore malformed lines
    }
  }

  return latest;
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }

  throw new Error(`Judge returned non-JSON: ${text.slice(0, 400)}`);
}

function runPiJudge(prompt: string): { text: string; stdout: string; stderr: string; status: number } {
  const args = [
    '--no-session',
    '--no-tools',
    '--mode', 'json',
  ];

  if (process.env.PI_EVAL_PROVIDER) {
    args.push('--provider', process.env.PI_EVAL_PROVIDER);
  }
  if (process.env.PI_EVAL_MODEL) {
    args.push('--model', process.env.PI_EVAL_MODEL);
  }
  if (process.env.PI_EVAL_THINKING) {
    args.push('--thinking', process.env.PI_EVAL_THINKING);
  }

  args.push('-p');

  const proc = spawnSync('pi', args, {
    input: prompt,
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: 90_000,
  });

  if (proc.error) {
    throw proc.error;
  }

  const stdout = proc.stdout || '';
  const stderr = proc.stderr || '';
  const text = extractAssistantTextFromJsonl(stdout);

  return {
    text,
    stdout,
    stderr,
    status: proc.status ?? 1,
  };
}

/**
 * Call pi with a judge prompt, extract JSON response.
 * Retries once on transient provider failures / rate limits.
 */
export async function callJudge<T>(prompt: string): Promise<T> {
  const isRetryable = (msg: string) =>
    /429|rate limit|temporarily unavailable|timeout|ECONNRESET|ECONNREFUSED/i.test(msg);

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = runPiJudge(prompt);

      if (res.status !== 0 && !res.text) {
        throw new Error(`pi judge failed (exit ${res.status}): ${res.stderr.slice(0, 500)}`);
      }

      const jsonText = extractJsonObject(res.text || res.stdout || res.stderr);
      return JSON.parse(jsonText) as T;
    } catch (err: any) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < 2 && isRetryable(lastError.message)) {
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      break;
    }
  }

  throw lastError ?? new Error('Unknown judge failure');
}

/**
 * Score documentation quality on clarity/completeness/actionability (1-5).
 */
export async function judge(section: string, content: string): Promise<JudgeScore> {
  return callJudge<JudgeScore>(`You are evaluating documentation quality for an AI coding agent's CLI tool reference.

The agent reads this documentation to learn how to use a headless browser CLI. It needs to:
1. Understand what each command does
2. Know what arguments to pass
3. Know valid values for enum-like parameters
4. Construct correct command invocations without guessing

Rate the following ${section} on three dimensions (1-5 scale):

- **clarity** (1-5): Can an agent understand what each command/flag does from the description alone?
- **completeness** (1-5): Are arguments, valid values, and important behaviors documented? Would an agent need to guess anything?
- **actionability** (1-5): Can an agent construct correct command invocations from this reference alone?

Scoring guide:
- 5: Excellent — no ambiguity, all info present
- 4: Good — minor gaps an experienced agent could infer
- 3: Adequate — some guessing required
- 2: Poor — significant info missing
- 1: Unusable — agent would fail without external help

Respond with ONLY valid JSON in this exact format:
{"clarity": N, "completeness": N, "actionability": N, "reasoning": "brief explanation"}

Here is the ${section} to evaluate:

${content}`);
}

/**
 * Evaluate a QA report against planted-bug ground truth.
 * Returns detection metrics for the planted bugs.
 */
export async function outcomeJudge(
  groundTruth: any,
  report: string,
): Promise<OutcomeJudgeResult> {
  return callJudge<OutcomeJudgeResult>(`You are evaluating a QA testing report against known ground truth bugs.

GROUND TRUTH (${groundTruth.total_bugs} planted bugs):
${JSON.stringify(groundTruth.bugs, null, 2)}

QA REPORT (generated by an AI agent):
${report}

For each planted bug, determine if the report identified it. A bug counts as
"detected" if the report describes the same defect, even if the wording differs.
Use the detection_hint keywords as guidance.

Also count false positives: issues in the report that don't correspond to any
planted bug AND aren't legitimate issues with the page.

Respond with ONLY valid JSON:
{
  "detected": ["bug-id-1", "bug-id-2"],
  "missed": ["bug-id-3"],
  "false_positives": 0,
  "detection_rate": 2,
  "evidence_quality": 4,
  "reasoning": "brief explanation"
}

Rules:
- "detected" and "missed" arrays must only contain IDs from the ground truth: ${groundTruth.bugs.map((b: any) => b.id).join(', ')}
- detection_rate = length of detected array
- evidence_quality (1-5): Do detected bugs have screenshots, repro steps, or specific element references?
  5 = excellent evidence for every bug, 1 = no evidence at all`);
}
