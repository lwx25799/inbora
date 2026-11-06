import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const env = { ...process.env };
const cargo = join(root, ".local", "toolchains", "cargo");
if (existsSync(join(cargo, "bin", "cargo.exe"))) {
  env.CARGO_HOME = cargo;
  env.RUSTUP_HOME = join(root, ".local", "toolchains", "rustup");
  env.PATH = join(cargo, "bin") + ";" + (env.PATH ?? env.Path ?? "");
  delete env.Path;
}
const dev = process.argv.includes("--dev");
const args = [
  join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
  dev ? "dev" : "build",
];
if (!dev) args.push("--ci", "--", "--locked");
const result = spawnSync(process.execPath, args, {
  cwd: join(root, "desktop"),
  env,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
