import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Brand assets are served straight out of branding/ so the SVGs in the repo
// are the ones the UI renders — no duplicated copies to drift (CLAUDE.md §8).
export default defineConfig({
  plugins: [react()],
  publicDir: "../branding",
  server: {
    proxy: {
      "/api": {
        target: "https://localhost:8443",
        changeOrigin: false,
        // Dev only: a lab DC's LDAPS/API certificate is usually self-signed.
        secure: false,
      },
    },
  },
});
