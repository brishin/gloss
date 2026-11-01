import { randomUUID } from 'node:crypto';
import type { LoginIO as LoginInteraction } from '@gloss/models';
import type { LoginMethod, LoginPrompt, LoginSession, Subscription } from '@gloss/protocol';

export type { LoginInteraction };

/** Runs one login flow to the end, storing the credential; rejects when it fails or is aborted. */
export type RunLogin = (
  subscription: Subscription,
  method: LoginMethod,
  io: LoginInteraction,
  signal: AbortSignal,
) => Promise<void>;

interface Entry {
  session: LoginSession;
  controller: AbortController;
  pending?: { id: number; resolve(value: string): void; reject(error: Error): void };
  finishedAt?: number;
}

const MAX_MESSAGES = 20;

/**
 * Logins the app drives: each runs pi-ai's interactive flow on the backend, and the app polls
 * its state and answers its prompts. One login per subscription runs at a time; a finished one
 * is kept for `keepMs` so the app sees how it ended. pi-ai takes an `AbortSignal`, so cancelling
 * a login aborts its controller.
 */
export class LoginSessions {
  readonly #run: RunLogin;
  readonly #keepMs: number;
  readonly #entries = new Map<string, Entry>();
  #nextPromptId = 1;

  constructor(run: RunLogin, { keepMs = 10 * 60_000 }: { keepMs?: number } = {}) {
    this.#run = run;
    this.#keepMs = keepMs;
  }

  start(subscription: Subscription, method: LoginMethod): LoginSession {
    this.#sweep();
    for (const entry of this.#entries.values()) {
      if (entry.session.subscription === subscription && entry.session.state === 'running') {
        this.#cancel(entry);
      }
    }
    const session: LoginSession = { id: randomUUID(), subscription, method, state: 'running', messages: [] };
    const entry: Entry = { session, controller: new AbortController() };
    this.#entries.set(session.id, entry);
    const { signal } = entry.controller;

    const io: LoginInteraction = {
      notify: (event) => {
        if (entry.session.state !== 'running') return;
        if (event.type === 'auth_url') {
          this.#update(entry, { authUrl: { url: event.url, instructions: event.instructions } });
        } else if (event.type === 'device_code') {
          this.#update(entry, { deviceCode: { userCode: event.userCode, verificationUri: event.verificationUri } });
        } else {
          this.#update(entry, { messages: [...entry.session.messages, event.message].slice(-MAX_MESSAGES) });
        }
      },
      prompt: (asked) =>
        new Promise<string>((resolve, reject) => {
          const promptSignal = asked.signal;
          const prompt: Omit<LoginPrompt, 'id'> = {
            type: asked.type,
            message: asked.message,
            ...('placeholder' in asked && asked.placeholder !== undefined ? { placeholder: asked.placeholder } : {}),
            ...(asked.type === 'select' ? { options: asked.options.map((option) => ({ ...option })) } : {}),
          };
          if (signal.aborted || promptSignal?.aborted) {
            reject(new Error('Login cancelled'));
            return;
          }
          entry.pending?.reject(new Error('Superseded by a new prompt'));
          const id = this.#nextPromptId++;
          const settle = () => {
            if (entry.pending?.id === id) {
              entry.pending = undefined;
              this.#update(entry, { prompt: undefined });
            }
          };
          // The flow withdraws a prompt when something else answered it (e.g. the OAuth callback won).
          promptSignal?.addEventListener('abort', () => {
            settle();
            reject(new Error('Prompt withdrawn'));
          });
          entry.pending = {
            id,
            resolve: (value) => {
              settle();
              resolve(value);
            },
            reject: (error) => {
              settle();
              reject(error);
            },
          };
          this.#update(entry, { prompt: { id, ...prompt } });
        }),
    };

    this.#run(subscription, method, io, signal).then(
      () => this.#finish(entry, { state: 'succeeded' }),
      (error: unknown) =>
        this.#finish(
          entry,
          signal.aborted
            ? { state: 'cancelled' }
            : { state: 'failed', error: error instanceof Error ? error.message : String(error) },
        ),
    );
    return entry.session;
  }

  get(id: string): LoginSession | undefined {
    this.#sweep();
    return this.#entries.get(id)?.session;
  }

  /** Answers the login's current prompt; false when that prompt is no longer the one waiting. */
  answer(id: string, promptId: number, value: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry?.pending || entry.pending.id !== promptId) {
      return false;
    }
    entry.pending.resolve(value);
    return true;
  }

  cancel(id: string): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    this.#cancel(entry);
    return true;
  }

  /** Aborts every running login (server shutdown). */
  close(): void {
    for (const entry of this.#entries.values()) {
      this.#cancel(entry);
    }
  }

  #cancel(entry: Entry) {
    if (entry.session.state !== 'running') return;
    entry.controller.abort();
    entry.pending?.reject(new Error('Login cancelled'));
    this.#finish(entry, { state: 'cancelled' });
  }

  #update(entry: Entry, patch: Partial<LoginSession>) {
    // Replaced, never mutated: a session handed out earlier stays a consistent snapshot.
    const next = { ...entry.session, ...patch };
    if ('prompt' in patch && patch.prompt === undefined) delete next.prompt;
    entry.session = next;
  }

  #finish(entry: Entry, patch: Pick<LoginSession, 'state' | 'error'>) {
    if (entry.session.state !== 'running') return;
    entry.pending = undefined;
    this.#update(entry, { ...patch, prompt: undefined });
    entry.finishedAt = Date.now();
  }

  #sweep() {
    const now = Date.now();
    for (const [id, entry] of this.#entries) {
      if (entry.finishedAt !== undefined && now - entry.finishedAt > this.#keepMs) {
        this.#entries.delete(id);
      }
    }
  }
}
