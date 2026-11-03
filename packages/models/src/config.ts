import { readFileSync } from 'node:fs';
import process from 'node:process';
import { glossPath } from './paths.ts';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface GlossConfig {
  /** `provider/model` per pipeline tier; `small` is a cheap model for one-line jobs such as stack names. */
  tiers: { define: string; followup: string; notes: string; small: string };
  thinking: { define: ThinkingLevel; followup: ThinkingLevel; notes: ThinkingLevel; small: ThinkingLevel };
  /** The models the Ask panel offers, fast to strong, and the one it starts on. */
  ask: { models: string[]; default: string };
  /** Jev classifier (`typesafe/jev-latest`); set to `null` to turn judging off. */
  judge: string | null;
  /** Third-party pi provider packages to load (each default-exports a `Provider` or a factory). */
  providerPackages: string[];
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
    ask: {
      models: ['anthropic/claude-haiku-5-5', 'anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5'],
      default: 'anthropic/claude-sonnet-5-5',
    },
  },
  openai: {
    tiers: {
      define: 'openai/gpt-6-luna',
      followup: 'openai/gpt-6-luna',
      notes: 'openai/gpt-6-sol',
      small: 'openai/gpt-6-luna',
    },
    ask: {
      models: ['openai/gpt-6-luna', 'openai/gpt-6-sol', 'openai/gpt-6-astra'],
      default: 'openai/gpt-6-sol',
    },
  },
} as const satisfies Record<
  string,
  { tiers: GlossConfig['tiers']; ask: { models: readonly string[]; default: string } }
>;
export type Profile = keyof typeof PROFILES;

const DEFAULTS: GlossConfig = {
  tiers: { ...PROFILES.anthropic.tiers },
  thinking: { define: 'low', followup: 'low', notes: 'medium', small: 'off' },
  ask: { models: [...PROFILES.anthropic.ask.models], default: PROFILES.anthropic.ask.default },
  judge: 'typesafe/jev-latest',
  providerPackages: [],
};

type ConfigFile = Partial<Omit<GlossConfig, 'tiers' | 'thinking' | 'ask'>> & {
  ask?: Partial<GlossConfig['ask']>;
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
    tiers.define = tiers.followup = tiers.notes = tiers.small = env.GLOSS_MODEL;
  }
  tiers.define = env.GLOSS_MODEL_DEFINE ?? tiers.define;
  tiers.followup = env.GLOSS_MODEL_FOLLOWUP ?? tiers.followup;
  tiers.notes = env.GLOSS_MODEL_NOTES ?? tiers.notes;
  tiers.small = env.GLOSS_MODEL_SMALL ?? (file.tiers?.small || env.GLOSS_MODEL ? tiers.small : smallFor(tiers.define));
  return {
    tiers,
    ask: askFor(tiers.notes, file.ask),
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

/**
 * The small tier when nothing sets it: the cheap model of the define tier's provider, so it
 * never needs a login the tour tiers do not; the define model itself for other providers.
 */
function smallFor(define: string): string {
  const provider = define.slice(0, define.indexOf('/'));
  return Object.values(PROFILES).find((p) => p.tiers.small.startsWith(`${provider}/`))?.tiers.small ?? define;
}

/**
 * The Ask panel's models: the config file's, or the profile of the notes tier's provider (so no
 * other login is needed), starting on the profile's mid model. Another provider offers its tiers.
 */
function askFor(notes: string, file: Partial<GlossConfig['ask']> | undefined): GlossConfig['ask'] {
  const provider = notes.slice(0, notes.indexOf('/'));
  const profile = Object.values(PROFILES).find((p) => p.ask.default.startsWith(`${provider}/`))?.ask;
  const models = file?.models?.length ? file.models : profile ? [...profile.models] : [notes];
  const fallback = profile && models.includes(profile.default) ? profile.default : (models.at(-1) ?? notes);
  return { models, default: file?.default && models.includes(file.default) ? file.default : fallback };
}

export function splitSpecifier(specifier: string): { provider: string; id: string } {
  const at = specifier.indexOf('/');
  if (at <= 0 || at === specifier.length - 1) {
    throw new Error(`Invalid model "${specifier}": expected "provider/model-id".`);
  }
  return { provider: specifier.slice(0, at), id: specifier.slice(at + 1) };
}
