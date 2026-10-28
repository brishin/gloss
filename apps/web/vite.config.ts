import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 4778, host: '127.0.0.1' },
  plugins: [
    // SPA mode: the gloss backend is a separate HTTP+SSE API, so the web app is a static
    // client that can point at a local or remote backend.
    tanstackStart({ spa: { enabled: true } }),
    react(),
  ],
});
