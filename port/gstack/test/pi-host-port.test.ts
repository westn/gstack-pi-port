import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const REPO_ROOT = path.resolve(ROOT, '..', '..');

function runGenSkillDocs(host: string) {
  return Bun.spawnSync(['bun', 'run', 'scripts/gen-skill-docs.ts', '--host', host, '--dry-run'], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

describe('pi host port integration', () => {
  test('--host pi dry-run is fresh', () => {
    const result = runGenSkillDocs('pi');
    expect(result.exitCode).toBe(0);
  });

  test('--host claude remains a compatibility alias for pi', () => {
    const piResult = runGenSkillDocs('pi');
    const aliasResult = runGenSkillDocs('claude');
    expect(piResult.exitCode).toBe(0);
    expect(aliasResult.exitCode).toBe(0);
    expect(aliasResult.stdout.toString()).toBe(piResult.stdout.toString());
  });

  test('setup defaults to pi while preserving legacy claude alias', () => {
    const setupContent = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
    expect(setupContent).toContain('HOST="pi"');
    expect(setupContent).toContain('pi|claude|codex|kiro|auto');
    expect(setupContent).toContain('gstack ready (pi).');
  });

  test('root install script uses first-class pi setup host', () => {
    const installScript = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'install.sh'), 'utf-8');
    expect(installScript).toContain('./setup --host pi --no-prefix');
  });
});
