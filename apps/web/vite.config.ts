import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  // Static build that works from IPFS / eth.limo sub-paths
  base: "./",
  server: {
    // Local demo server (apps/demo-server) for the Live Demo cockpit
    proxy: { "/api": process.env.DEMO_API ?? "http://127.0.0.1:8787" },
  },
});
