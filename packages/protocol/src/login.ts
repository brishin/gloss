import * as v from 'valibot';

/** The subscriptions gloss can sign in with, by gloss's name (`gloss login claude|chatgpt`). */
export const SubscriptionSchema = v.picklist(['claude', 'chatgpt']);
export type Subscription = v.InferOutput<typeof SubscriptionSchema>;

/** A subscription's OAuth sign-in, or the provider's API key. */
export const LoginMethodSchema = v.picklist(['oauth', 'api_key']);
export type LoginMethod = v.InferOutput<typeof LoginMethodSchema>;

/** How a missing provider can be signed in from the app (`Health.providers[].login`). */
export const ProviderLoginSchema = v.object({
  subscription: SubscriptionSchema,
  /** "Claude Pro/Max" */
  label: v.string(),
  /** "Anthropic API key" */
  apiKeyLabel: v.string(),
});
export type ProviderLogin = v.InferOutput<typeof ProviderLoginSchema>;

/** A question the login flow is waiting on; `id` changes with every new question. */
export const LoginPromptSchema = v.object({
  id: v.number(),
  type: v.picklist(['text', 'secret', 'select', 'manual_code']),
  message: v.string(),
  placeholder: v.optional(v.string()),
  options: v.optional(v.array(v.object({ id: v.string(), label: v.string(), description: v.optional(v.string()) }))),
});
export type LoginPrompt = v.InferOutput<typeof LoginPromptSchema>;

/**
 * A login running on the backend, as the app polls it. Credentials never appear here:
 * the backend stores them in its own credential store.
 */
export const LoginSessionSchema = v.object({
  id: v.string(),
  subscription: SubscriptionSchema,
  method: LoginMethodSchema,
  state: v.picklist(['running', 'succeeded', 'failed', 'cancelled']),
  /** The sign-in page to open (OAuth). */
  authUrl: v.optional(v.object({ url: v.string(), instructions: v.optional(v.string()) })),
  /** A device code to enter at `verificationUri` (device-code OAuth). */
  deviceCode: v.optional(v.object({ userCode: v.string(), verificationUri: v.string() })),
  /** Info and progress messages, oldest first. */
  messages: v.array(v.string()),
  prompt: v.optional(LoginPromptSchema),
  error: v.optional(v.string()),
});
export type LoginSession = v.InferOutput<typeof LoginSessionSchema>;

export const StartLoginRequestSchema = v.object({ subscription: SubscriptionSchema, method: LoginMethodSchema });
export const LoginAnswerSchema = v.object({ promptId: v.number(), value: v.string() });

export function isLoginFinished(session: Pick<LoginSession, 'state'>): boolean {
  return session.state !== 'running';
}
