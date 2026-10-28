import { createModels, type MutableModels, type Provider } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { typesafeProvider } from '@earendil-works/pi-ai/providers/typesafe';
import { FileCredentialStore } from './credential-store.ts';
import { glossPath } from './paths.ts';

/** The subscription logins `gloss login` offers, by the pi-ai provider that serves them. */
export const SUBSCRIPTIONS = {
  claude: { provider: 'anthropic', label: 'Claude Pro/Max' },
  chatgpt: { provider: 'openai', label: 'ChatGPT Plus/Pro' },
} as const;
export type Subscription = keyof typeof SUBSCRIPTIONS;

let models: MutableModels | undefined;
let packagesLoaded: Promise<void> | undefined;

/**
 * gloss's own pi-ai registry. It owns the credential store, so OAuth logins and token
 * refresh live here; Flue's registry borrows auth from it (see `flue-runtime.ts`).
 */
export function getModels(): MutableModels {
  if (!models) {
    models = createModels({ credentials: new FileCredentialStore(glossPath('auth.json')) });
    for (const provider of [anthropicProvider(), openaiProvider(), typesafeProvider(), openrouterProvider()]) {
      models.setProvider(provider);
    }
  }
  return models;
}

/**
 * Loads third-party pi provider packages (`providerPackages` in config). Each package
 * default-exports a `Provider` or a zero-argument factory returning one; a package may
 * replace a built-in (same id), e.g. an alternative subscription login.
 */
export function loadProviderPackages(names: readonly string[]): Promise<void> {
  packagesLoaded ??= (async () => {
    for (const name of names) {
      const module = (await import(name)) as { default?: unknown; provider?: unknown };
      const exported = module.default ?? module.provider;
      const provider = (typeof exported === 'function' ? (exported as () => unknown)() : exported) as
        | Provider
        | undefined;
      if (!provider || typeof provider !== 'object' || typeof provider.id !== 'string') {
        throw new Error(`Provider package "${name}" does not export a pi Provider.`);
      }
      getModels().setProvider(provider);
    }
  })();
  return packagesLoaded;
}
