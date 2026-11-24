import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: {
    alias: {
      '@mazemeo/maze-core': fileURLToPath(new URL('../../packages/maze-core/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: fileURLToPath(new URL('../../dist/viewer', import.meta.url)),
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        lab: fileURLToPath(new URL('./lab.html', import.meta.url)),
        turnaround: fileURLToPath(new URL('./turnaround.html', import.meta.url)),
      },
    },
  },
});
