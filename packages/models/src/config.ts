import { readFileSync } from 'node:fs';
import process from 'node:process';
import { glossPath } from './paths.ts';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface GlossConfig {
  /** `provider/model` per pipeline tier. */
  tiers: { define: string; followup: string; notes: string };
  thinking: { define: ThinkingLevel; followup: ThinkingLevel; notes: ThinkingLevel };
  /** Jev classifier (`typesafe/jev-latest`); set to `null` to turn judging off. */
  judge: string | null;
  /** Third-party pi provider packages to load (each default-exports a `Provider` or a factory). */
  providerPackages: string[];
}

/** Fast tier where latency dominates (small structured outputs), strong tier for the notes. */
export const PROFILES = {
  anthropic: {
    tiers: {
      define: 'anthropic/claude-haiku-5-5',
      followup: 'anthropic/claude-haiku-5-5',
      notes: 'anthropic/claude-sonnet-5-5',
    },
  },
  openai: {
    tiers: { define: 'openai/gpt-6-luna', followup: 'openai/gpt-6-luna', notes: 'openai/gpt-6-sol' },
  },
} as const satisfies Record<string, Pick<GlossConfig, 'tiers'>>;
export type Profile = keyof typeof PROFILES;

const DEFAULTS: GlossConfig = {
  tiers: { ...PROFILES.anthropic.tiers },
  thinking: { define: 'low', followup: 'low', notes: 'medium' },
  judge: 'typesafe/jev-latest',
  providerPackages: [],
};

type ConfigFile = Partial<Omit<GlossConfig, 'tiers' | 'thinking'>> & {
  profile?: Profile;
  tiers?: Partial<GlossConfig['tiers']>;
  thinking?: Partial<GlossConfig['thinking']>;
};

export function configPath(): string {
  return glossPath('config.json');
}

/** Defaults, then `~/.gloss/config.json` (optionally naming a `profile`), then `GLOSS_*` env vars. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GlossConfig {
  let file: ConfigFile = {};
  try {
    file = JSON.parse(readFileSync(configPath(), 'utf8')) as ConfigFile;
  } catch {
    // No config file: defaults.
  }
  const profile = (env.GLOSS_PROFILE as Profile | undefined) ?? file.profile;
  const tiers = { ...DEFAULTS.tiers, ...(profile ? PROFILES[profile]?.tiers : undefined), ...file.tiers };
  if (env.GLOSS_MODEL) {
    tiers.define = tiers.followup = tiers.notes = env.GLOSS_MODEL;
  }
  tiers.define = env.GLOSS_MODEL_DEFINE ?? tiers.define;
  tiers.followup = env.GLOSS_MODEL_FOLLOWUP ?? tiers.followup;
  tiers.notes = env.GLOSS_MODEL_NOTES ?? tiers.notes;
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
  };
}

export function splitSpecifier(specifier: string): { provider: string; id: string } {
  const at = specifier.indexOf('/');
  if (at <= 0 || at === specifier.length - 1) {
    throw new Error(`Invalid model "${specifier}": expected "provider/model-id".`);
  }
  return { provider: specifier.slice(0, at), id: specifier.slice(at + 1) };
}
