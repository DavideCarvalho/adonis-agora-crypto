import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Builds the console into `dist/spa`. `base` is a placeholder (`/__CRYPTO_DASHBOARD__/`) the
 * server rewrites at serve time to the configured mount path, so the same bundle works
 * mounted anywhere with no rebuild — the pattern every Agora console uses.
 */
export default defineConfig({
  base: '/__CRYPTO_DASHBOARD__/',
  plugins: [react(), tailwindcss()],
  // Files a STYLESHEET references (the bundled Sora / JetBrains Mono fonts) resolve relative to
  // that stylesheet: the provider rewrites the placeholder base in `index.html` only.
  experimental: {
    renderBuiltUrl: (_file, { hostType }) => (hostType === 'css' ? { relative: true } : undefined),
  },
  build: {
    outDir: 'dist/spa',
    emptyOutDir: true,
    sourcemap: true,
  },
});
