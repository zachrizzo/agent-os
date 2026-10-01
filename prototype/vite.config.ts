import { defineConfig } from 'vite';

const API = `http://127.0.0.1:${process.env.AGENT_OS_API_PORT ?? 5198}`;

export default defineConfig({
  base: '/',
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    // Behind an OpenClaw portal (e.g. http://127.0.0.1:50879/) the browser must dial the portal port for HMR.
    hmr: { clientPort: Number(process.env.HMR_CLIENT_PORT ?? 5199) },
    proxy: { '/api': { target: API, changeOrigin: false } },
  },
});
