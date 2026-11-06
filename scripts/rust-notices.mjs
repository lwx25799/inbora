import { spawnSync } from "node:child_process";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
const metadata = spawnSync(
  "cargo",
  [
    "metadata",
    "--locked",
    "--format-version",
    "1",
    "--filter-platform",
    "x86_64-pc-windows-msvc",
    "--manifest-path",
    "desktop/src-tauri/Cargo.toml",
  ],
  { encoding: "utf8", windowsHide: true, maxBuffer: 20_000_000 },
);
if (metadata.status !== 0) throw new Error("CARGO_LICENSE_METADATA_FAILED");
let output = "inbora Windows x64 Rust dependencies\n";
for (const pkg of JSON.parse(metadata.stdout).packages) {
  output += `\n## ${pkg.name} ${pkg.version} (${pkg.license ?? "application"})\n`;
  const root = dirname(pkg.manifest_path),
    files = await readdir(root);
  for (const file of files.filter((file) =>
    /^(license|copying|notice)([-.]|$)/i.test(file),
  )) {
    try {
      output += (await readFile(join(root, file), "utf8")) + "\n";
    } catch (error) {
      if (error.code !== "EISDIR") throw error;
    }
  }
}
const folder = resolve(".local/build-licenses");
await mkdir(folder, { recursive: true });
await writeFile(join(folder, "RUST-DEPENDENCY-NOTICES.txt"), output);
console.log(
  "Rust dependency license texts collected from locked crate sources",
);
