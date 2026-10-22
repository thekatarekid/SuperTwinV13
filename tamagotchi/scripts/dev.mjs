// Runs the API server and the Vite UI together; Ctrl+C stops both.
// Checks both ports first: if an older run (or another app) still holds one,
// the UI would silently start elsewhere and talk to the wrong server.
import { spawn } from "node:child_process";
import { createServer } from "node:net";

const apiPort = Number(process.env.PORT) || 8787;
const webPort = 5173;

function busy(port, host) {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", (err) => resolve(err.code === "EADDRINUSE"));
    s.listen(port, host, () => s.close(() => resolve(false)));
  });
}

const taken = [];
for (const [port, what] of [
  [apiPort, "API server"],
  [webPort, "web UI"],
]) {
  if ((await busy(port, "127.0.0.1")) || (await busy(port, "::1"))) taken.push({ port, what });
}
if (taken.length) {
  console.error("\n✗ Can't start: these ports are already in use by another program:\n");
  for (const t of taken) console.error(`   ${t.port}  (needed for the ${t.what})`);
  console.error("\n  Probably an earlier `npm run dev` is still running in another Terminal window —");
  console.error("  press Ctrl+C there. To see what holds a port:");
  for (const t of taken) console.error(`   lsof -nP -iTCP:${t.port} -sTCP:LISTEN`);
  console.error("  then stop it with `kill <PID>` and run `npm run dev` again.\n");
  process.exit(1);
}

const children = [
  spawn("npx", ["tsx", "watch", "server/index.ts"], { stdio: "inherit" }),
  spawn("npx", ["vite"], { stdio: "inherit" }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}
for (const c of children) c.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
