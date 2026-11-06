import {
  cp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
  readdir,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const destination = join(root, ".local", "staged-sidecar");
try {
  await stat(destination);
  const marker = JSON.parse(
    await readFile(join(destination, ".inbora-owned-build.json"), "utf8"),
  );
  if (marker.kind !== "inbora-sidecar-build")
    throw new Error("BUILD_DIRECTORY_NOT_OWNED");
  await rm(destination, { recursive: true });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(destination, { recursive: true });
await writeFile(
  join(destination, ".inbora-owned-build.json"),
  JSON.stringify({ kind: "inbora-sidecar-build" }),
);
for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"])
  await cp(join(root, file), join(destination, file));
await writeFile(
  join(destination, "pnpm-workspace.yaml"),
  (await readFile(join(root, "pnpm-workspace.yaml"), "utf8")) +
    "\nnodeLinker: hoisted\n",
);
const install = spawnSync(
  process.env.ComSpec ?? "cmd.exe",
  ["/d", "/s", "/c", "pnpm install --prod --frozen-lockfile --ignore-scripts"],
  { cwd: destination, stdio: "inherit", windowsHide: true },
);
if (install.status !== 0) throw new Error("SIDECAR_DEPENDENCY_INSTALL_FAILED");
await cp(join(root, "dist"), join(destination, "dist"), { recursive: true });
await cp(process.execPath, join(destination, "node.exe"));
await cp(join(root, "third_party"), join(destination, "third_party"), {
  recursive: true,
});
const license = await fetch(
  "https://raw.githubusercontent.com/nodejs/node/v26.13.0/LICENSE",
);
if (!license.ok) throw new Error("NODE_LICENSE_DOWNLOAD_FAILED");
await writeFile(join(destination, "NODE-LICENSE.txt"), await license.text());
const sha = (data) => createHash("sha256").update(data).digest("hex");
async function packageNotices(folder) {
  let notices = "";
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const path = join(folder, entry.name);
    if (entry.name.startsWith("@")) {
      notices += await packageNotices(path);
      continue;
    }
    const manifest = JSON.parse(
      await readFile(join(path, "package.json"), "utf8"),
    );
    notices += `\n## ${manifest.name} ${manifest.version} (${manifest.license ?? "see package"})\n`;
    const files = await readdir(path);
    for (const file of files.filter((file) =>
      /^(license|copying|notice)(\.|$)/i.test(file),
    ))
      notices += (await readFile(join(path, file), "utf8")) + "\n";
  }
  return notices;
}
await writeFile(
  join(destination, "DEPENDENCY-NOTICES.txt"),
  await packageNotices(join(destination, "node_modules")),
);
const smoke = spawnSync(
  join(destination, "node.exe"),
  [
    "--input-type=module",
    "-e",
    "import {ClientService} from './dist/app/service.js';import {chromium} from 'playwright';import Database from 'better-sqlite3';if(!ClientService||!chromium)process.exit(3);const db=new Database(':memory:');db.exec('create table smoke(id integer);insert into smoke values(1)');if(db.prepare('select id from smoke').get().id!==1)process.exit(2);db.close();console.log('staged full application imports, Node and SQLite runtime passed');",
  ],
  {
    cwd: destination,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
  },
);
if (smoke.status !== 0) throw new Error("SIDECAR_NATIVE_SQLITE_FAILED");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
await writeFile(
  join(destination, "BUILD-MANIFEST.json"),
  JSON.stringify(
    {
      version: manifest.version,
      node: process.version,
      nodeSha256: sha(await readFile(join(destination, "node.exe"))),
      entrySha256: sha(
        await readFile(join(destination, "dist/app/sidecar.js")),
      ),
    },
    null,
    2,
  ),
);
console.log(
  `Sidecar prepared at ${destination}; no development-machine path is needed at runtime.`,
);
