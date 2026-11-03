import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuthEvent, AuthPrompt } from '@earendil-works/pi-ai';
import type { LoginMethod, ProviderLogin } from '@gloss/protocol';
import { loadConfig, splitSpecifier } from './config.ts';
import { glossPath } from './paths.ts';
import { getModels, SUBSCRIPTIONS, type Subscription } from './registry.ts';

export interface LoginIO {
  /** Show a message or URL to the user (and open it, when it is a URL). */
  notify(event: AuthEvent): void;
  /** Ask the user for text; resolves with their answer. */
  prompt(prompt: AuthPrompt): Promise<string>;
}

/**
 * This installation's stable UUID, created on first use. Sign in with ChatGPT registers
 * it as the agent host (`urn:uuid:<id>`), so it must not change between logins.
 */
export function deviceId(): string {
  const path = glossPath('device-id');
  try {
    const id = readFileSync(path, 'utf8').trim();
    if (UUID_RE.test(id)) {
      return id;
    }
  } catch {
    // First use: create it below.
  }
  const id = randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${id}\n`);
  return id;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Runs pi-ai's login flow for a subscription (its OAuth sign-in, or the provider's API key)
 * and stores the credential in `~/.gloss/auth.json`.
 */
export async function login(
  subscription: Subscription,
  io: LoginIO,
  { method = 'oauth', signal }: { method?: LoginMethod; signal?: AbortSignal } = {},
): Promise<void> {
  const { provider } = SUBSCRIPTIONS[subscription];
  await getModels().login(
    provider,
    method,
    {
      notify: (event) => io.notify(event),
      prompt: (prompt) => io.prompt(prompt),
      signal,
    },
    { getDeviceId: deviceId, agentName: 'gloss' },
  );
}

export async function logout(subscription: Subscription): Promise<void> {
  await getModels().logout(SUBSCRIPTIONS[subscription].provider);
}

export interface ProviderStatus {
  id: string;
  configured: boolean;
  /** "OAuth", "ANTHROPIC_API_KEY", ... */
  source?: string;
  /** How `gloss login` (or the app) can sign this provider in. */
  login?: ProviderLogin;
}

/** The subscription a pi-ai provider id signs in with, if any. */
export function providerLogin(providerId: string): ProviderLogin | undefined {
  for (const [subscription, entry] of Object.entries(SUBSCRIPTIONS) as [
    Subscription,
    (typeof SUBSCRIPTIONS)[Subscription],
  ][]) {
    if (entry.provider === providerId) {
      return { subscription, label: entry.label, apiKeyLabel: entry.apiKeyLabel };
    }
  }
  return undefined;
}

/** Auth status of every provider the current config uses. */
export async function providerStatus(): Promise<ProviderStatus[]> {
  const config = loadConfig();
  const ids = new Set(
    [...Object.values(config.tiers), ...(config.judge ? [config.judge] : [])].map(
      (spec) => splitSpecifier(spec).provider,
    ),
  );
  const models = getModels();
  return Promise.all(
    [...ids].map(async (id) => {
      const check = await models.checkAuth(id).catch(() => undefined);
      const login = providerLogin(id);
      return { id, configured: !!check, source: check?.source, ...(login ? { login } : {}) };
    }),
  );
}

/** Fails loudly, listing what is wrong, when a configured model id is unknown to pi-ai's catalog. */
/** A model's display name from the registry, e.g. "Claude Sonnet 5.5"; the specifier when it has none. */
export function modelName(specifier: string): string {
  const { provider, id } = splitSpecifier(specifier);
  return getModels().getModel(provider, id)?.name ?? specifier;
}

export function validateModelIds(specifiers: readonly string[]): void {
  const models = getModels();
  const unknown = specifiers.filter((spec) => {
    const { provider, id } = splitSpecifier(spec);
    return !models.getModel(provider, id);
  });
  if (unknown.length) {
    const known = (provider: string) =>
      models
        .getModels(provider)
        .map((model) => model.id)
        .slice(0, 30)
        .join(', ');
    throw new Error(
      unknown
        .map(
          (spec) =>
            `Unknown model "${spec}". Known ${splitSpecifier(spec).provider} models: ${known(splitSpecifier(spec).provider) || '(none)'}`,
        )
        .join('\n'),
    );
  }
}
