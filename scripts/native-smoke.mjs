import { chromium } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import sharp from "sharp";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const run = promisify(execFile);
const inspectWindows = async (show = false, close = false) =>
  JSON.parse(
    (
      await run(
        "powershell.exe",
        [
          "-NoProfile",
          "-File",
          "scripts/native-window-check.ps1",
          ...(show ? ["-ShowMain"] : []),
          ...(close ? ["-CloseMain"] : []),
        ],
        { encoding: "utf8" },
      )
    ).stdout,
  );
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
await mkdir("test-results", { recursive: true });
const pages = browser.contexts().flatMap((context) => context.pages());
const page = pages.find(
  (candidate) =>
    !candidate.url().includes("overlay") && !candidate.url().includes("popup"),
);
assert.ok(page, "The desktop control window must be available");
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const invoke = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const setIntervalMs = async (value) => {
  const slider = page.getByRole("slider", { name: "检测间隔", exact: true });
  await slider.press("Home");
  for (let interval = 100; interval < value; interval += 50) {
    await slider.press("ArrowRight");
  }
  assert.equal(await slider.inputValue(), String(value));
  await page.waitForTimeout(500);
};
let savedSettings;
try {
  await page.getByRole("tab", { name: "摄像头", exact: true }).click();
  await page.getByRole("button", { name: "开始检测", exact: true }).waitFor();
  savedSettings = await invoke("load_settings");
  await invoke("save_settings", {
    settings: { ...savedSettings, alertMode: "edge", glowColor: "#ff1930" },
  });
  await page.reload();
  await setIntervalMs(500);
  assert.equal(await page.locator(".browser-badge").count(), 0);
  await page.locator(".camera-image").waitFor({ timeout: 15000 });
  const previewOnlyStart = await invoke("monitor_state");
  await page.waitForTimeout(1500);
  const previewOnlyEnd = await invoke("monitor_state");
  assert.equal(previewOnlyEnd.phase, "idle");
  assert.equal(previewOnlyEnd.inferenceCount, 0);
  assert.equal(previewOnlyEnd.alertEvent, previewOnlyStart.alertEvent);
  assert.ok(previewOnlyEnd.previewCount > previewOnlyStart.previewCount);
  const cameraSelect = page.getByRole("combobox", { name: "摄像头", exact: true });
  assert.equal(await cameraSelect.isEnabled(), true);
  const originalCamera = await cameraSelect.inputValue();
  const cameras = await invoke("list_cameras");
  const alternate = cameras.find((camera) => camera.deviceId !== originalCamera);
  if (alternate) {
    await cameraSelect.selectOption(alternate.deviceId);
    await page.locator(".camera-image").waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    assert.equal((await invoke("monitor_state")).inferenceCount, 0);
    await cameraSelect.selectOption(originalCamera);
    await page.locator(".camera-image").waitFor({ timeout: 15000 });
    assert.equal((await invoke("monitor_state")).phase, "idle");
  }
  await page.screenshot({
    path: "test-results/native-idle.png",
    fullPage: true,
    mask: [page.locator(".camera-frame")],
  });
  await invoke("prepare_overlays");
  const before = await inspectWindows();
  await invoke("set_alert", {
    active: true,
    intensity: 0.9,
    width: 70,
    test: true,
  });
  const heartbeat = setInterval(() => {
    void invoke("set_alert", {
      active: true,
      intensity: 0.9,
      width: 70,
      test: true,
    });
  }, 500);
  await page.waitForTimeout(700);
  let during;
  try {
    during = await inspectWindows();
  } finally {
    clearInterval(heartbeat);
  }
  const overlays = during.windows.filter(
    (window) => window.title === "Moyu Sentinel Alert",
  );
  assert.equal(overlays.length, during.screens.length * 2);
  for (const overlay of overlays) {
    assert.equal(overlay.visible, true, "Alert overlay must be visible");
    assert.equal(overlay.topmost, true, "Alert overlay must be topmost");
    assert.equal(
      overlay.transparent,
      true,
      "Alert overlay must pass mouse events through",
    );
    assert.equal(
      overlay.noActivate,
      true,
      "Alert overlay must not accept focus",
    );
    assert.ok(
      during.screens.some(
        (screen) =>
          overlay.x === screen.x &&
          overlay.width === screen.width &&
          overlay.height < screen.height &&
          overlay.y >= screen.y &&
          overlay.y + overlay.height <= screen.y + screen.height,
      ),
      "Every overlay must stay within its monitor without becoming fullscreen",
    );
  }
  for (const screen of during.screens) {
    const halves = overlays
      .filter(
        (overlay) =>
          overlay.x === screen.x &&
          overlay.width === screen.width &&
          overlay.y >= screen.y &&
          overlay.y < screen.y + screen.height,
      )
      .sort((a, b) => a.y - b.y);
    assert.equal(halves.length, 2);
    assert.equal(halves[0].y, screen.y);
    assert.equal(halves[0].y + halves[0].height, halves[1].y);
    assert.equal(halves[1].y + halves[1].height, screen.y + screen.height);
  }
  assert.ok(before.taskbars.length > 0);
  assert.deepEqual(
    during.taskbars,
    before.taskbars,
    "Glow must preserve taskbar visibility, position and topmost state",
  );
  assert.equal(
    during.foreground,
    before.foreground,
    "Showing the glow must not steal focus",
  );
  const changed = during.screens.flatMap((screen, i) =>
    screen.pixels.map((pixel, j) => {
      const old = before.screens[i].pixels[j];
      return pixel.r - pixel.g > old.r - old.g + 25;
    }),
  );
  if (process.env.MOYU_SKIP_DESKTOP_PIXELS === "1") {
    console.log("SKIP: desktop pixel capture is unavailable in this Windows session.");
  } else assert.ok(
    changed.filter(Boolean).length >= 3,
    "Native desktop pixels must become red along the edges",
  );
  await page.waitForTimeout(5000);
  const after = await inspectWindows();
  assert.ok(
    after.windows
      .filter((window) => window.title === "Moyu Sentinel Alert")
      .every((window) => !window.visible),
    "The native alert lease must expire",
  );

  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new Error("The frontend must not capture the camera");
    };
  });
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector(
        ".status-badge.watching, .status-badge.alert, .error-banner",
      ),
    undefined,
    { timeout: 30000 },
  );
  assert.equal(
    await page.locator(".error-banner").count(),
    0,
    await page.locator(".error-banner").allTextContents(),
  );
  await page.locator(".camera-image").waitFor({ timeout: 10000 });
  const sample = await page.evaluate(async () =>
    Array.from(
      new Uint8Array(await window.__TAURI_INTERNALS__.invoke("preview_frame")),
    ),
  );
  const jpeg = await sharp(Buffer.from(sample)).metadata();
  assert.equal(jpeg.format, "jpeg");
  assert.ok(jpeg.width <= 640 && jpeg.height <= 480);
  assert.ok(
    sample.length < (jpeg.width * jpeg.height * 3) / 3,
    "Preview must be compressed",
  );
  const activeStart = await invoke("monitor_state");
  await page.waitForTimeout(3500);
  const activeEnd = await invoke("monitor_state");
  assert.ok(activeEnd.inferenceCount - activeStart.inferenceCount >= 3);
  assert.ok(
    activeEnd.inferenceCount - activeStart.inferenceCount <= 8,
    "Default inference must stay at or below 2 Hz",
  );
  assert.ok(
    activeEnd.previewCount - activeStart.previewCount >= 15,
    "Preview updates independently of low-frequency inference",
  );
  await page.screenshot({
    path: "test-results/native-detection.png",
    fullPage: true,
    mask: [page.locator(".camera-frame")],
  });
  await setIntervalMs(100);
  await page.waitForTimeout(1000);
  const fastStart = await invoke("monitor_state");
  await page.waitForTimeout(2000);
  const fastEnd = await invoke("monitor_state");
  assert.ok(
    fastEnd.inferenceCount - fastStart.inferenceCount >= 10,
    "100 ms interval must reach the Rust worker",
  );
  assert.ok(
    fastEnd.inferenceCount - fastStart.inferenceCount <= 21,
    "Inference must respect the minimum interval",
  );
  await setIntervalMs(1000);
  await page.waitForTimeout(1500);
  const lowStart = await invoke("monitor_state");
  await page.waitForTimeout(3500);
  const lowEnd = await invoke("monitor_state");
  assert.ok(
    lowEnd.inferenceCount - lowStart.inferenceCount >= 2 &&
      lowEnd.inferenceCount - lowStart.inferenceCount <= 4,
    `Frequency settings must control the Rust worker: ${lowEnd.inferenceCount - lowStart.inferenceCount} inferences; settings ${JSON.stringify(await invoke("load_settings"))}`,
  );
  await page.getByRole("button", { name: "隐藏预览", exact: true }).click();
  await page.waitForTimeout(1000);
  const hiddenStart = await invoke("monitor_state");
  await page.waitForTimeout(2500);
  const hiddenEnd = await invoke("monitor_state");
  assert.equal(
    hiddenEnd.previewCount,
    hiddenStart.previewCount,
    "Hiding preview must stop JPEG encoding",
  );
  assert.ok(hiddenEnd.inferenceCount > hiddenStart.inferenceCount);
  await page.getByRole("button", { name: "显示预览", exact: true }).click();
  await inspectWindows(false, true);
  await page.waitForTimeout(1200);
  const trayStart = await invoke("monitor_state");
  await page.waitForTimeout(4000);
  const trayEnd = await invoke("monitor_state");
  const background = await inspectWindows();
  assert.equal(
    background.windows.find((window) =>
      window.title.startsWith("Moyu Sentinel -"),
    ).visible,
    false,
  );
  assert.equal(trayEnd.previewCount, trayStart.previewCount);
  assert.ok(
    trayEnd.inferenceCount > trayStart.inferenceCount,
    "Rust inference must continue with the control window hidden",
  );
  await inspectWindows(true);
  await page.locator(".camera-image").waitFor();
  await setIntervalMs(500);
  await page.getByRole("button", { name: "停止检测", exact: true }).click();
  await page.waitForTimeout(1000);
  assert.equal((await invoke("monitor_state")).phase, "idle");
  await page.locator(".camera-image").waitFor();
  const stoppedStart = await invoke("monitor_state");
  await page.waitForTimeout(1200);
  const stoppedEnd = await invoke("monitor_state");
  assert.equal(stoppedEnd.inferenceCount, stoppedStart.inferenceCount);
  assert.equal(stoppedEnd.alertEvent, stoppedStart.alertEvent);
  assert.ok(stoppedEnd.previewCount > stoppedStart.previewCount);
  await page.getByRole("button", { name: "隐藏预览", exact: true }).click();
  await page.waitForTimeout(1000);
  const idleHiddenStart = await invoke("monitor_state");
  await page.waitForTimeout(1000);
  const idleHiddenEnd = await invoke("monitor_state");
  assert.equal(idleHiddenEnd.previewCount, idleHiddenStart.previewCount);
  assert.equal(await page.locator(".camera-image").count(), 0);
  await page.getByRole("button", { name: "显示预览", exact: true }).click();
  await page.locator(".camera-image").waitFor({ timeout: 15000 });
  assert.ok(
    (await inspectWindows()).windows
      .filter((window) => window.title === "Moyu Sentinel Alert")
      .every((window) => !window.visible),
  );
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  await page.locator(".camera-image").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "停止检测", exact: true }).click();
  assert.deepEqual(errors, []);
  await writeFile(
    "test-results/native-report.json",
    JSON.stringify(
      {
        before,
        during,
        after,
        background,
        previewOnlyStart,
        previewOnlyEnd,
        stoppedStart,
        stoppedEnd,
        idleHiddenStart,
        idleHiddenEnd,
        jpeg: { width: jpeg.width, height: jpeg.height, bytes: sample.length },
        activeStart,
        activeEnd,
        fastStart,
        fastEnd,
        lowStart,
        lowEnd,
        hiddenStart,
        hiddenEnd,
        trayStart,
        trayEnd,
        errors,
        desktopPixelsChecked: process.env.MOYU_SKIP_DESKTOP_PIXELS !== "1",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: preview before detection, camera selection, preview after stopping detection, native inference, JPEG preview, low-frequency settings, hidden preview, tray detection, camera restart, and desktop overlays.",
  );
} finally {
  await invoke("stop_monitoring").catch(() => {});
  await invoke("set_alert", {
    active: false,
    intensity: 0.7,
    width: 52,
    test: false,
  }).catch(() => {});
  if (savedSettings) {
    await invoke("save_settings", { settings: savedSettings });
    await page.reload();
  }
  await browser.close();
}
