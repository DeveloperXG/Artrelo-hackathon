import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import process from "process";
import { fileURLToPath } from "url";

// This file is ESM, where __dirname does not exist — it is a CommonJS global.
// Rebuild it from import.meta.url so the "@" alias below resolves.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 3000,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/api": {
        // Overridable so a second dev server can point at a test-mode API
        // (see the *-test entries in .claude/launch.json) without touching
        // the dev database behind :5500.
        target: process.env.API_PROXY_TARGET || "http://localhost:5500",
        changeOrigin: true,
        secure: false,
      },
    },
  },
});
