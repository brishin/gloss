import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { glossPath } from './paths.ts';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface GlossConfig {
  /** `provider/model` per pipeline tier; `small` is a cheap model for one-line jobs such as stack names. */
  tiers: { define: string; followup: string; notes: string; small: string };
  thinking: { define: ThinkingLevel; followup: ThinkingLevel; notes: ThinkingLevel; small: ThinkingLevel };
  /** Jev classifier (`typesafe/jev-latest`); set to `null` to turn judging off. */
  judge: string | null;
  /** Third-party pi provider packages to load (each default-exports a `Provider` or a factory). */
  providerPackages: string[];
  /** The user's own rules for which decisions to flag, one line each (`gloss` setup page). */
  decisionRules: string[];
}

/**
 * Fast tier where latency dominates (small structured outputs), strong tier for the notes, and
 * the small tier stays the provider's cheapest model even when the others are raised.
 */
export const PROFILES = {
  anthropic: {
    tiers: {
      define: 'anthropic/claude-haiku-5-5',
      followup: 'anthropic/claude-haiku-5-5',
      notes: 'anthropic/claude-sonnet-5-5',
      small: 'anthropic/claude-haiku-5-5',
    },
  },
  openai: {
    tiers: {
      define: 'openai/gpt-6-luna',
      followup: 'openai/gpt-6-luna',
      notes: 'openai/gpt-6-sol',
      small: 'openai/gpt-6-luna',
    },
  },
} as const satisfies Record<string, Pick<GlossConfig, 'tiers'>>;
export type Profile = keyof typeof PROFILES;

const DEFAULTS: GlossConfig = {
  tiers: { ...PROFILES.anthropic.tiers },
  thinking: { define: 'low', followup: 'low', notes: 'medium', small: 'off' },
  judge: 'typesafe/jev-latest',
  providerPackages: [],
  decisionRules: [],
};

type ConfigFile = Partial<Omit<GlossConfig, 'tiers' | 'thinking'>> & {
  profile?: Profile;
  tiers?: Partial<GlossConfig['tiers']>;
  thinking?: Partial<GlossConfig['thinking']>;
};

export function configPath(): string {
  return glossPath('config.json');
}

function readConfigFile(): ConfigFile {
  try {
    return JSON.parse(readFileSync(configPath(), 'utf8')) as ConfigFile;
  } catch {
    // No config file: defaults.
    return {};
  }
}

/** Defaults, then `~/.gloss/config.json` (optionally naming a `profile`), then `GLOSS_*` env vars. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GlossConfig {
  const file = readConfigFile();
  const profile = (env.GLOSS_PROFILE as Profile | undefined) ?? file.profile;
  const tiers = { ...DEFAULTS.tiers, ...(profile ? PROFILES[profile]?.tiers : undefined), ...file.tiers };
  if (env.GLOSS_MODEL) {
    tiers.define = tiers.followup = tiers.notes = tiers.small = env.GLOSS_MODEL;
  }
  tiers.define = env.GLOSS_MODEL_DEFINE ?? tiers.define;
  tiers.followup = env.GLOSS_MODEL_FOLLOWUP ?? tiers.followup;
  tiers.notes = env.GLOSS_MODEL_NOTES ?? tiers.notes;
  tiers.small = env.GLOSS_MODEL_SMALL ?? (file.tiers?.small || env.GLOSS_MODEL ? tiers.small : smallFor(tiers.define));
  return {
    tiers,
    thinking: { ...DEFAULTS.thinking, ...file.thinking },
    judge:
      env.GLOSS_JUDGE === 'off' ? null : (env.GLOSS_JUDGE ?? (file.judge === undefined ? DEFAULTS.judge : file.judge)),
    providerPackages: [
      ...(file.providerPackages ?? []),
      ...(env.GLOSS_PROVIDER_PACKAGES?.split(',')
        .map((name) => name.trim())
        .filter(Boolean) ?? []),
    ],
    decisionRules: readDecisionRules(file),
  };
}

/** The saved decision rules, read from the file each time so a tour sees the latest save. */
export function readDecisionRules(file: ConfigFile = readConfigFile()): string[] {
  return Array.isArray(file.decisionRules)
    ? file.decisionRules.filter((rule): rule is string => typeof rule === 'string' && rule.trim() !== '')
    : [];
}

/**
 * Saves the decision rules into `~/.gloss/config.json`, keeping every other key as written.
 * No rules removes the key. Writes a temporary file and renames it, so a reader never sees half.
 */
export function saveDecisionRules(rules: readonly string[]): void {
  const path = configPath();
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Never overwrite a config the user can no longer parse.
      throw new Error(`Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (rules.length) {
    file.decisionRules = [...rules];
  } else {
    delete file.decisionRules;
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`);
  renameSync(temp, path);
}

/**
 * The small tier when nothing sets it: the cheap model of the define tier's provider, so it
 * never needs a login the tour tiers do not; the define model itself for other providers.
 */
function smallFor(define: string): string {
  const provider = define.slice(0, define.indexOf('/'));
  return Object.values(PROFILES).find((p) => p.tiers.small.startsWith(`${provider}/`))?.tiers.small ?? define;
}

export function splitSpecifier(specifier: string): { provider: string; id: string } {
  const at = specifier.indexOf('/');
  if (at <= 0 || at === specifier.length - 1) {
    throw new Error(`Invalid model "${specifier}": expected "provider/model-id".`);
  }
  return { provider: specifier.slice(0, at), id: specifier.slice(at + 1) };
}
