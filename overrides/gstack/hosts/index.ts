/**
 * Host config registry for the pi port.
 *
 * Upstream's primary host is Claude. In this port, `pi` is the primary host and
 * `claude` remains a backward-compatible alias for CLI arguments and legacy docs.
 */

import type { HostConfig } from '../scripts/host-config';
import pi from './pi';
import codex from './codex';
import factory from './factory';
import kiro from './kiro';
import opencode from './opencode';
import slate from './slate';
import cursor from './cursor';
import openclaw from './openclaw';

/** All registered host configs. */
export const ALL_HOST_CONFIGS: HostConfig[] = [pi, codex, factory, kiro, opencode, slate, cursor, openclaw];

/** Map from canonical host name to config. */
export const HOST_CONFIG_MAP: Record<string, HostConfig> = Object.fromEntries(
  ALL_HOST_CONFIGS.map(c => [c.name, c])
);

/** Union type of all canonical host names, derived from configs. */
export type Host = (typeof ALL_HOST_CONFIGS)[number]['name'];

/** All canonical host names as a string array. */
export const ALL_HOST_NAMES: string[] = ALL_HOST_CONFIGS.map(c => c.name);

function resolveAlias(name: string): HostConfig | undefined {
  for (const config of ALL_HOST_CONFIGS) {
    if (config.cliAliases?.includes(name)) return config;
  }
  return undefined;
}

/** Get a host config by canonical name or supported alias. Throws if not found. */
export function getHostConfig(name: string): HostConfig {
  const direct = HOST_CONFIG_MAP[name];
  if (direct) return direct;

  const alias = resolveAlias(name);
  if (alias) return alias;

  throw new Error(`Unknown host '${name}'. Valid hosts: ${ALL_HOST_NAMES.join(', ')}`);
}

/**
 * Resolve a host name from a CLI argument, handling aliases.
 * e.g. 'claude' → 'pi', 'agents' → 'codex', 'droid' → 'factory'
 */
export function resolveHostArg(arg: string): string {
  if (HOST_CONFIG_MAP[arg]) return arg;

  const alias = resolveAlias(arg);
  if (alias) return alias.name;

  throw new Error(`Unknown host '${arg}'. Valid hosts: ${ALL_HOST_NAMES.join(', ')}`);
}

/** Get hosts that are NOT the primary host (pi). */
export function getExternalHosts(): HostConfig[] {
  return ALL_HOST_CONFIGS.filter(c => c.name !== 'pi');
}

// Re-export individual configs for direct import.
// `claude` is kept as a compatibility alias to the canonical `pi` config.
export { pi, pi as claude, codex, factory, kiro, opencode, slate, cursor, openclaw };
