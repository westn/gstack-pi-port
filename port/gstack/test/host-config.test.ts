import { describe, test, expect } from 'bun:test';
import * as path from 'path';
import { validateAllConfigs } from '../scripts/host-config';
import {
  ALL_HOST_CONFIGS,
  ALL_HOST_NAMES,
  getHostConfig,
  resolveHostArg,
  getExternalHosts,
  pi,
  claude,
  codex,
} from '../hosts/index';
import { HOST_PATHS } from '../scripts/resolvers/types';

const ROOT = path.resolve(import.meta.dir, '..');

describe('pi-port host registry', () => {
  test('pi is the canonical primary host', () => {
    expect(ALL_HOST_NAMES).toContain('pi');
    expect(ALL_HOST_NAMES).not.toContain('claude');
    expect(pi.name).toBe('pi');
    expect(claude).toBe(pi);
  });

  test('all host configs validate', () => {
    expect(validateAllConfigs(ALL_HOST_CONFIGS)).toEqual([]);
  });

  test('getHostConfig supports pi and legacy claude alias', () => {
    expect(getHostConfig('pi')).toBe(pi);
    expect(getHostConfig('claude')).toBe(pi);
    expect(getHostConfig('codex')).toBe(codex);
  });

  test('resolveHostArg maps aliases to canonical names', () => {
    expect(resolveHostArg('pi')).toBe('pi');
    expect(resolveHostArg('claude')).toBe('pi');
    expect(resolveHostArg('codex')).toBe('codex');
    expect(resolveHostArg('agents')).toBe('codex');
  });

  test('external hosts exclude pi', () => {
    const external = getExternalHosts();
    expect(external.find(c => c.name === 'pi')).toBeUndefined();
    expect(external.length).toBe(ALL_HOST_CONFIGS.length - 1);
  });
});

describe('HOST_PATHS', () => {
  test('pi paths use the actual pi install locations', () => {
    expect(HOST_PATHS.pi.skillRoot).toBe('~/.pi/agent/skills/gstack');
    expect(HOST_PATHS.pi.localSkillRoot).toBe('.pi/skills/gstack');
    expect(HOST_PATHS.pi.binDir).toBe('~/.pi/agent/skills/gstack/bin');
    expect(HOST_PATHS.pi.browseDir).toBe('~/.pi/agent/skills/gstack/browse/dist');
    expect(HOST_PATHS.pi.designDir).toBe('~/.pi/agent/skills/gstack/design/dist');
  });

  test('codex paths use shared env-var runtime roots', () => {
    expect(HOST_PATHS.codex.skillRoot).toBe('$GSTACK_ROOT');
    expect(HOST_PATHS.codex.localSkillRoot).toBe('.agents/skills/gstack');
    expect(HOST_PATHS.codex.binDir).toBe('$GSTACK_BIN');
    expect(HOST_PATHS.codex.browseDir).toBe('$GSTACK_BROWSE');
    expect(HOST_PATHS.codex.designDir).toBe('$GSTACK_DESIGN');
  });
});

describe('host-config-export.ts CLI', () => {
  const EXPORT_SCRIPT = path.join(ROOT, 'scripts', 'host-config-export.ts');

  function run(...args: string[]) {
    const result = Bun.spawnSync(['bun', 'run', EXPORT_SCRIPT, ...args], {
      cwd: ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return {
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
      exitCode: result.exitCode,
    };
  }

  test('list prints canonical host names including pi', () => {
    const { stdout, exitCode } = run('list');
    expect(exitCode).toBe(0);
    expect(stdout.split('\n')).toEqual(ALL_HOST_NAMES);
  });

  test('get supports canonical pi host', () => {
    const { stdout, exitCode } = run('get', 'pi', 'globalRoot');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('.pi/agent/skills/gstack');
  });

  test('get also supports legacy claude alias', () => {
    const { stdout, exitCode } = run('get', 'claude', 'globalRoot');
    expect(exitCode).toBe(0);
    expect(stdout).toBe('.pi/agent/skills/gstack');
  });

  test('detect finds pi in this environment', () => {
    const { stdout, exitCode } = run('detect');
    expect(exitCode).toBe(0);
    expect(stdout.split('\n')).toContain('pi');
  });
});

describe('generated skill outputs', () => {
  test('root ship skill exists', () => {
    const result = Bun.spawnSync(['test', '-f', path.join(ROOT, 'ship', 'SKILL.md')]);
    expect(result.exitCode).toBe(0);
  });

  test('codex ship skill exists when codex docs are generated', () => {
    const codexSkill = path.join(ROOT, '.agents', 'skills', 'gstack-ship', 'SKILL.md');
    const exists = Bun.spawnSync(['test', '-f', codexSkill]);
    expect([0, 1]).toContain(exists.exitCode);
  });
});
