// One-time setup for FREE local generation on Apple Silicon:
//   1. installs MFLUX (MLX image models) with `uv tool install`
//   2. downloads FLUX.2 Klein 4B (~15 GB, Apache-2.0) by running one tiny
//      warm-up image, so your first hero doesn't sit on a huge download.
// Run: npm run setup:local
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const has = (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
const run = (cmd, args) => {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`\n✗ ${cmd} failed (exit ${r.status}).`);
    process.exit(1);
  }
};

if (process.platform !== "darwin" || process.arch !== "arm64") {
  console.error("Local generation needs a Mac with Apple Silicon (M1/M2/M3/M4). Use a Pollinations key instead — see README.");
  process.exit(1);
}

if (!has("mflux-generate-flux2-edit")) {
  if (!has("uv")) {
    console.error("Install uv first (Python tool manager):\n  brew install uv\nor\n  curl -LsSf https://astral.sh/uv/install.sh | sh\nthen run `npm run setup:local` again.");
    process.exit(1);
  }
  run("uv", ["tool", "install", "--upgrade", "mflux"]);
  if (!has("mflux-generate-flux2-edit")) {
    console.error("MFLUX installed but isn't on your PATH yet. Run `uv tool update-shell`, open a new terminal, and retry.");
    process.exit(1);
  }
}

console.log("\nDownloading FLUX.2 Klein 4B (~15 GB, one time) and running a tiny warm-up image…");
const dir = mkdtempSync(join(tmpdir(), "herogotchi-warmup-"));
try {
  run("mflux-generate-flux2", [
    "--model", process.env.MFLUX_MODEL || "flux2-klein-4b",
    "--prompt", "a cute chibi superhero toy, white background",
    "--steps", "1",
    "--width", "256",
    "--height", "256",
    "--quantize", process.env.MFLUX_QUANTIZE || "8",
    "--output", join(dir, "warmup.png"),
  ]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("\n✓ Local generation is ready. `npm run dev` will now use your Mac automatically (free, offline).");
