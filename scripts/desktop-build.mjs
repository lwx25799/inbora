import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const env = { ...process.env };
const cargo = join(root, ".local", "toolchains", "cargo");
if (!env.CARGO_HOME && existsSync(join(cargo, "bin", "cargo.exe"))) {
  env.CARGO_HOME = cargo;
  env.RUSTUP_HOME = join(root, ".local", "toolchains", "rustup");
  env.PATH = join(cargo, "bin") + ";" + (env.PATH ?? env.Path ?? "");
  delete env.Path;
}
const dev = process.argv.includes("--dev");
if (dev) env.INBORA_DEV_NODE = process.execPath;
const args = [
  join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
  dev ? "dev" : "build",
];
if (!dev) args.push("--ci", "--", "--locked");
else {
  const configuration = join(root, ".local", "desktop-dev.conf.json");
  mkdirSync(join(root, ".local"), { recursive: true });
  writeFileSync(configuration, JSON.stringify({ identifier: "app.inbora.development", app: { windows: [{
    label: "main", title: "inbora · 开发调试", width: 1240, height: 800, minWidth: 900, minHeight: 640,
    dataDirectory: join(root, ".local", "desktop-dev-webview"),
  }] } }));
  args.push("--config", configuration);
}
const result = spawnSync(process.execPath, args, {
  cwd: join(root, "desktop"),
  env,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
