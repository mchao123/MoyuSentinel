import { chromium, expect } from "@playwright/test";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import sharp from "sharp";
import { promisify } from "node:util";

const native = process.argv.includes("--native");
let server;
let browser;
let control;
let savedSettings;
const invoke = (command, args = {}) => control.evaluate(
  ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
  { command, args },
);
const style = (page) => page.locator(".glow-layer").evaluate((element) => {
  const value = getComputedStyle(element, "::before");
  return { inset: parseFloat(value.top), opacity: Number(value.opacity), visibility: document.visibilityState };
});
const seek = (page, time, duration = 420) => page.locator(".glow-layer").evaluate((element, { time, duration }) => {
  const animations = element.getAnimations({ subtree: true });
  if (!animations.length) throw new Error("The glow must have an active transition");
  for (const animation of animations) {
    animation.pause();
    animation.currentTime = time;
    if (time >= duration) animation.finish();
  }
}, { time, duration });
try {
  await mkdir("test-results", { recursive: true });
  if (native) {
    browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
    control = browser.contexts().flatMap((context) => context.pages())
      .find((page) => !/[?&](overlay|popup)=/.test(page.url()));
    assert.ok(control);
    savedSettings = await invoke("load_settings");
    await invoke("stop_monitoring");
    await invoke("resume_reminders");
    await invoke("save_settings", { settings: { ...savedSettings, alertMode: "edge" } });
    await invoke("prepare_overlays");
    await expect.poll(() => browser.contexts().flatMap((context) => context.pages())
      .filter((page) => page.url().includes("overlay=1")).length).toBeGreaterThan(0);
    const surface = browser.contexts().flatMap((context) => context.pages())
      .find((page) => page.url().includes("overlay=1"));
    const activate = (active) => invoke("set_alert", { active, intensity: 0.9, width: 70, test: true });
    await activate(false);
    await surface.waitForTimeout(1600);
    await activate(true);
    await surface.locator(".glow-layer.active").waitFor({ state: "attached" });
    await surface.waitForTimeout(80);
    const entering = await style(surface);
    assert.ok(entering.inset < 0 && entering.inset > -84, JSON.stringify(entering));
    await surface.waitForTimeout(450);
    assert.equal((await style(surface)).inset, 0);
    await activate(false);
    await surface.waitForFunction(() => !document.querySelector(".glow-layer.active"));
    await surface.waitForTimeout(80);
    const leaving = await style(surface);
    assert.equal(leaving.inset, 0, "Fade-out must retain the full glow width");
    assert.ok(leaving.opacity > 0 && leaving.opacity < 1, JSON.stringify(leaving));
    await activate(true);
    await surface.locator(".glow-layer.active").waitFor({ state: "attached" });
    await surface.waitForTimeout(1400);
    assert.equal((await style(surface)).opacity, 1, "Reactivation must restore full brightness");
    await activate(false);
    await surface.waitForTimeout(1700);
    assert.equal((await style(surface)).opacity, 0);
    const inspected = await promisify(execFile)("powershell.exe", ["-NoProfile", "-File", "scripts/native-window-check.ps1"], { encoding: "utf8" });
    assert.ok(JSON.parse(inspected.stdout).windows.filter((window) => window.title === "Moyu Sentinel Alert").every((window) => !window.visible));
    console.log("PASS: native entrance, visible exit animation, reactivation, and delayed window hiding.");
  } else {
    server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "1421", "--strictPort"], { windowsHide: true, stdio: "ignore" });
    await expect.poll(async () => {
      assert.equal(server.exitCode, null, "The temporary preview server must start");
      return fetch("http://127.0.0.1:1421").then((response) => response.ok).catch(() => false);
    }, { timeout: 10000 }).toBe(true);
    browser = await chromium.launch({ channel: "msedge", headless: true });
    for (const viewport of [{ width: 940, height: 650 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport });
      await page.goto("http://127.0.0.1:1421");
      await page.getByRole("button", { name: "开始检测", exact: true }).waitFor();
      const activate = (active) => page.evaluate((active) => window.dispatchEvent(new CustomEvent("preview-glow", {
        detail: { active, intensity: 0.9, width: 70, color: "#ff1930" },
      })), active);
      const initial = await style(page);
      assert.equal(initial.opacity, 0);
      assert.ok(initial.inset < 0);
      await activate(true);
      await page.locator(".glow-layer.active").waitFor({ state: "attached" });
      await seek(page, 150);
      const entering = await style(page);
      assert.ok(entering.inset > -84 && entering.inset < 0);
      assert.ok(entering.opacity > 0 && entering.opacity < 1);
      await page.screenshot({ path: `test-results/glow-enter-${viewport.width}.png` });
      await seek(page, 420);
      const active = await page.screenshot({ path: `test-results/glow-active-${viewport.width}.png` });
      const { data, info } = await sharp(active).raw().toBuffer({ resolveWithObject: true });
      const index = (Math.floor(viewport.height / 2) * info.width + 8) * info.channels;
      assert.ok(data[index] - data[index + 1] > 40, "Screen-edge pixels must show the glow");
      await activate(false);
      await page.waitForFunction(() => !document.querySelector(".glow-layer.active"));
      await seek(page, 500, 1000);
      const leaving = await style(page);
      assert.equal(leaving.inset, 0);
      assert.ok(leaving.opacity > 0 && leaving.opacity < 1);
      await page.screenshot({ path: `test-results/glow-exit-${viewport.width}.png` });
      await seek(page, 1000, 1000);
      assert.equal((await style(page)).opacity, 0);
      await page.close();
    }
    console.log("PASS: desktop/mobile inward entrance, gradual full-width fade-out, and visible glow pixels.");
  }
} finally {
  if (native && control) {
    await invoke("set_alert", { active: false, intensity: 0.7, width: 52, test: false }).catch(() => {});
    if (savedSettings) await invoke("save_settings", { settings: savedSettings });
  }
  await browser?.close();
  if (server && server.exitCode === null) {
    const exited = once(server, "exit");
    server.kill();
    await exited;
  }
}
