import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { GenerationBudget } from "./budget.ts";
import { intFromEnv, selectProvider } from "./config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(join(root, ".env"));
} catch {
  /* no .env — demo mode unless keys are in the real environment */
}

const provider = selectProvider();
const port = intFromEnv(process.env.PORT, 8787);
const production = process.env.NODE_ENV === "production";

const app = createApp({
  provider,
  budget: new GenerationBudget(
    intFromEnv(process.env.MAX_GENERATIONS_PER_HOUR, 20),
    intFromEnv(process.env.MAX_GENERATIONS_PER_DAY, 60),
  ),
  staticDir: production ? join(root, "dist") : undefined,
});

// Loopback only: this is a local app and the server holds your API key.
const server = createServer((req, res) => void app(req, res));
server.listen(port, "127.0.0.1", () => {
  console.log(`[server] http://127.0.0.1:${port}  ·  image provider: ${provider.label}`);
  if (provider.id === "mock") {
    console.log("[server] demo mode — add POLLINATIONS_API_KEY to tamagotchi/.env for real face-based mascots");
  }
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
