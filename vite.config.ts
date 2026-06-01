import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { existsSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

function renameHtmlOutput() {
  return {
    name: 'rename-html-output',
    closeBundle() {
      const indexHtml = resolve('dist/index.html');
      const quotaMonitorHtml = resolve('dist/quota-monitor.html');
      if (existsSync(indexHtml)) {
        renameSync(indexHtml, quotaMonitorHtml);
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    viteSingleFile({
      removeViteModuleLoader: true,
    }),
    renameHtmlOutput(),
  ],
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 100000000,
    chunkSizeWarningLimit: 100000000,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: 'quota-monitor.js',
        assetFileNames: 'quota-monitor.[ext]',
      },
    },
  },
});
