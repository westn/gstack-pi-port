/**
 * pi CLI subprocess runner for skill E2E testing.
 *
 * Spawns `pi --mode json --print` as an independent process (not via Agent SDK),
 * so it works inside nested test contexts. Streams JSONL output for real-time
 * progress and scans transcript/stderr for browse errors.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const GSTACK_DEV_DIR = path.join(os.homedir(), '.gstack-dev');
const HEARTBEAT_PATH = path.join(GSTACK_DEV_DIR, 'e2e-live.json');

/** Sanitize test name for use as filename: strip leading slashes, replace / with - */
export function sanitizeTestName(name: string): string {
  return name
    .replace(/^\/+/, '')
    .replace(/^skill:/, '')
    .replace(/\//g, '-');
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
  /Cannot find module .*browse/i,
];

const PI_TOOL_TO_LEGACY: Record<string, string> = {
  bash: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Grep',
  find: 'Glob',
  ls: 'LS',
};

const LEGACY_TOOL_TO_PI: Record<string, string> = {
  bash: 'bash',
  read: 'read',
  write: 'write',
  edit: 'edit',
  grep: 'grep',
  glob: 'find',
  find: 'find',
  ls: 'ls',
};

const VALID_PI_TOOLS = new Set(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']);

function normalizeToolName(name: string | undefined): string {
  if (!name) return 'unknown';
  const lower = name.toLowerCase();
  if (PI_TOOL_TO_LEGACY[lower]) return PI_TOOL_TO_LEGACY[lower];
  if (name[0]) return name[0].toUpperCase() + name.slice(1);
  return name;
}

function mapAllowedToolsToPi(allowedTools: string[]): string[] {
  const mapped: string[] = [];
  for (const tool of allowedTools) {
    const lower = tool.toLowerCase();
    const piTool = LEGACY_TOOL_TO_PI[lower] || lower;
    if (VALID_PI_TOOLS.has(piTool)) mapped.push(piTool);
  }
  return [...new Set(mapped)];
}

function extractTextFromContent(content: any): string {
  if (!Array.isArray(content)) return '';
  return content
    .filter((item: any) => item?.type === 'text' && typeof item.text === 'string')
    .map((item: any) => item.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractToolResultText(result: any): string {
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) return result.map((x) => extractToolResultText(x)).filter(Boolean).join('\n');

  if (Array.isArray(result.content)) {
    return result.content
      .map((item: any) => {
        if (typeof item === 'string') return item;
        if (item?.type === 'text' && typeof item.text === 'string') return item.text;
        if (item?.output && typeof item.output === 'string') return item.output;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (typeof result.output === 'string') return result.output;
  return '';
}

// --- Testable NDJSON parser ---

export interface ParsedNDJSON {
  transcript: any[];
  resultLine: any | null;
  turnCount: number;
  toolCallCount: number;
  toolCalls: Array<{ tool: string; input: any; output: string }>;
}

/**
 * Parse an array of NDJSON lines into structured transcript data.
 * Pure function — no I/O, no side effects. Used by both the streaming
 * reader and unit tests.
 */
export function parseNDJSON(lines: string[]): ParsedNDJSON {
  const transcript: any[] = [];
  const toolCalls: ParsedNDJSON['toolCalls'] = [];
  const toolCallById = new Map<string, number>();

  let resultLine: any = null;
  let legacyTurnCount = 0;
  let piTurnCount = 0;
  let sawToolExecutionEvents = false;

  let totalCostUsd = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let lastAssistantText = '';

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      const event = JSON.parse(line);
      transcript.push(event);

      // Legacy Claude stream-json style
      if (event.type === 'assistant') {
        legacyTurnCount++;
        const content = event.message?.content || [];
        for (const item of content) {
          if (item.type === 'tool_use') {
            toolCalls.push({
              tool: normalizeToolName(item.name || 'unknown'),
              input: item.input || {},
              output: '',
            });
          }
        }
      }

      if (event.type === 'result') {
        resultLine = event;
      }

      // pi JSON event stream style
      if (event.type === 'tool_execution_start') {
        sawToolExecutionEvents = true;
        const tool = normalizeToolName(event.toolName || 'unknown');
        toolCalls.push({ tool, input: event.args || {}, output: '' });
        if (event.toolCallId) {
          toolCallById.set(event.toolCallId, toolCalls.length - 1);
        }
      }

      if (event.type === 'tool_execution_end') {
        sawToolExecutionEvents = true;
        const output = extractToolResultText(event.result);
        const idx = event.toolCallId ? toolCallById.get(event.toolCallId) : undefined;
        if (idx !== undefined) {
          toolCalls[idx].output = output;
        } else {
          toolCalls.push({
            tool: normalizeToolName(event.toolName || 'unknown'),
            input: event.args || {},
            output,
          });
        }
      }

      if (event.type === 'turn_end' && event.message?.role === 'assistant') {
        piTurnCount++;
        const text = extractTextFromContent(event.message?.content);
        if (text) lastAssistantText = text;

        const usage = event.message?.usage || {};
        totalCostUsd += Number(usage?.cost?.total || 0) || 0;
        totalInputTokens += Number(usage?.input || 0) || 0;
        totalOutputTokens += Number(usage?.output || 0) || 0;
        totalCacheReadTokens += Number(usage?.cacheRead || 0) || 0;

        // Fallback tool extraction for transcripts that omit tool_execution_* events
        if (!sawToolExecutionEvents) {
          const content = event.message?.content || [];
          for (const item of content) {
            if (item?.type === 'toolCall') {
              toolCalls.push({
                tool: normalizeToolName(item.name || 'unknown'),
                input: item.arguments || {},
                output: '',
              });
            }
          }
        }
      }

      if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const text = extractTextFromContent(event.message?.content);
        if (text) lastAssistantText = text;
      }
    } catch {
      /* skip malformed lines */
    }
  }

  const turnCount = piTurnCount > 0 ? piTurnCount : legacyTurnCount;

  // For pi JSON mode, synthesize a result-like line to keep downstream code simple.
  if (!resultLine && (piTurnCount > 0 || lastAssistantText || totalCostUsd > 0)) {
    resultLine = {
      type: 'result',
      subtype: 'success',
      num_turns: turnCount,
      total_cost_usd: totalCostUsd,
      usage: {
        input_tokens: totalInputTokens,
        output_tokens: totalOutputTokens,
        cache_read_input_tokens: totalCacheReadTokens,
      },
      result: lastAssistantText,
    };
  }

  return {
    transcript,
    resultLine,
    turnCount,
    toolCallCount: toolCalls.length,
    toolCalls,
  };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
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
    allowedTools = ['Bash', 'Read', 'Write'],
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

  const piBin = process.env.PI_BIN || 'pi';
  const piTools = mapAllowedToolsToPi(allowedTools);

  const args = ['--mode', 'json', '--print', '--no-session'];
  if (piTools.length > 0) {
    args.push('--tools', piTools.join(','));
  } else {
    args.push('--no-tools');
  }

  if (process.env.PI_EVAL_PROVIDER) args.push('--provider', process.env.PI_EVAL_PROVIDER);
  if (process.env.PI_EVAL_MODEL) args.push('--model', process.env.PI_EVAL_MODEL);
  if (process.env.PI_EVAL_THINKING) args.push('--thinking', process.env.PI_EVAL_THINKING);
  args.push(prompt);

  const proc = Bun.spawn([piBin, ...args], {
    cwd: workingDirectory,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Race against timeout
  let stderr = '';
  let exitReason = 'unknown';
  let timedOut = false;
  let maxTurnsReached = false;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch {}
  }, timeout);

  // Stream JSONL from stdout for real-time progress
  const collectedLines: string[] = [];
  let completedTurnCount = 0;
  let startedTurnCount = 0;
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

        try {
          const event = JSON.parse(line);

          if (event.type === 'turn_start') {
            if (startedTurnCount >= maxTurns) {
              maxTurnsReached = true;
              try { proc.kill(); } catch {}
            } else {
              startedTurnCount++;
            }
          }

          if (event.type === 'turn_end' && event.message?.role === 'assistant') {
            completedTurnCount++;
          }

          if (event.type === 'tool_execution_start') {
            liveToolCount++;
            const toolName = normalizeToolName(event.toolName || 'unknown');
            const toolInput = event.args || {};
            const turnNumber = Math.max(startedTurnCount, completedTurnCount + 1);
            const elapsed = Math.round((Date.now() - startTime) / 1000);
            const progressLine = `  [${elapsed}s] turn ${turnNumber} tool #${liveToolCount}: ${toolName}(${truncate(JSON.stringify(toolInput), 80)})\n`;
            process.stderr.write(progressLine);

            // Persist progress.log
            if (runDir) {
              try { fs.appendFileSync(path.join(runDir, 'progress.log'), progressLine); } catch { /* non-fatal */ }
            }

            // Write heartbeat (atomic)
            if (runId && testName) {
              try {
                const toolDesc = `${toolName}(${truncate(JSON.stringify(toolInput), 60)})`;
                atomicWriteSync(HEARTBEAT_PATH, JSON.stringify({
                  runId,
                  pid: proc.pid,
                  startedAt,
                  currentTest: testName,
                  status: 'running',
                  turn: turnNumber,
                  toolCount: liveToolCount,
                  lastTool: toolDesc,
                  lastToolAt: new Date().toISOString(),
                  elapsedSec: elapsed,
                }, null, 2) + '\n');
              } catch { /* non-fatal */ }
            }
          }

          // Legacy transcript compatibility: assistant.tool_use entries
          if (event.type === 'assistant') {
            const content = event.message?.content || [];
            for (const item of content) {
              if (item.type === 'tool_use') {
                liveToolCount++;
                const toolName = normalizeToolName(item.name || 'unknown');
                const turnNumber = Math.max(startedTurnCount, completedTurnCount + 1);
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                const progressLine = `  [${elapsed}s] turn ${turnNumber} tool #${liveToolCount}: ${toolName}(${truncate(JSON.stringify(item.input || {}), 80)})\n`;
                process.stderr.write(progressLine);

                if (runDir) {
                  try { fs.appendFileSync(path.join(runDir, 'progress.log'), progressLine); } catch { /* non-fatal */ }
                }

                if (runId && testName) {
                  try {
                    const toolDesc = `${toolName}(${truncate(JSON.stringify(item.input || {}), 60)})`;
                    atomicWriteSync(HEARTBEAT_PATH, JSON.stringify({
                      runId,
                      pid: proc.pid,
                      startedAt,
                      currentTest: testName,
                      status: 'running',
                      turn: turnNumber,
                      toolCount: liveToolCount,
                      lastTool: toolDesc,
                      lastToolAt: new Date().toISOString(),
                      elapsedSec: elapsed,
                    }, null, 2) + '\n');
                  } catch { /* non-fatal */ }
                }
              }
            }
          }
        } catch {
          // skip — parseNDJSON() handles malformed lines for final parsing
        }

        // Append raw NDJSON line to per-test transcript file
        if (runDir && safeName) {
          try { fs.appendFileSync(path.join(runDir, `${safeName}.ndjson`), line + '\n'); } catch { /* non-fatal */ }
        }
      }
    }
  } catch {
    /* non-fatal */
  }

  // Flush remaining buffer
  if (buf.trim()) {
    collectedLines.push(buf);
    if (runDir && safeName) {
      try { fs.appendFileSync(path.join(runDir, `${safeName}.ndjson`), buf + '\n'); } catch { /* non-fatal */ }
    }
  }

  stderr = await stderrPromise;
  const exitCode = await proc.exited;
  clearTimeout(timeoutId);

  if (timedOut) {
    exitReason = 'timeout';
  } else if (maxTurnsReached) {
    exitReason = 'error_max_turns';
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
    if (match) browseErrors.push(match[0].slice(0, 200));
  }

  // Prefer structured result subtypes if we have them and process was not force-killed.
  if (!timedOut && !maxTurnsReached && resultLine) {
    if (resultLine.is_error) {
      exitReason = 'error_api';
    } else if (resultLine.subtype === 'success') {
      exitReason = 'success';
    } else if (resultLine.subtype) {
      exitReason = resultLine.subtype;
    }
  }

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
          prompt: prompt.slice(0, 500),
          testName: testName || 'unknown',
          exitReason,
          browseErrors,
          duration,
          turnAtTimeout: timedOut ? completedTurnCount : undefined,
          lastToolCall: liveToolCount > 0 ? `tool #${liveToolCount}` : undefined,
          stderr: stderr.slice(0, 2000),
          result: resultLine
            ? {
                type: resultLine.type,
                subtype: resultLine.subtype,
                result: resultLine.result?.slice?.(0, 500),
              }
            : null,
        }, null, 2),
      );
    } catch { /* non-fatal */ }
  }

  const turnsUsed = resultLine?.num_turns || parsed.turnCount || completedTurnCount;
  const estimatedCost = Number(resultLine?.total_cost_usd || 0) || 0;
  const output = resultLine?.result || '';

  const inputChars = prompt.length;
  const outputChars = output.length;
  const estimatedTokens = (resultLine?.usage?.input_tokens || 0)
    + (resultLine?.usage?.output_tokens || 0)
    + (resultLine?.usage?.cache_read_input_tokens || 0);

  const costEstimate: CostEstimate = {
    inputChars,
    outputChars,
    estimatedTokens,
    estimatedCost: Math.round(estimatedCost * 100) / 100,
    turnsUsed,
  };

  return { toolCalls, browseErrors, exitReason, duration, output, costEstimate, transcript };
}
