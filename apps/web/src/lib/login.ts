import type { Health, ProviderLogin } from '@gloss/protocol';

/**
 * The subscriptions the backend's models need but cannot use yet: a provider the config
 * uses is not signed in, and the app knows how to sign it in. One entry per subscription.
 */
export function missingLogins(health: Pick<Health, 'providers'>): ProviderLogin[] {
  const seen = new Set<string>();
  const missing: ProviderLogin[] = [];
  for (const provider of health.providers) {
    if (!provider.configured && provider.login && !seen.has(provider.login.subscription)) {
      seen.add(provider.login.subscription);
      missing.push(provider.login);
    }
  }
  return missing;
}
