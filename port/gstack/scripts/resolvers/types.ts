import { ALL_HOST_CONFIGS } from '../../hosts/index';

/**
 * Host type — derived from the port's active host registry.
 * In the pi port, `pi` is the primary host and `claude` is a legacy alias
 * handled in hosts/index.ts.
 */
export type Host = (typeof ALL_HOST_CONFIGS)[number]['name'];

export interface HostPaths {
  skillRoot: string;
  localSkillRoot: string;
  binDir: string;
  browseDir: string;
  designDir: string;
}

/**
 * HOST_PATHS — derived from host configs.
 * Hosts that use env vars share the $GSTACK_* runtime roots.
 * Primary pi installs use literal ~/.pi/... paths.
 */
function buildHostPaths(): Record<string, HostPaths> {
  const paths: Record<string, HostPaths> = {};

  for (const config of ALL_HOST_CONFIGS) {
    if (config.usesEnvVars) {
      paths[config.name] = {
        skillRoot: '$GSTACK_ROOT',
        localSkillRoot: config.localSkillRoot,
        binDir: '$GSTACK_BIN',
        browseDir: '$GSTACK_BROWSE',
        designDir: '$GSTACK_DESIGN',
      };
      continue;
    }

    const root = `~/${config.globalRoot}`;
    paths[config.name] = {
      skillRoot: root,
      localSkillRoot: config.localSkillRoot,
      binDir: `${root}/bin`,
      browseDir: `${root}/browse/dist`,
      designDir: `${root}/design/dist`,
    };
  }

  return paths;
}

export const HOST_PATHS: Record<string, HostPaths> = buildHostPaths();

export interface TemplateContext {
  skillName: string;
  tmplPath: string;
  benefitsFrom?: string[];
  host: Host;
  paths: HostPaths;
  preambleTier?: number;  // 1-4, controls which preamble sections are included
}

/** Resolver function signature. args is populated for parameterized placeholders like {{INVOKE_SKILL:name}}. */
export type ResolverFn = (ctx: TemplateContext, args?: string[]) => string;
