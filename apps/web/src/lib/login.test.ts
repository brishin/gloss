import { describe, expect, it } from 'vitest';
import { missingLogins } from './login.ts';

const claude = { subscription: 'claude' as const, label: 'Claude Pro/Max', apiKeyLabel: 'Anthropic API key' };
const chatgpt = { subscription: 'chatgpt' as const, label: 'ChatGPT Plus/Pro', apiKeyLabel: 'OpenAI API key' };

describe('missingLogins', () => {
  it('lists unconfigured providers the app can sign in, once each', () => {
    expect(
      missingLogins({
        providers: [
          { id: 'anthropic', configured: false, login: claude },
          { id: 'openai', configured: true, source: 'OAuth', login: chatgpt },
          // No way to sign it in from the app: not prompted for.
          { id: 'typesafe', configured: false },
          { id: 'anthropic-alt', configured: false, login: claude },
        ],
      }),
    ).toEqual([claude]);
  });

  it('is empty when everything is signed in', () => {
    expect(missingLogins({ providers: [{ id: 'anthropic', configured: true, login: claude }] })).toEqual([]);
  });
});
