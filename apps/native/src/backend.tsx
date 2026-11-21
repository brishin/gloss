import { createHttpGlossClient, type GlossClient } from '@gloss/protocol';
import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** Set `EXPO_PUBLIC_GLOSS_SERVER` in `.env.local`, such as the `tailscale serve` URL of the Mac running `gloss serve`. */
export const DEFAULT_SERVER = process.env.EXPO_PUBLIC_GLOSS_SERVER ?? 'http://localhost:4777';

export interface Backend {
  /** The gloss server, which serves both the API and the web app. */
  url: string;
  /** Sent as a bearer token when the server runs with `--token`. */
  token?: string;
}

interface BackendContext {
  backend: Backend;
  client: GlossClient;
  ready: boolean;
  save: (backend: Backend) => Promise<void>;
}

const Context = createContext<BackendContext | undefined>(undefined);

const URL_KEY = 'gloss.server';
const TOKEN_KEY = 'gloss.token';

export function BackendProvider({ children }: { children: ReactNode }) {
  const [backend, setBackend] = useState<Backend>({ url: DEFAULT_SERVER });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void Promise.all([SecureStore.getItemAsync(URL_KEY), SecureStore.getItemAsync(TOKEN_KEY)]).then(([url, token]) => {
      setBackend({ url: url || DEFAULT_SERVER, token: token || undefined });
      setReady(true);
    });
  }, []);

  const save = useCallback(async (next: Backend) => {
    const url = next.url.trim().replace(/\/+$/, '') || DEFAULT_SERVER;
    const token = next.token?.trim() || undefined;
    await SecureStore.setItemAsync(URL_KEY, url);
    await (token ? SecureStore.setItemAsync(TOKEN_KEY, token) : SecureStore.deleteItemAsync(TOKEN_KEY));
    setBackend({ url, token });
  }, []);

  // expo/fetch streams response bodies, which the SSE parser in GlossClient needs.
  const client = useMemo(
    () =>
      createHttpGlossClient({
        baseUrl: backend.url,
        token: backend.token,
        fetch: expoFetch as unknown as typeof fetch,
      }),
    [backend],
  );

  const value = useMemo(() => ({ backend, client, ready, save }), [backend, client, ready, save]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useBackend(): BackendContext {
  const value = useContext(Context);
  if (!value) {
    throw new Error('useBackend outside BackendProvider');
  }
  return value;
}
