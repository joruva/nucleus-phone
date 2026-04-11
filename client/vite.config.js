import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Single source of truth for team roster — imported by Activity filter dropdown
      // and any future components needing the team list. Points to server/config/team.json
      // so there's no drift between frontend and backend.
      '@server-config': path.resolve(__dirname, '../server/config'),
    },
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
