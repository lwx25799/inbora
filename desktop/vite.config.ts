import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  clearScreen: false,
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'inbora-development-identity',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__inbora_dev_instance') return next();
          response.setHeader('Content-Type', 'application/json');
          response.setHeader('Cache-Control', 'no-store');
          response.end(
            JSON.stringify({
              application: 'inbora-development',
              workspace: createHash('sha256').update(resolve(server.config.root)).digest('hex'),
            }),
          );
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    outDir: '../.local/desktop-web',
    emptyOutDir: true,
    target: 'es2022',
    assetsInlineLimit(filePath) {
      return /\.(?:woff2?|ttf|otf)$/iu.test(filePath) ? false : undefined;
    },
  },
});
