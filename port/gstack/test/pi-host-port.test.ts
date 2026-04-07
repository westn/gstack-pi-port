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

  test('pi install skips alias skill dirs that would collide in discovery', () => {
    const setupContent = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');
    const installScript = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'install.sh'), 'utf-8');
    expect(setupContent).toContain('skill_frontmatter_name');
    expect(setupContent).toContain('skipped alias skills for pi discovery');
    expect(installScript).toContain('skill_frontmatter_name');
    expect(installScript).toContain('Skipped alias sub-skills for pi discovery');
  });

  test('deprecated connect-chrome skill is removed from the pi port', () => {
    expect(fs.existsSync(path.join(ROOT, 'connect-chrome'))).toBe(false);

    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf-8');
    const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf-8');
    const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf-8');
    const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');

    expect(readme).not.toContain('/skill:connect-chrome');
    expect(agents).not.toContain('connect-chrome/');
    expect(claude).not.toContain('connect-chrome/');
    expect(changelog).not.toContain('/skill:connect-chrome');
    expect(readme).toContain('/skill:open-gstack-browser');
  });
});
