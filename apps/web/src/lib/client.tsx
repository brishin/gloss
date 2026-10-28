import { createHttpGlossClient, DEFAULT_BACKEND_URL, type GlossClient } from '@gloss/protocol';
import { createContext, type ReactNode, useContext, useMemo } from 'react';

declare global {
  interface Window {
    /** Injected by the gloss CLI when it serves this app; `backendUrl: ''` means same origin. */
    __GLOSS__?: { backendUrl?: string; token?: string };
  }
}

/** Where the backend is: CLI-injected config, else a build-time env var, else the local default. */
export function backendConfig(): { baseUrl: string; token?: string } {
  const injected = typeof window === 'undefined' ? undefined : window.__GLOSS__;
  return {
    baseUrl: injected?.backendUrl ?? import.meta.env.VITE_GLOSS_BACKEND_URL ?? DEFAULT_BACKEND_URL,
    token: injected?.token ?? import.meta.env.VITE_GLOSS_TOKEN,
  };
}

const GlossClientContext = createContext<GlossClient | undefined>(undefined);

export function GlossClientProvider({ client, children }: { client?: GlossClient; children: ReactNode }) {
  const value = useMemo(() => client ?? createHttpGlossClient(backendConfig()), [client]);
  return <GlossClientContext value={value}>{children}</GlossClientContext>;
}

export function useGlossClient(): GlossClient {
  const client = useContext(GlossClientContext);
  if (!client) {
    throw new Error('useGlossClient outside GlossClientProvider');
  }
  return client;
}
