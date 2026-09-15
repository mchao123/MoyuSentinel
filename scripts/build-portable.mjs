import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, copyFile, readdir, readFile, writeFile } from "node:fs/promises";

if (process.platform !== "win32")
  throw new Error("Build the Windows portable package on Windows.");
for (const args of [
  ["run", "assets"],
  ["run", "tauri", "--", "build", "--no-bundle"],
]) {
  const result = spawnSync("npm.cmd", args, { stdio: "inherit", shell: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await mkdir("release/MoyuSentinel", { recursive: true });
await copyFile(
  "src-tauri/target/release/moyu-sentinel.exe",
  "release/MoyuSentinel/MoyuSentinel.exe",
);
for (const name of await readdir("src-tauri/target/release")) {
  if (name.toLowerCase().endsWith(".dll"))
    await copyFile(
      `src-tauri/target/release/${name}`,
      `release/MoyuSentinel/${name}`,
    );
}
await copyFile("README.md", "release/MoyuSentinel/README.md");
await copyFile(
  "THIRD_PARTY_NOTICES.md",
  "release/MoyuSentinel/THIRD_PARTY_NOTICES.md",
);
const archive = spawnSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-Command",
    "$packageFiles = Get-ChildItem -LiteralPath 'release/MoyuSentinel' -File | Where-Object { $_.Extension -in '.exe','.dll','.md' }; Compress-Archive -LiteralPath $packageFiles.FullName -DestinationPath 'release/MoyuSentinel-windows-x64.zip' -Force",
  ],
  { stdio: "inherit" },
);
if (archive.status !== 0) process.exit(archive.status ?? 1);
const archivePath = "release/MoyuSentinel-windows-x64.zip";
const digest = createHash("sha256")
  .update(await readFile(archivePath))
  .digest("hex");
await writeFile(
  `${archivePath}.sha256`,
  `${digest}  MoyuSentinel-windows-x64.zip\n`,
);
console.log("Portable app: release/MoyuSentinel/MoyuSentinel.exe");
console.log(`SHA-256: ${digest}`);
