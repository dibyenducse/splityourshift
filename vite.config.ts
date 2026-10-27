import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative base so the build works on GitHub Pages (/splityourshift/), Hostinger or a custom domain.
export default defineConfig({
  base: './',
  plugins: [react()],
});
