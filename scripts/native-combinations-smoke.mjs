import { chromium, expect } from "@playwright/test";
import { createServer } from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const browser = await chromium.connectOverCDP(process.env.MOYU_CDP_URL || "http://127.0.0.1:9235");
const page = browser.contexts().flatMap((context) => context.pages()).find((page) => !/[?&](overlay|popup)=/.test(page.url()));
const invokeOn = (target, command, args = {}) => target.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args });
const invoke = (command, args = {}) => invokeOn(page, command, args);
const saved = await invoke("load_settings");
const sharing = (await invoke("sharing_state")).config;
const originalCaption = (await invoke("popup_image_state")).caption;
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let visits = 0;
const detection = { protocolVersion: 1, sourceId: crypto.randomUUID(), sessionId: crypto.randomUUID(), deviceName: "Combination test", phase: "watching", people: 0, alertEvent: 0, present: true };
let offline = false;
const server = createServer((request, response) => {
  if (request.url === "/action") {
    visits++;
    response.setHeader("Content-Type", "text/html");
    response.end("<title>Moyu Automation URL Test</title><p>Automation test complete.</p><script>setTimeout(() => window.close(), 500)</script>");
  } else if (request.url === "/v1/detection") {
    if (offline) { response.writeHead(503); response.end("{}"); }
    else { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ ...detection, updatedAt: Date.now() })); }
  } else { response.writeHead(204); response.end(); }
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const address = `http://127.0.0.1:${server.address().port}`;
const inspect = async (target = process.env.MOYU_TEST_PROCESS_ID) => JSON.parse((await promisify(execFile)("powershell.exe", ["-NoProfile", "-File", "scripts/native-window-check.ps1", "-TargetProcessId", target], { encoding: "utf8" })).stdout);
const popups = () => browser.contexts().flatMap((context) => context.pages()).filter((page) => page.url().includes("popup=1"));
const activate = (active) => invoke("set_alert", { active, intensity: 0.9, width: 70, test: true });
let heartbeat;
try {
  await invoke("stop_monitoring"); await invoke("resume_reminders");
  await invoke("save_settings", { settings: { ...saved, alertMode: "mixed", glowColor: "#00e060",
    edgeHoldSeconds: 2,
    popup: { holdSeconds: 8, width: 480, height: 320, opacity: 0.65, position: "top-left", margin: 24 },
    actions: { enabled: true, openUrl: true, url: `${address}/action` } } });
  await invoke("update_image_caption", { id: "", caption: { title: "Native combination", text: "Image caption overlay" } });
  await invoke("prepare_overlays");
  await page.reload();
  await page.getByRole("tab", { name: "提醒", exact: true }).click();
  await expect.poll(() => popups().length).toBeGreaterThan(0);
  const popup = popups()[0];
  await expect(popup.locator(".ad-caption")).toContainText("Native combination");
  await expect(popup.locator(".popup-content")).toHaveCSS("opacity", "0.65");
  await activate(true);
  heartbeat = setInterval(() => void activate(true).catch(() => {}), 500);
  await expect.poll(async () => (await invoke("overlay_state")).active).toBe(true);
  await page.waitForTimeout(1800);
  const geometry = await inspect();
  assert.equal(geometry.windows.filter((window) => window.title === "Moyu Sentinel Alert").length, geometry.screens.length * 2);
  assert.ok(geometry.windows.filter((window) => window.title === "Moyu Sentinel Alert").every((window) => window.visible), "Edge windows are visible alongside popups");
  const popupWindows = geometry.windows.filter((window) => window.title === "Moyu Sentinel Popup");
  assert.equal(popupWindows.length, geometry.screens.length);
  for (const window of popupWindows) {
    assert.ok(window.visible && window.topmost && window.noActivate);
    const screen = geometry.screens.find((screen) => window.x >= screen.workArea.x && window.y >= screen.workArea.y && window.x < screen.workArea.x + screen.workArea.width && window.y < screen.workArea.y + screen.workArea.height);
    assert.ok(screen);
    const scale = window.width / 480;
    assert.ok(Math.abs(window.height - 320 * scale) < 2);
    assert.ok(Math.abs(window.x - screen.workArea.x - 24 * scale) < 2);
    assert.ok(Math.abs(window.y - screen.workArea.y - 24 * scale) < 2);
  }
  assert.equal(visits, 0, "Visual previews must never launch URLs");
  await popup.screenshot({ path: "test-results/native-combined-popup.png" });
  await assert.rejects(invokeOn(popup, "list_target_windows"), /restricted/);
  await assert.rejects(invokeOn(popup, "update_image_caption", { id: "", caption: { title: "", text: "" } }), /restricted/);
  await assert.rejects(invokeOn(popup, "test_actions", { actions: { openUrl: true, url: `${address}/action` } }), /restricted/);
  clearInterval(heartbeat);
  await activate(false);
  const settings = await invoke("load_settings");
  assert.equal(settings.alertMode, "mixed");
  assert.equal(settings.popup.width, 480);
  const targets = await invoke("list_target_windows");
  const fixture = targets.find((target) => target.title === "Moyu Automation Window Fixture");
  assert.ok(fixture, "Launch scripts/automation-window-fixture.ps1 before running the test");
  try {
    await invoke("test_actions", { actions: { focusWindow: true, windowProcess: fixture.process, windowTitle: fixture.title } });
    await expect.poll(async () => {
      const state = await inspect("0");
      return state.windows.find((window) => window.title === fixture.title)?.handle === state.foreground;
    }).toBe(true);
    console.log("PASS: Windows accepted activation of the selected application window.");
  } catch (error) {
    assert.match(String(error), /Windows.*任务栏/);
    console.log("PASS: Windows foreground restriction is reported with taskbar fallback.");
  }
  await assert.rejects(invoke("test_actions", { actions: { focusWindow: true, windowProcess: fixture.process, windowTitle: "nonexistent-fixture-title" } }), /未找到/);
  await assert.rejects(invoke("test_actions", { actions: { openUrl: true, url: "file:///C:/Windows/notepad.exe" } }), /HTTP/);
  await invoke("save_sharing", { config: { ...sharing, enabled: false, receiveEnabled: true,
    peers: [{ id: crypto.randomUUID(), name: "Combination test", address, accessCode: "12345678", enabled: true }] } });
  await expect.poll(async () => (await invoke("sharing_state")).peers[0]?.phase).toBe("watching");
  detection.phase = "alert"; detection.people = 1; detection.alertEvent = 1;
  await expect.poll(() => visits, { timeout: 15000 }).toBe(1);
  await page.waitForTimeout(2500);
  assert.equal(visits, 1, "Persistent detections must execute only once");
  offline = true;
  await expect.poll(async () => (await invoke("sharing_state")).peers[0]?.phase).toBe("offline");
  offline = false;
  await expect.poll(async () => (await invoke("sharing_state")).peers[0]?.phase).toBe("alert");
  await page.waitForTimeout(1500);
  assert.equal(visits, 1, "Reconnection must not replay the same event");
  await invokeOn(popup, "dismiss_popup");
  detection.alertEvent = 2;
  await page.waitForTimeout(1800);
  assert.equal(visits, 1, "Snooze suppresses all actions");
  await assert.rejects(invoke("test_actions", { actions: { openUrl: true, url: `${address}/action` } }), /暂停/);
  await invoke("resume_reminders");
  await page.waitForTimeout(1400);
  assert.equal(visits, 1, "Resume must not replay a snoozed action");
  detection.alertEvent = 3;
  await expect.poll(() => visits, { timeout: 15000 }).toBe(2);
  await invoke("save_settings", { settings: { ...settings, popup: { ...settings.popup, position: "center", width: 420, height: 280 }, actions: { ...settings.actions, enabled: false } } });
  await invoke("update_image_caption", { id: "", caption: { title: "", text: "" } });
  await expect(popup.locator(".ad-caption")).toHaveCount(0);
  await expect(popup.locator("img")).toHaveCount(1);
  detection.alertEvent = 4;
  await page.waitForTimeout(1700);
  assert.equal(visits, 2, "Disabling automation must preserve visual reminders without executing configured actions");
  const centered = await inspect();
  for (const window of centered.windows.filter((window) => window.title === "Moyu Sentinel Popup")) {
    const screen = centered.screens.find((screen) => window.x >= screen.workArea.x && window.y >= screen.workArea.y && window.x < screen.workArea.x + screen.workArea.width && window.y < screen.workArea.y + screen.workArea.height);
    assert.ok(Math.abs(window.x - screen.workArea.x - (screen.workArea.width - window.width) / 2) < 2);
    assert.ok(Math.abs(window.y - screen.workArea.y - (screen.workArea.height - window.height) / 2) < 2);
    assert.ok(Math.abs(window.width / window.height - 420 / 280) < 0.01);
  }
  // The same raw presence signal feeds separate hold clocks in the receiver.
  detection.present = false; detection.phase = "watching"; detection.people = 0;
  await expect.poll(async () => (await invoke("overlay_state")).active, { timeout: 4000 }).toBe(false);
  const held = await inspect();
  assert(held.windows.filter((window) => window.title === "Moyu Sentinel Popup").every((window) => window.visible), "Popup must remain after the shorter edge hold expires");
  await expect.poll(async () => (await inspect()).windows.filter((window) => window.title === "Moyu Sentinel Popup").every((window) => !window.visible), { timeout: 10000 }).toBe(true);
  await invoke("save_settings", { settings: { ...settings, edgeHoldSeconds: 8, popup: { ...settings.popup, holdSeconds: 2 }, actions: { ...settings.actions, enabled: false } } });
  detection.present = true; detection.phase = "alert"; detection.people = 1; detection.alertEvent = 5;
  await expect.poll(async () => (await invoke("overlay_state")).active).toBe(true);
  await page.waitForTimeout(700);
  detection.present = false; detection.phase = "watching"; detection.people = 0;
  await page.waitForTimeout(2500);
  const reverse = await inspect();
  assert(reverse.windows.filter((window) => window.title === "Moyu Sentinel Popup").every((window) => !window.visible), "Popup must end at its own shorter duration");
  assert((await invoke("overlay_state")).active, "Edge light must remain for its independent longer hold");
  assert.deepEqual(errors, []);
  console.log("PASS: native captions and blank removal, mixed visuals, independent holds in both directions, automation master switch, window lookup, real URL execution, deduplication, and snooze.");
} finally {
  clearInterval(heartbeat);
  await invoke("save_sharing", { config: sharing }).catch(() => {});
  await invoke("save_settings", { settings: saved ?? {} }).catch(() => {});
  await invoke("update_image_caption", { id: "", caption: originalCaption }).catch(() => {});
  await invoke("resume_reminders").catch(() => {});
  await activate(false).catch(() => {});
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  await browser.close();
}
