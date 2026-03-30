export type Host = 'pi' | 'codex';

export interface HostPaths {
  skillRoot: string;
  localSkillRoot: string;
  binDir: string;
  browseDir: string;
}

export const HOST_PATHS: Record<Host, HostPaths> = {
  pi: {
    skillRoot: '~/.pi/agent/skills/gstack',
    localSkillRoot: '.pi/skills/gstack',
    binDir: '~/.pi/agent/skills/gstack/bin',
    browseDir: '~/.pi/agent/skills/gstack/browse/dist',
  },
  codex: {
    skillRoot: '$GSTACK_ROOT',
    localSkillRoot: '.agents/skills/gstack',
    binDir: '$GSTACK_BIN',
    browseDir: '$GSTACK_BROWSE',
  },
};

export interface TemplateContext {
  skillName: string;
  tmplPath: string;
  benefitsFrom?: string[];
  host: Host;
  paths: HostPaths;
  preambleTier?: number;  // 1-4, controls which preamble sections are included
}

export type ResolverFn = (ctx: TemplateContext, args?: string[]) => string;
