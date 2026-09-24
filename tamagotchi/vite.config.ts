import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API server holds the key; the UI only ever talks to /api.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.ts", "shared/**/*.test.ts"],
    environment: "node",
  },
});
