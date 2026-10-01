import { defineConfig } from 'vite';

const API = `http://127.0.0.1:${process.env.AGENT_OS_API_PORT ?? 5198}`;

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5199,
    strictPort: true,
    proxy: { '/api': { target: API, changeOrigin: false } },
  },
});
