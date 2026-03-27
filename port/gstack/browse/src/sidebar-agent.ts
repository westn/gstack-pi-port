/**
 * Sidebar Agent — polls agent-queue from server, spawns pi by default
 * (with legacy Claude fallback), and streams live events back to the
 * server via /sidebar-agent/event.
 *
 * This runs as a NON-COMPILED bun process because compiled bun binaries
 * cannot posix_spawn external executables. The server writes to the queue
 * file, this process reads it and spawns a child agent CLI.
 *
 * Usage: BROWSE_BIN=/path/to/browse bun run browse/src/sidebar-agent.ts
 */

import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const QUEUE = process.env.SIDEBAR_QUEUE_PATH || path.join(process.env.HOME || '/tmp', '.gstack', 'sidebar-agent-queue.jsonl');
const SERVER_PORT = parseInt(process.env.BROWSE_SERVER_PORT || '34567', 10);
const SERVER_URL = `http://127.0.0.1:${SERVER_PORT}`;
const POLL_MS = 500; // Fast polling — server already did the user-facing response
const B = process.env.BROWSE_BIN || path.resolve(__dirname, '../dist/browse');

function commandExists(command: string): boolean {
  try {
    const result = spawnSync('sh', ['-lc', `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], {
      stdio: 'ignore',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

const AGENT_BIN = process.env.SIDEBAR_AGENT_BIN
  || process.env.PI_BIN
  || (commandExists('pi') ? 'pi' : 'claude');
const AGENT_KIND = process.env.SIDEBAR_AGENT_KIND
  || (path.basename(AGENT_BIN).includes('claude') ? 'claude' : 'pi');

let lastLine = 0;
let authToken: string | null = null;
let isProcessing = false;

// ─── File drop relay ──────────────────────────────────────────

function getGitRoot(): string | null {
  try {
    const { execSync } = require('child_process');
    return execSync('git rev-parse --show-toplevel', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return null;
  }
}

function writeToInbox(message: string, pageUrl?: string, sessionId?: string): void {
  const gitRoot = getGitRoot();
  if (!gitRoot) {
    console.error('[sidebar-agent] Cannot write to inbox — not in a git repo');
    return;
  }

  const inboxDir = path.join(gitRoot, '.context', 'sidebar-inbox');
  fs.mkdirSync(inboxDir, { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace(/:/g, '-');
  const filename = `${timestamp}-observation.json`;
  const tmpFile = path.join(inboxDir, `.${filename}.tmp`);
  const finalFile = path.join(inboxDir, filename);

  const inboxMessage = {
    type: 'observation',
    timestamp: now.toISOString(),
    page: { url: pageUrl || 'unknown', title: '' },
    userMessage: message,
    sidebarSessionId: sessionId || 'unknown',
  };

  fs.writeFileSync(tmpFile, JSON.stringify(inboxMessage, null, 2));
  fs.renameSync(tmpFile, finalFile);
  console.log(`[sidebar-agent] Wrote inbox message: ${filename}`);
}

// ─── Auth ────────────────────────────────────────────────────────

async function refreshToken(): Promise<string | null> {
  try {
    const resp = await fetch(`${SERVER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    authToken = data.token || null;
    return authToken;
  } catch {
    return null;
  }
}

// ─── Event relay to server ──────────────────────────────────────

async function sendEvent(event: Record<string, any>): Promise<void> {
  if (!authToken) await refreshToken();
  if (!authToken) return;

  try {
    await fetch(`${SERVER_URL}/sidebar-agent/event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify(event),
    });
  } catch (err) {
    console.error('[sidebar-agent] Failed to send event:', err);
  }
}

// ─── Agent subprocess helpers ───────────────────────────────────

function shorten(str: string): string {
  return str
    .replace(new RegExp(B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '$B')
    .replace(/\/Users\/[^/]+/g, '~')
    .replace(/\/conductor\/workspaces\/[^/]+\/[^/]+/g, '')
    .replace(/\.pi\/agent\/skills\/gstack\//g, '')
    .replace(/\.pi\/skills\/gstack\//g, '')
    .replace(/browse\/dist\/browse/g, '$B');
}

function displayToolName(tool: string): string {
  const normalized = (tool || '').toLowerCase();
  switch (normalized) {
    case 'bash': return 'Bash';
    case 'read': return 'Read';
    case 'write': return 'Write';
    case 'edit': return 'Edit';
    case 'grep': return 'Grep';
    case 'find':
    case 'glob': return 'Glob';
    case 'ls': return 'Ls';
    default:
      return tool || 'unknown';
  }
}

function summarizeToolInput(tool: string, input: any): string {
  if (!input) return '';

  const normalized = (tool || '').toLowerCase();
  if (normalized === 'bash' && input.command) {
    const cmd = shorten(String(input.command));
    return cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd;
  }

  const maybePath = input.path || input.file_path || input.filePath;
  if (maybePath && ['read', 'write', 'edit'].includes(normalized)) {
    return shorten(String(maybePath));
  }

  if ((normalized === 'grep' || normalized === 'glob') && input.pattern) {
    return String(input.pattern);
  }

  if (normalized === 'find') {
    if (input.pattern) return String(input.pattern);
    if (input.path) return shorten(String(input.path));
  }

  try {
    return shorten(JSON.stringify(input)).slice(0, 120);
  } catch {
    return '';
  }
}

function extractTextBlocks(content: any): string[] {
  if (!Array.isArray(content)) return [];
  const out: string[] = [];

  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      out.push(item.text.trim());
    }
  }

  return out;
}

function buildAgentArgs(prompt: string, sessionId?: string | null): string[] {
  if (AGENT_KIND === 'claude') {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--allowedTools', 'Bash,Read,Glob,Grep',
    ];
    if (sessionId) args.push('--resume', sessionId);
    return args;
  }

  const args = [
    '--no-session',
    '--mode', 'json',
    '--tools', 'bash,read,grep,find',
  ];

  if (process.env.SIDEBAR_PI_PROVIDER) {
    args.push('--provider', process.env.SIDEBAR_PI_PROVIDER);
  }
  if (process.env.SIDEBAR_PI_MODEL) {
    args.push('--model', process.env.SIDEBAR_PI_MODEL);
  }
  if (process.env.SIDEBAR_PI_THINKING) {
    args.push('--thinking', process.env.SIDEBAR_PI_THINKING);
  }

  args.push('-p', prompt);
  return args;
}

interface RelayState {
  sentTexts: Set<string>;
  sentToolUses: Set<string>;
}

async function relayToolUse(state: RelayState, tool: string, input: any, id?: string | null): Promise<void> {
  const displayName = displayToolName(tool);
  const summarized = summarizeToolInput(tool, input);
  const dedupeId = id || `${displayName}:${summarized}`;
  if (state.sentToolUses.has(dedupeId)) return;
  state.sentToolUses.add(dedupeId);
  await sendEvent({ type: 'tool_use', tool: displayName, input: summarized });
}

async function relayTexts(state: RelayState, texts: string[]): Promise<void> {
  for (const text of texts) {
    const normalized = text.trim();
    if (!normalized || state.sentTexts.has(normalized)) continue;
    state.sentTexts.add(normalized);
    await sendEvent({ type: 'text', text: normalized });
  }
}

async function handleStreamEvent(event: any, state: RelayState): Promise<void> {
  if (!event || typeof event !== 'object') return;

  // Legacy Claude stream-json events
  if (event.type === 'system' && event.session_id) {
    await sendEvent({ type: 'system', piSessionId: event.session_id });
    return;
  }

  if (event.type === 'assistant' && event.message?.content) {
    for (const block of event.message.content) {
      if (block?.type === 'tool_use') {
        await relayToolUse(state, block.name || 'unknown', block.input || {}, block.id || null);
      }
    }
    await relayTexts(state, extractTextBlocks(event.message.content));
    return;
  }

  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    await relayToolUse(
      state,
      event.content_block.name || 'unknown',
      event.content_block.input || {},
      event.content_block.id || null,
    );
    return;
  }

  if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) {
    await sendEvent({ type: 'text_delta', text: event.delta.text });
    return;
  }

  if (event.type === 'result') {
    const text = typeof event.result === 'string' ? event.result : event.text;
    if (text) {
      await sendEvent({ type: 'result', text });
    }
    return;
  }

  // pi JSON mode events
  if (event.type === 'tool_execution_start') {
    await relayToolUse(state, event.toolName || 'unknown', event.args || {}, event.toolCallId || null);
    return;
  }

  if (event.type === 'turn_end' && event.message?.role === 'assistant') {
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    for (const item of content) {
      if (item?.type === 'toolCall') {
        await relayToolUse(state, item.name || 'unknown', item.arguments || {}, item.id || null);
      }
    }
    await relayTexts(state, extractTextBlocks(content));
    return;
  }

  if (event.type === 'agent_end' && Array.isArray(event.messages)) {
    for (const msg of event.messages) {
      if (msg?.role !== 'assistant') continue;
      const content = Array.isArray(msg?.content) ? msg.content : [];
      await relayTexts(state, extractTextBlocks(content));
    }
  }
}

async function askAgent(queueEntry: any): Promise<void> {
  const { prompt, stateFile, cwd, sessionId } = queueEntry;

  isProcessing = true;
  await sendEvent({ type: 'agent_start' });

  return new Promise((resolve) => {
    const agentArgs = buildAgentArgs(prompt, sessionId);
    const relayState: RelayState = {
      sentTexts: new Set<string>(),
      sentToolUses: new Set<string>(),
    };

    let effectiveCwd = cwd || process.cwd();
    try { fs.accessSync(effectiveCwd); } catch { effectiveCwd = process.cwd(); }

    const proc = spawn(AGENT_BIN, agentArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: effectiveCwd,
      env: {
        ...process.env,
        BROWSE_STATE_FILE: stateFile || '',
        BROWSE_BIN: B,
      },
    });

    let finished = false;
    let buffer = '';
    let stderr = '';

    const finish = async (event: Record<string, any>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeoutHandle);
      await sendEvent(event);
      isProcessing = false;
      resolve();
    };

    proc.stdout.on('data', async (data: Buffer | string) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          await handleStreamEvent(JSON.parse(line), relayState);
        } catch {
          // Ignore non-JSON lines from the agent process.
        }
      }
    });

    proc.stderr.on('data', (data: Buffer | string) => {
      stderr += data.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    proc.on('close', async (code) => {
      if (buffer.trim()) {
        try {
          await handleStreamEvent(JSON.parse(buffer), relayState);
        } catch {
          // Ignore trailing non-JSON.
        }
      }

      if (code && code !== 0) {
        const message = stderr.trim() || `${AGENT_BIN} exited with code ${code}`;
        await finish({ type: 'agent_error', error: message });
        return;
      }

      await finish({ type: 'agent_done' });
    });

    proc.on('error', async (err) => {
      await finish({ type: 'agent_error', error: err.message });
    });

    const timeoutMs = parseInt(process.env.SIDEBAR_AGENT_TIMEOUT || '300000', 10);
    const timeoutHandle = setTimeout(async () => {
      try { proc.kill(); } catch {}
      await finish({ type: 'agent_error', error: `Timed out after ${timeoutMs / 1000}s` });
    }, timeoutMs);
  });
}

// ─── Poll loop ───────────────────────────────────────────────────

function countLines(): number {
  try {
    return fs.readFileSync(QUEUE, 'utf-8').split('\n').filter(Boolean).length;
  } catch { return 0; }
}

function readLine(n: number): string | null {
  try {
    const lines = fs.readFileSync(QUEUE, 'utf-8').split('\n').filter(Boolean);
    return lines[n - 1] || null;
  } catch { return null; }
}

async function poll() {
  if (isProcessing) return; // One at a time — server handles queuing

  const current = countLines();
  if (current <= lastLine) return;

  while (lastLine < current && !isProcessing) {
    lastLine++;
    const line = readLine(lastLine);
    if (!line) continue;

    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!entry.message && !entry.prompt) continue;

    console.log(`[sidebar-agent] Processing: "${entry.message}" via ${AGENT_BIN}`);
    writeToInbox(entry.message || entry.prompt, entry.pageUrl, entry.sessionId);
    try {
      await askAgent(entry);
    } catch (err) {
      console.error('[sidebar-agent] Error:', err);
      await sendEvent({ type: 'agent_error', error: String(err) });
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  const dir = path.dirname(QUEUE);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(QUEUE)) fs.writeFileSync(QUEUE, '');

  lastLine = countLines();
  await refreshToken();

  console.log(`[sidebar-agent] Started. Watching ${QUEUE} from line ${lastLine}`);
  console.log(`[sidebar-agent] Server: ${SERVER_URL}`);
  console.log(`[sidebar-agent] Browse binary: ${B}`);
  console.log(`[sidebar-agent] Agent CLI: ${AGENT_BIN} (${AGENT_KIND})`);

  setInterval(poll, POLL_MS);
}

main().catch(console.error);
