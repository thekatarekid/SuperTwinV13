import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Never drift to another port: a second copy would talk to whatever
    // server already owns the API port.
    strictPort: true,
    // The API server holds the key; the UI only ever talks to /api.
    proxy: { "/api": `http://127.0.0.1:${Number(process.env.PORT) || 8787}` },
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}", "server/**/*.test.ts", "shared/**/*.test.ts"],
    environment: "node",
  },
});
