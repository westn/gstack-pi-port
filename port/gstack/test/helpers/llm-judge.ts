/**
 * Shared LLM-as-judge helpers for eval and E2E tests.
 *
 * Routes judge prompts through the local `pi` CLI so evals can use whichever
 * provider/model the developer has configured (subscription or API key).
 *
 * Optional env overrides:
 * - PI_EVAL_PROVIDER
 * - PI_EVAL_MODEL
 * - PI_EVAL_THINKING
 * - PI_EVAL_TIMEOUT_MS (default: 60000)
 * - PI_BIN (default: pi)
 */

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

const RETRYABLE_PATTERNS = [
  /\b429\b/,
  /rate\s*limit/i,
  /temporarily\s+unavailable/i,
  /timeout/i,
  /econnreset/i,
  /connection\s*refused/i,
];

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractTextFromMessage(message: any): string {
  if (!message) return '';
  if (typeof message === 'string') return message;

  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
    .map((item: any) => item.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractAssistantTextFromJsonLines(lines: string[]): string {
  let lastAssistantText = '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    try {
      const event = JSON.parse(line);

      if (event.type === 'turn_end' && event.message?.role === 'assistant') {
        const text = extractTextFromMessage(event.message);
        if (text) lastAssistantText = text;
        continue;
      }

      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const text = extractTextFromMessage(event.message);
        if (text) lastAssistantText = text;
        continue;
      }

      if (event.type === 'agent_end' && Array.isArray(event.messages)) {
        const lastAssistant = [...event.messages].reverse().find((m: any) => m?.role === 'assistant');
        const text = extractTextFromMessage(lastAssistant);
        if (text) lastAssistantText = text;
      }
    } catch {
      // ignore malformed lines
    }
  }

  return lastAssistantText;
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();

  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    const candidate = fenced[1].trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    return trimmed.slice(first, last + 1);
  }

  throw new Error(`Judge returned non-JSON: ${trimmed.slice(0, 200)}`);
}

async function runPiJudgePrompt(prompt: string): Promise<{ text: string; stderr: string }> {
  const piBin = process.env.PI_BIN || 'pi';
  const timeoutMs = Number(process.env.PI_EVAL_TIMEOUT_MS || 60_000);

  const args = ['--mode', 'json', '--print', '--no-session', '--no-tools'];
  if (process.env.PI_EVAL_PROVIDER) args.push('--provider', process.env.PI_EVAL_PROVIDER);
  if (process.env.PI_EVAL_MODEL) args.push('--model', process.env.PI_EVAL_MODEL);
  if (process.env.PI_EVAL_THINKING) args.push('--thinking', process.env.PI_EVAL_THINKING);
  args.push(prompt);

  const proc = Bun.spawn([piBin, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timer = setTimeout(() => {
    try { proc.kill(); } catch {}
  }, timeoutMs);

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  clearTimeout(timer);

  if (exitCode !== 0) {
    throw new Error(`pi judge failed (exit ${exitCode}): ${(stderr || stdout).slice(0, 500)}`);
  }

  const text = extractAssistantTextFromJsonLines(stdout.split('\n'));
  if (!text) {
    throw new Error(`pi judge produced no assistant text: ${(stdout || stderr).slice(0, 500)}`);
  }

  return { text, stderr };
}

/**
 * Call the configured pi model with a prompt and extract JSON response.
 * Retries once on transient errors (e.g. rate limits / temporary provider issues).
 */
export async function callJudge<T>(prompt: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text } = await runPiJudgePrompt(prompt);
      const jsonText = extractJsonObject(text);
      return JSON.parse(jsonText) as T;
    } catch (err: any) {
      lastError = err;
      const message = `${err?.message || ''}`;
      const retryable = RETRYABLE_PATTERNS.some((rx) => rx.test(message));
      if (attempt < 2 && retryable) {
        await sleep(1000);
        continue;
      }
      throw err;
    }
  }

  throw lastError;
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
