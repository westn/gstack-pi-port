import { describe, test, expect } from 'bun:test';
import { parseNDJSON } from './session-runner';

// Fixture: legacy stream-json style (Claude-era compatibility)
const LEGACY_FIXTURE_LINES = [
  '{"type":"system","subtype":"init","session_id":"test-123"}',
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu1","name":"Bash","input":{"command":"echo hello"}}]}}',
  '{"type":"user","tool_use_result":{"tool_use_id":"tu1","stdout":"hello\\n","stderr":""}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"The command printed hello."}]}}',
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Let me also read a file."},{"type":"tool_use","id":"tu2","name":"Read","input":{"file_path":"/tmp/test"}}]}}',
  '{"type":"result","subtype":"success","total_cost_usd":0.05,"num_turns":3,"usage":{"input_tokens":100,"output_tokens":50},"result":"Done."}',
];

// Fixture: pi JSON mode style
const PI_FIXTURE_LINES = [
  '{"type":"session","version":3}',
  '{"type":"turn_start"}',
  '{"type":"tool_execution_start","toolCallId":"tc1","toolName":"bash","args":{"command":"echo hello"}}',
  '{"type":"tool_execution_end","toolCallId":"tc1","toolName":"bash","result":{"content":[{"type":"text","text":"hello\\n"}]},"isError":false}',
  '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"usage":{"input":100,"output":50,"cacheRead":0,"totalTokens":150,"cost":{"total":0.05}}}}',
  '{"type":"agent_end","messages":[]}',
];

describe('parseNDJSON', () => {
  test('parses valid legacy NDJSON with system + assistant + result events', () => {
    const parsed = parseNDJSON(LEGACY_FIXTURE_LINES);
    expect(parsed.transcript).toHaveLength(6);
    expect(parsed.transcript[0].type).toBe('system');
    expect(parsed.transcript[5].type).toBe('result');
  });

  test('extracts tool calls from legacy assistant.message.content[].type === tool_use', () => {
    const parsed = parseNDJSON(LEGACY_FIXTURE_LINES);
    expect(parsed.toolCalls).toHaveLength(2);
    expect(parsed.toolCalls[0]).toEqual({
      tool: 'Bash',
      input: { command: 'echo hello' },
      output: '',
    });
    expect(parsed.toolCalls[1]).toEqual({
      tool: 'Read',
      input: { file_path: '/tmp/test' },
      output: '',
    });
    expect(parsed.toolCallCount).toBe(2);
  });

  test('extracts tool calls from pi tool_execution_* events', () => {
    const parsed = parseNDJSON(PI_FIXTURE_LINES);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0]).toEqual({
      tool: 'Bash',
      input: { command: 'echo hello' },
      output: 'hello\n',
    });
    expect(parsed.toolCallCount).toBe(1);
  });

  test('synthesizes resultLine for pi event streams', () => {
    const parsed = parseNDJSON(PI_FIXTURE_LINES);
    expect(parsed.resultLine).not.toBeNull();
    expect(parsed.resultLine.type).toBe('result');
    expect(parsed.resultLine.subtype).toBe('success');
    expect(parsed.resultLine.total_cost_usd).toBe(0.05);
    expect(parsed.resultLine.num_turns).toBe(1);
    expect(parsed.resultLine.result).toBe('Done.');
  });

  test('skips malformed lines without throwing', () => {
    const lines = [
      '{"type":"system"}',
      'this is not json',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]}}',
      '{incomplete json',
      '{"type":"result","subtype":"success","result":"done"}',
    ];
    const parsed = parseNDJSON(lines);
    expect(parsed.transcript).toHaveLength(3); // system, assistant, result
    expect(parsed.resultLine?.subtype).toBe('success');
  });

  test('skips empty and whitespace-only lines', () => {
    const lines = [
      '',
      '  ',
      '{"type":"system"}',
      '\t',
      '{"type":"result","subtype":"success","result":"ok"}',
    ];
    const parsed = parseNDJSON(lines);
    expect(parsed.transcript).toHaveLength(2);
  });

  test('counts legacy turns from assistant events', () => {
    const parsed = parseNDJSON(LEGACY_FIXTURE_LINES);
    expect(parsed.turnCount).toBe(3);
  });

  test('counts pi turns from turn_end assistant events', () => {
    const parsed = parseNDJSON(PI_FIXTURE_LINES);
    expect(parsed.turnCount).toBe(1);
  });

  test('handles empty input', () => {
    const parsed = parseNDJSON([]);
    expect(parsed.transcript).toHaveLength(0);
    expect(parsed.resultLine).toBeNull();
    expect(parsed.turnCount).toBe(0);
    expect(parsed.toolCallCount).toBe(0);
    expect(parsed.toolCalls).toHaveLength(0);
  });

  test('handles assistant event with no content array', () => {
    const lines = [
      '{"type":"assistant","message":{}}',
      '{"type":"assistant"}',
    ];
    const parsed = parseNDJSON(lines);
    expect(parsed.turnCount).toBe(2);
    expect(parsed.toolCalls).toHaveLength(0);
  });
});
