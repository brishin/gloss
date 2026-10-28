import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai';

/**
 * pi-ai's `CredentialStore` over one JSON file (mode 0600). Writes go through a
 * per-provider promise chain, so concurrent OAuth refreshes in this process never
 * double-refresh a rotated token. The file is re-read on every access, so a
 * `gloss login` in another terminal is picked up without a restart.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #path: string;
  readonly #chains = new Map<string, Promise<unknown>>();

  constructor(path: string) {
    this.#path = path;
  }

  #readAll(): Record<string, Credential> {
    try {
      return JSON.parse(readFileSync(this.#path, 'utf8')) as Record<string, Credential>;
    } catch {
      return {};
    }
  }

  #writeAll(all: Record<string, Credential>) {
    mkdirSync(dirname(this.#path), { recursive: true });
    const temp = `${this.#path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(all, null, 2), { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.#path);
  }

  #serialize<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(providerId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.#chains.set(
      providerId,
      next.catch(() => {}),
    );
    return next;
  }

  async read(providerId: string): Promise<Credential | undefined> {
    return this.#readAll()[providerId];
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.#readAll()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.#serialize(providerId, async () => {
      const current = this.#readAll()[providerId];
      const next = await fn(current);
      if (next !== undefined) {
        this.#writeAll({ ...this.#readAll(), [providerId]: next });
        return next;
      }
      return current;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.#serialize(providerId, async () => {
      const all = this.#readAll();
      delete all[providerId];
      this.#writeAll(all);
    });
  }
}
