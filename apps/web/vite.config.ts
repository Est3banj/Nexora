import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "fonts/*.woff2", "fonts/*-OFL.txt"],
      manifest: {
        name: "NEXORA",
        short_name: "NEXORA",
        display: "standalone",
        background_color: "#f1f5f9",
        theme_color: "#f1f5f9",
        start_url: "/",
        icons: [
          {
            src: "/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  // PGlite loads postgres.data/postgres.wasm relative to import.meta.url.
  // Vite's dep optimizer rewrites that URL into .vite/deps/ where those files
  // do not exist (SPA fallback returns index.html → "Invalid FS bundle size").
  // Excluding it keeps native ESM resolution against the real dist/ path.
  optimizeDeps: {
    exclude: ["@electric-sql/pglite"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.VITE_API_PROXY ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
