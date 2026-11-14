import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "fonts/*.woff2", "fonts/*-OFL.txt"],
      workbox: {
        // App-shell fallback for navigations — EXCEPT the API: a request
        // under /api/ must reach the network, never index.html. (/api/auth/*
        // and /api/settings are covered by the same prefix.)
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//],
        // Explicit runtime policy (Partition B). Routes are evaluated in
        // order and precached URLs win first, so this is the safety net —
        // and the place where "never cache API responses" is written down:
        //   · hashed build output under /assets/ → immutable, cache-first
        //   · the HTML shell + the service worker → revalidate (network first)
        //   · everything under /api/ (auth, settings, business data) matches
        //     NO route below and is never written to a runtime cache
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/assets/"),
            handler: "CacheFirst",
            options: {
              cacheName: "nexora-assets",
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
          {
            // `sw.js` is not precached (a worker never caches itself) and
            // non-precached documents are the only ones that reach here —
            // network first so a deploy is picked up on the next navigation.
            // (`request.destination === "serviceworker"` is not in the DOM
            // lib types, so the worker is matched by path instead.)
            urlPattern: ({ url, request }) =>
              !url.pathname.startsWith("/api/") &&
              (request.destination === "document" || url.pathname === "/sw.js"),
            handler: "NetworkFirst",
            options: {
              cacheName: "nexora-pages",
              networkTimeoutSeconds: 4,
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 32, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
        ],
        cleanupOutdatedCaches: true,
      },
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
