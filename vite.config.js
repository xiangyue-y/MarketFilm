import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiUrl = `http://127.0.0.1:${process.env.API_PORT || 4188}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': apiUrl,
      '/media': apiUrl,
    },
  },
});
