/**
 * Benchmark quality judge — wraps llm-judge.ts for provider/model-agnostic scoring.
 *
 * The pi port uses the shared pi-based judge helper so benchmark judging follows
 * the user's configured pi provider/model instead of requiring a hard-coded
 * Anthropic SDK dependency.
 *
 * Judge cost depends on the configured provider/model. Gated by --judge CLI flag.
 */

import type { BenchmarkReport, BenchmarkEntry } from './benchmark-runner';
import { callJudge } from './llm-judge';

interface JudgeResponse {
  scores?: Array<{
    output?: number;
    correctness?: number;
    completeness?: number;
    code_quality?: number;
    edge_cases?: number;
    overall?: number;
    notes?: string;
  }>;
}

export async function judgeEntries(report: BenchmarkReport): Promise<void> {
  const successful = report.entries.filter(e => e.available && e.result && !e.result.error);
  if (successful.length === 0) return;

  const judgePrompt = buildJudgePrompt(report.prompt, successful);
  const judged = await callJudge<JudgeResponse>(judgePrompt);
  const scores = parseScores(judged, successful.length);
  for (let i = 0; i < successful.length; i++) {
    const s = scores[i];
    if (!s) continue;
    successful[i].qualityScore = s.overall;
    successful[i].qualityDetails = s.dimensions;
  }
}

function buildJudgePrompt(prompt: string, entries: BenchmarkEntry[]): string {
  const lines: string[] = [
    'You are a strict, fair technical reviewer scoring N model outputs against the same prompt.',
    '',
    '--- PROMPT ---',
    prompt.length > 4000 ? prompt.slice(0, 4000) + '\n[...truncated for judge budget...]' : prompt,
    '',
    '--- OUTPUTS ---',
  ];
  entries.forEach((e, i) => {
    const r = e.result!;
    const out = r.output.length > 3000 ? r.output.slice(0, 3000) + '\n[...truncated...]' : r.output;
    lines.push(`=== Output ${i + 1}: ${r.modelUsed} ===`);
    lines.push(out);
    lines.push('');
  });
  lines.push('');
  lines.push('Score each output on these dimensions (0-10 per dimension):');
  lines.push('  - correctness:   does it solve what the prompt asked?');
  lines.push('  - completeness:  are edge cases and error paths addressed?');
  lines.push('  - code_quality:  naming, structure, explicitness');
  lines.push('  - edge_cases:    handling of nil/empty/invalid input');
  lines.push('');
  lines.push('Return JSON only, in this exact shape:');
  lines.push('{"scores":[');
  lines.push('  {"output":1,"correctness":N,"completeness":N,"code_quality":N,"edge_cases":N,"overall":N,"notes":"..."},');
  lines.push('  ...');
  lines.push(']}');
  lines.push('');
  lines.push('overall = rounded average of the 4 dimensions. No other commentary.');
  return lines.join('\n');
}

interface ParsedScore {
  overall: number;
  dimensions: Record<string, number>;
}

function parseScores(obj: JudgeResponse, expectedCount: number): ParsedScore[] {
  if (!Array.isArray(obj.scores)) return [];
  return obj.scores.slice(0, expectedCount).map(s => ({
    overall: Number(s.overall ?? 0),
    dimensions: {
      correctness: Number(s.correctness ?? 0),
      completeness: Number(s.completeness ?? 0),
      code_quality: Number(s.code_quality ?? 0),
      edge_cases: Number(s.edge_cases ?? 0),
    },
  }));
}
