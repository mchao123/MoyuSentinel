import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const { version } = await json("package.json");
const tag = `v${version}`;
assert.equal(process.env.GITHUB_REF, `refs/tags/${tag}`, "Release tag must match the package version");
assert.equal((await json("src-tauri/tauri.conf.json")).version, version, "Tauri version must match");
const lock = await json("package-lock.json");
assert.equal(lock.version, version, "npm lockfile version must match");
assert.equal(lock.packages[""].version, version, "npm root package version must match");
const cargo = await readFile("src-tauri/Cargo.toml", "utf8");
assert.equal(cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1], version, "Cargo version must match");
const cargoLock = await readFile("src-tauri/Cargo.lock", "utf8");
assert.equal(cargoLock.match(/name = "moyu-sentinel"\r?\nversion = "([^"]+)"/)?.[1], version, "Cargo lockfile version must match");
assert.ok((await readFile(`docs/releases/${tag}.md`, "utf8")).trim(), "Release notes must not be empty");
console.log(`Verified ${tag}: package versions and release notes are ready.`);
