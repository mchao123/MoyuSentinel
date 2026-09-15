import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import sharp from "sharp";

await mkdir("test-results", { recursive: true });
const native = process.argv.includes("--native");
const browser = native ? await chromium.connectOverCDP("http://127.0.0.1:9223") : await chromium.launch({ channel: "msedge", headless: true });
const page = native ? browser.contexts().flatMap((context) => context.pages()).find((page) => !/[?&](overlay|popup)=/.test(page.url())) : await browser.newPage({ viewport: { width: 940, height: 650 } });
const invoke = (command, args = {}) => page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let savedSettings;
let savedSharing;
let peers = [];
const importedIds = [];
const fixtures = await Promise.all(["#ff3344", "#22aa88", "#4488ff"].map(async (background, index) => ({ name: `ad-${index + 1}.png`, mimeType: "image/png", buffer: await sharp({ create: { width: 320, height: 200, channels: 4, background } }).png().toBuffer() })));
async function mockPeer(name) {
  const state = { protocolVersion: 1, sourceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), deviceName: name, phase: "watching", people: 0, alertEvent: 0, updatedAt: Date.now() };
  let authorized = 0;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer 12345678") { response.writeHead(401); response.end("{}"); return; }
    authorized++;
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ ...state, updatedAt: Date.now() }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { server, state, address: `http://127.0.0.1:${server.address().port}`, requests: () => authorized };
}
try {
  if (!native) await page.goto(process.env.MOYU_TEST_URL || "http://127.0.0.1:1420");
  await page.getByRole("button", { name: "开始检测", exact: true }).waitFor();
  if (native) {
    savedSettings = await invoke("load_settings"); savedSharing = (await invoke("sharing_state")).config;
    assert.equal((await invoke("popup_gallery")).items.length, 0, "Run this test in an isolated native test directory with an empty gallery");
    await invoke("stop_monitoring"); await invoke("resume_reminders");
  }
  await page.getByRole("tab", { name: "提醒", exact: true }).click();
  await page.getByRole("checkbox", { name: "边缘光", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "弹窗", exact: true }).check();
  await page.getByLabel("选择提醒图片").setInputFiles(fixtures);
  await expect(page.locator(".gallery-list li")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "添加图片", exact: false })).toBeEnabled();
  const gallery = native ? await invoke("popup_gallery") : JSON.parse(await page.evaluate(() => localStorage.getItem("moyu-gallery")));
  importedIds.push(...gallery.items.map((image) => image.id));
  await page.getByLabel("图片抽取方式").selectOption("sequential");
  await page.waitForTimeout(500);
  if (native) {
    for (let i = 0; i < gallery.items.length; i++) {
      const bytes = await page.evaluate(async (id) => Array.from(new Uint8Array(await window.__TAURI_INTERNALS__.invoke("popup_image", { id }))), gallery.items[i].id);
      assert.ok(Buffer.from(bytes).equals(fixtures[i].buffer), "Original image bytes must be unchanged");
    }
    await invoke("save_settings", { settings: { ...await invoke("load_settings"), alertMode: "popup", imageSelection: "sequential" } });
    const activate = (active) => invoke("set_alert", { active, intensity: 0.9, width: 70, test: true });
    for (const image of gallery.items) {
      await activate(true);
      await expect.poll(async () => (await invoke("popup_gallery")).selectedId).toBe(image.id);
      const selected = (await invoke("popup_gallery")).selectedId;
      await page.waitForTimeout(600);
      assert.equal((await invoke("popup_gallery")).selectedId, selected, "A continuous alert must retain its image");
      await activate(false); await page.waitForTimeout(450);
    }
    await invoke("save_settings", { settings: { ...await invoke("load_settings"), imageSelection: "random" } });
    const previous = (await invoke("popup_gallery")).selectedId;
    await activate(true);
    await expect.poll(async () => (await invoke("popup_gallery")).selectedId).not.toBe(previous);
    await activate(false); await page.waitForTimeout(500);
  } else {
    await page.getByRole("button", { name: /测试提醒/ }).click();
    await page.locator(".browser-popup").waitFor();
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("moyu-gallery"))).selectedId, gallery.items[0].id);
    await page.waitForTimeout(3400);
    await page.getByRole("button", { name: /测试提醒/ }).click();
    await page.locator(".browser-popup").waitFor();
    assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("moyu-gallery"))).selectedId, gallery.items[1].id);
    await page.waitForTimeout(3400);
  }
  await page.getByRole("button", { name: "上移 ad-3.png", exact: true }).click();
  await expect.poll(() => page.locator(".gallery-preview-button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))).toEqual(["预览 ad-1.png", "预览 ad-3.png", "预览 ad-2.png"]);
  await page.getByRole("button", { name: "删除 ad-2.png", exact: true }).click();
  await expect(page.locator(".gallery-list li")).toHaveCount(2);
  await page.reload();
  await page.getByRole("tab", { name: "提醒", exact: true }).click();
  await expect.poll(() => page.locator(".gallery-preview-button").evaluateAll((buttons) => buttons.map((button) => button.getAttribute("aria-label")))).toEqual(["预览 ad-1.png", "预览 ad-3.png"]);
  await page.screenshot({ path: `test-results/${native ? "native" : "browser"}-gallery.png`, fullPage: true, ...(native ? { mask: [page.locator(".camera-frame")] } : {}) });
  await page.getByRole("tab", { name: "共享", exact: true }).click();
  if (native) {
    const port = 18429;
    const config = { ...savedSharing, enabled: true, port, receiveEnabled: true, accessCode: "test12345678", peers: [] };
    await invoke("save_sharing", { config });
    await expect(page.locator(".sharing-local .connection-state")).toHaveText("共享中");
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/detection`, { signal: AbortSignal.timeout(3000) })).status, 401);
    const exported = await (await fetch(`http://127.0.0.1:${port}/v1/detection`, { headers: { Authorization: "Bearer test12345678" }, signal: AbortSignal.timeout(3000) })).json();
    assert.equal(exported.phase, "idle");
    assert.equal(exported.protocolVersion, 1);
    assert.equal("image" in exported, false);
    peers = [await mockPeer("前门相机"), await mockPeer("后门相机")];
    for (const peer of peers) {
      await page.getByRole("button", { name: "添加设备", exact: true }).click();
      await page.getByLabel("备注名称", { exact: true }).fill(peer.state.deviceName);
      await page.getByLabel("设备地址", { exact: true }).fill(peer.address);
      await page.getByLabel("对方访问码", { exact: true }).fill("12345678");
      await page.getByRole("button", { name: "保存并连接", exact: true }).click();
      await expect(page.locator("dialog")).toHaveCount(0);
    }
    await expect.poll(async () => (await invoke("sharing_state")).peers.filter((peer) => peer.phase === "watching").length).toBe(2);
    peers[0].state.phase = "alert"; peers[0].state.people = 2; peers[0].state.alertEvent++;
    await expect.poll(async () => (await invoke("sharing_state")).activeSources).toContain("前门相机");
    await page.locator(".shared-alert").waitFor();
    assert.equal((await invoke("monitor_state")).phase, "idle", "Remote results must not start local detection");
    const duringRemote = await (await fetch(`http://127.0.0.1:${port}/v1/detection`, { headers: { Authorization: "Bearer test12345678" }, signal: AbortSignal.timeout(3000) })).json();
    assert.equal(duringRemote.phase, "idle", "Remote alerts must not be re-shared");
    await page.waitForTimeout(500);
    const firstImage = (await invoke("popup_gallery")).selectedId;
    await page.waitForTimeout(1500);
    assert.equal((await invoke("popup_gallery")).selectedId, firstImage, "Repeated shared heartbeats must not rotate ads");
    peers[1].state.phase = "alert"; peers[1].state.people = 1; peers[1].state.alertEvent++;
    await expect.poll(async () => (await invoke("sharing_state")).activeSources.length).toBe(2);
    await expect.poll(async () => (await invoke("popup_gallery")).selectedId).not.toBe(firstImage);
    await page.screenshot({ path: "test-results/native-sharing.png", fullPage: true });
    peers[0].server.closeAllConnections(); await new Promise((resolve) => peers[0].server.close(resolve));
    await expect.poll(async () => (await invoke("sharing_state")).peers[0].phase).toBe("offline");
    assert.deepEqual((await invoke("sharing_state")).activeSources, ["后门相机"]);
    peers[1].state.phase = "watching"; peers[1].state.people = 0;
    await expect.poll(async () => (await invoke("sharing_state")).activeSources.length).toBe(0);
    const stored = (await invoke("sharing_state")).config;
    await invoke("save_sharing", { config: { ...stored, peers: stored.peers.map((peer, index) => index === 1 ? { ...peer, accessCode: "invalid-code" } : peer) } });
    await expect.poll(async () => (await invoke("sharing_state")).peers[1].error).toBe("访问码不正确");
    await invoke("save_sharing", { config: { ...stored, enabled: false, receiveEnabled: false } });
    assert.equal((await invoke("sharing_state")).listening, false);
    await expect.poll(async () => fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1500) }).then(() => false).catch(() => true)).toBe(true);
    await writeFile("test-results/sharing-report.json", JSON.stringify({ exported, duringRemote, requests: peers.map((peer) => peer.requests()), errors }, null, 2));
  } else {
    await page.screenshot({ path: "test-results/sharing-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "test-results/sharing-mobile.png", fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole("button", { name: "添加设备", exact: true }).click();
    await page.getByLabel("设备地址", { exact: true }).fill("192.168.1.20:18420");
    await page.getByLabel("对方访问码", { exact: true }).fill("12345678");
    await page.getByRole("button", { name: "保存并连接", exact: true }).click();
    await expect(page.locator("dialog [role=alert]")).toContainText("桌面程序");
    await page.getByRole("button", { name: "关闭设备设置", exact: true }).click();
  }
  assert.deepEqual(errors, []);
  console.log(native ? "PASS: native gallery bytes, sequence/random selection, stable alerts, two shared sources, authentication, offline cleanup, no relay loops, and port release." : "PASS: multiple image upload, sequence selection, reorder, delete, persistence, and desktop/mobile sharing UI.");
} finally {
  for (const peer of peers) { peer.server.closeAllConnections(); peer.server.close(); }
  if (native) {
    if (savedSharing) await invoke("save_sharing", { config: savedSharing }).catch(() => {});
    for (const id of importedIds) await invoke("remove_popup_image", { id }).catch(() => {});
    if (savedSettings) await invoke("save_settings", { settings: savedSettings }).catch(() => {});
    await invoke("set_alert", { active: false, intensity: 0.7, width: 52, test: false }).catch(() => {});
  }
  await browser.close();
}
