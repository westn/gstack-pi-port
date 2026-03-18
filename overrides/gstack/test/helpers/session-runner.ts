/**
 * pi CLI subprocess runner for skill E2E testing.
 *
 * Spawns `pi --mode json -p` as a completely independent process,
 * so it works inside pi sessions. Pipes prompt via stdin, streams
 * JSONL output for real-time progress, and scans for browse errors.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const GSTACK_DEV_DIR = path.join(os.homedir(), '.gstack-dev');
const HEARTBEAT_PATH = path.join(GSTACK_DEV_DIR, 'e2e-live.json');

/** Sanitize test name for use as filename: strip leading slashes, replace / with - */
export function sanitizeTestName(name: string): string {
  const normalized = name.replace(/^\/+/, '').replace(/^skill:/, '');
  return normalized.replace(/\//g, '-');
}

/** Atomic write: write to .tmp then rename. Non-fatal on error. */
function atomicWriteSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

export interface CostEstimate {
  inputChars: number;
  outputChars: number;
  estimatedTokens: number;
  estimatedCost: number;  // USD
  turnsUsed: number;
}

export interface SkillTestResult {
  toolCalls: Array<{ tool: string; input: any; output: string }>;
  browseErrors: string[];
  exitReason: string;
  duration: number;
  output: string;
  costEstimate: CostEstimate;
  transcript: any[];
}

const BROWSE_ERROR_PATTERNS = [
  /Unknown command: \w+/,
  /Unknown snapshot flag: .+/,
  /ERROR: browse binary not found/,
  /Server failed to start/,
  /no such file or directory.*browse/i,
];

// --- Testable JSONL parser ---

export interface ParsedNDJSON {
  transcript: any[];
  resultLine: any | null;
  turnCount: number;
  toolCallCount: number;
  toolCalls: Array<{ tool: string; input: any; output: string }>;
  totalCostUsd: number;
  totalTokens: number;
  outputText: string;
}

function extractTextChunks(content: any): string {
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const item of content) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;

    if (item.type === 'text' && typeof item.text === 'string') {
      out.push(item.text);
      continue;
    }

    // Legacy fallback shapes
    if (typeof (item as any).content === 'string') {
      out.push((item as any).content);
    }
  }
  return out.join('\n').trim();
}

function readUsageCost(usage: any): { tokens: number; cost: number } {
  if (!usage || typeof usage !== 'object') return { tokens: 0, cost: 0 };

  const tokens = Number(
    usage.totalTokens
      ?? usage.total_tokens
      ?? (
        Number(usage.input ?? usage.input_tokens ?? 0)
        + Number(usage.output ?? usage.output_tokens ?? 0)
        + Number(usage.cacheRead ?? usage.cache_read_input_tokens ?? 0)
        + Number(usage.cacheWrite ?? usage.cache_creation_input_tokens ?? 0)
      ),
  ) || 0;

  const cost = Number(
    usage.cost?.total
      ?? usage.cost?.total_cost
      ?? usage.total_cost_usd
      ?? 0,
  ) || 0;

  return { tokens, cost };
}

/**
 * Parse an array of JSONL lines into structured transcript data.
 *
 * Supports both:
 * - legacy Claude-style stream-json events (`assistant`, `result`, `tool_use`)
 * - pi JSON mode events (`turn_end`, `tool_execution_start`, `agent_end`)
 */
export function parseNDJSON(lines: string[]): ParsedNDJSON {
  const transcript: any[] = [];
  let resultLine: any = null;
  let turnCount = 0;
  let toolCallCount = 0;
  const toolCalls: ParsedNDJSON['toolCalls'] = [];
  const seenToolIds = new Set<string>();
  let totalCostUsd = 0;
  let totalTokens = 0;
  let outputText = '';

  const pushToolCall = (id: string | null, name: string, input: any) => {
    const dedupeId = id || `${name}:${JSON.stringify(input ?? {})}`;
    if (seenToolIds.has(dedupeId)) return;
    seenToolIds.add(dedupeId);
    toolCallCount++;
    toolCalls.push({
      tool: name || 'unknown',
      input: input || {},
      output: '',
    });
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      transcript.push(event);

      // Legacy: claude stream-json assistant event
      if (event.type === 'assistant') {
        turnCount++;
        const content = event.message?.content || [];
        for (const item of content) {
          if (item?.type === 'tool_use') {
            pushToolCall(item.id || null, item.name || 'unknown', item.input || {});
          }
        }
      }

      // Legacy: claude stream-json result event
      if (event.type === 'result') {
        resultLine = event;
        if (typeof event.result === 'string' && event.result.trim()) {
          outputText = event.result.trim();
        }
        const usage = event.usage || {};
        totalTokens += Number(
          usage.input_tokens || 0,
        ) + Number(
          usage.output_tokens || 0,
        ) + Number(
          usage.cache_read_input_tokens || 0,
        ) + Number(
          usage.cache_creation_input_tokens || 0,
        );
        totalCostUsd += Number(event.total_cost_usd || 0);
      }

      // pi: explicit tool execution start event
      if (event.type === 'tool_execution_start') {
        pushToolCall(event.toolCallId || null, event.toolName || 'unknown', event.args || {});
      }

      // pi: assistant turn summary contains full content + usage
      if (event.type === 'turn_end' && event.message?.role === 'assistant') {
        turnCount++;
        const content = event.message?.content || [];
        for (const item of content) {
          if (item?.type === 'toolCall') {
            pushToolCall(item.id || null, item.name || 'unknown', item.arguments || {});
          }
        }

        const turnText = extractTextChunks(content);
        if (turnText) outputText = turnText;

        const { tokens, cost } = readUsageCost(event.message?.usage);
        totalTokens += tokens;
        totalCostUsd += cost;
      }

      // pi: final session summary includes all messages
      if (event.type === 'agent_end' && Array.isArray(event.messages)) {
        for (const msg of event.messages) {
          if (msg?.role !== 'assistant') continue;

          const content = msg?.content || [];
          for (const item of content) {
            if (item?.type === 'toolCall') {
              pushToolCall(item.id || null, item.name || 'unknown', item.arguments || {});
            }
          }

          const msgText = extractTextChunks(content);
          if (msgText) outputText = msgText;

          const { tokens, cost } = readUsageCost(msg?.usage);
          totalTokens += tokens;
          totalCostUsd += cost;
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return {
    transcript,
    resultLine,
    turnCount,
    toolCallCount,
    toolCalls,
    totalCostUsd,
    totalTokens,
    outputText,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function shellQuote(s: string): string {
  return JSON.stringify(s);
}

// --- Main runner ---

export async function runSkillTest(options: {
  prompt: string;
  workingDirectory: string;
  maxTurns?: number;
  allowedTools?: string[];
  timeout?: number;
  testName?: string;
  runId?: string;
}): Promise<SkillTestResult> {
  const {
    prompt,
    workingDirectory,
    maxTurns = 15,
    allowedTools = ['bash', 'read', 'write'],
    timeout = 120_000,
    testName,
    runId,
  } = options;

  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  // Set up per-run log directory if runId is provided
  let runDir: string | null = null;
  const safeName = testName ? sanitizeTestName(testName) : null;
  if (runId) {
    try {
      runDir = path.join(GSTACK_DEV_DIR, 'e2e-runs', runId);
      fs.mkdirSync(runDir, { recursive: true });
    } catch { /* non-fatal */ }
  }

  const normalizedTools = allowedTools
    .map(t => t.trim().toLowerCase())
    .filter(Boolean)
    .join(',');

  // pi doesn't expose max-turns today; timeout remains the hard upper bound.
  const args = [
    '--no-session',
    '--mode', 'json',
  ];

  if (normalizedTools) {
    args.push('--tools', normalizedTools);
  }

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

  // Provide a soft turn budget hint in the prompt for consistency with old maxTurns behavior.
  const boundedPrompt = `Turn budget hint: keep this within ~${maxTurns} turns.\n\n${prompt}`;

  // Write prompt to a temp file and pipe it via shell to avoid stdin buffering issues.
  const promptFile = path.join(workingDirectory, '.prompt-tmp');
  fs.writeFileSync(promptFile, boundedPrompt);

  const command = `cat ${shellQuote(promptFile)} | pi ${args.map(shellQuote).join(' ')}`;
  const proc = Bun.spawn(['sh', '-c', command], {
    cwd: workingDirectory,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Race against timeout
  let stderr = '';
  let exitReason = 'unknown';
  let timedOut = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);

  // Stream JSONL from stdout for real-time progress
  const collectedLines: string[] = [];
  let liveTurnCount = 0;
  let liveToolCount = 0;
  const stderrPromise = new Response(proc.stderr).text();

  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        collectedLines.push(line);

        // Real-time progress to stderr + persistent logs
        try {
          const event = JSON.parse(line);

          if (event.type === 'turn_end' && event.message?.role === 'assistant') {
            liveTurnCount++;
          }

          if (event.type === 'tool_execution_start') {
            liveToolCount++;
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            const toolName = event.toolName || 'unknown';
            const toolArgs = event.args || {};
            const progressLine = `  [${elapsed}s] turn ${liveTurnCount} tool #${liveToolCount}: ${toolName}(${truncate(JSON.stringify(toolArgs), 80)})\n`;
            process.stderr.write(progressLine);

            // Persist progress.log
            if (runDir) {
              try { fs.appendFileSync(path.join(runDir, 'progress.log'), progressLine); } catch { /* non-fatal */ }
            }

            // Write heartbeat (atomic)
            if (runId && testName) {
              try {
                const toolDesc = `${toolName}(${truncate(JSON.stringify(toolArgs), 60)})`;
                atomicWriteSync(HEARTBEAT_PATH, JSON.stringify({
                  runId,
                  pid: proc.pid,
                  startedAt,
                  currentTest: testName,
                  status: 'running',
                  turn: liveTurnCount,
                  toolCount: liveToolCount,
                  lastTool: toolDesc,
                  lastToolAt: new Date().toISOString(),
                  elapsedSec: elapsed,
                }, null, 2) + '\n');
              } catch { /* non-fatal */ }
            }
          }
        } catch {
          // Skip parse errors — parseNDJSON handles malformed lines later.
        }

        // Append raw JSONL line to per-test transcript file
        if (runDir && safeName) {
          try { fs.appendFileSync(path.join(runDir, `${safeName}.ndjson`), line + '\n'); } catch { /* non-fatal */ }
        }
      }
    }
  } catch {
    // Stream read error — fall through to exit code handling.
  }

  // Flush remaining buffer
  if (buf.trim()) {
    collectedLines.push(buf);
  }

  stderr = await stderrPromise;
  const exitCode = await proc.exited;
  clearTimeout(timeoutId);

  try { fs.unlinkSync(promptFile); } catch { /* non-fatal */ }

  if (timedOut) {
    exitReason = 'timeout';
  } else if (exitCode === 0) {
    exitReason = 'success';
  } else {
    exitReason = `exit_code_${exitCode}`;
  }

  const duration = Date.now() - startTime;

  // Parse all collected JSONL lines
  const parsed = parseNDJSON(collectedLines);
  const { transcript, resultLine, toolCalls } = parsed;
  const browseErrors: string[] = [];

  // Scan transcript + stderr for browse errors
  const allText = transcript.map(e => JSON.stringify(e)).join('\n') + '\n' + stderr;
  for (const pattern of BROWSE_ERROR_PATTERNS) {
    const match = allText.match(pattern);
    if (match) {
      browseErrors.push(match[0].slice(0, 200));
    }
  }

  // Legacy result semantics
  if (resultLine) {
    if (resultLine.is_error) {
      exitReason = 'error_api';
    } else if (resultLine.subtype === 'success') {
      exitReason = 'success';
    } else if (resultLine.subtype) {
      exitReason = resultLine.subtype;
    }
  }

  // pi error semantics
  const hasErrorEvent = transcript.some((event: any) =>
    event?.type === 'error'
    || event?.type === 'fatal_error'
    || event?.isError === true,
  );
  if (hasErrorEvent && exitReason === 'success') {
    exitReason = 'error_api';
  }

  if (/ConnectionRefused|Unable to connect|ECONNREFUSED|rate limit/i.test(allText) && exitReason === 'success') {
    exitReason = 'error_api';
  }

  const output = parsed.outputText || resultLine?.result || '';

  // Save failure transcript to persistent run directory (or fallback to workingDirectory)
  if (browseErrors.length > 0 || exitReason !== 'success') {
    try {
      const failureDir = runDir || path.join(workingDirectory, '.gstack', 'test-transcripts');
      fs.mkdirSync(failureDir, { recursive: true });
      const failureName = safeName
        ? `${safeName}-failure.json`
        : `e2e-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      fs.writeFileSync(
        path.join(failureDir, failureName),
        JSON.stringify({
          prompt: boundedPrompt.slice(0, 500),
          testName: testName || 'unknown',
          exitReason,
          browseErrors,
          duration,
          turnAtTimeout: timedOut ? parsed.turnCount : undefined,
          lastToolCall: toolCalls.length > 0
            ? `${toolCalls[toolCalls.length - 1].tool}(${JSON.stringify(toolCalls[toolCalls.length - 1].input).slice(0, 80)})`
            : undefined,
          stderr: stderr.slice(0, 2000),
          result: resultLine
            ? { type: resultLine.type, subtype: resultLine.subtype, result: resultLine.result?.slice?.(0, 500) }
            : null,
        }, null, 2),
      );
    } catch { /* non-fatal */ }
  }

  const turnsUsed = parsed.turnCount || resultLine?.num_turns || 0;
  const estimatedCost = parsed.totalCostUsd || resultLine?.total_cost_usd || 0;
  const inputChars = boundedPrompt.length;
  const outputChars = output.length;
  const estimatedTokens = parsed.totalTokens || (
    Number(resultLine?.usage?.input_tokens || 0)
    + Number(resultLine?.usage?.output_tokens || 0)
    + Number(resultLine?.usage?.cache_read_input_tokens || 0)
    + Number(resultLine?.usage?.cache_creation_input_tokens || 0)
  );

  const costEstimate: CostEstimate = {
    inputChars,
    outputChars,
    estimatedTokens,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
    turnsUsed,
  };

  return {
    toolCalls,
    browseErrors,
    exitReason,
    duration,
    output,
    costEstimate,
    transcript,
  };
}
