import { chromium, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import sharp from "sharp";

const run = promisify(execFile);
const inspect = async () =>
  JSON.parse(
    (
      await run(
        "powershell.exe",
        ["-NoProfile", "-File", "scripts/native-window-check.ps1"],
        { encoding: "utf8" },
      )
    ).stdout,
  );
const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => !/[?&](overlay|popup)=/.test(page.url()));
const invokeOn = (target, command, args = {}) =>
  target.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );
const invoke = (command, args = {}) => invokeOn(page, command, args);
const bytes = () =>
  page.evaluate(async () =>
    Array.from(
      new Uint8Array(await window.__TAURI_INTERNALS__.invoke("popup_image")),
    ),
  );
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const savedSettings = await invoke("load_settings");
const savedImage = await bytes();
let heartbeat;
const activate = async () => {
  const pulse = () =>
    invoke("set_alert", {
      active: true,
      intensity: 0.9,
      width: 70,
      test: true,
    });
  await pulse();
  heartbeat = setInterval(() => {
    void pulse().catch(() => {});
  }, 500);
  await page.waitForTimeout(600);
};
const deactivate = async () => {
  clearInterval(heartbeat);
  await invoke("set_alert", {
    active: false,
    intensity: 0.9,
    width: 70,
    test: true,
  });
  await page.waitForTimeout(1600);
};
try {
  await invoke("stop_monitoring");
  await invoke("resume_reminders");
  await invoke("save_settings", {
    settings: {
      ...savedSettings,
      alertMode: "edge",
      glowColor: "#00e060",
      snoozeMinutes: 3,
    },
  });
  await page.reload();
  await page.getByRole("button", { name: "开始检测", exact: true }).waitFor();
  await invoke("prepare_overlays");
  const before = await inspect();
  await activate();
  const green = await inspect();
  assert.deepEqual(green.taskbars, before.taskbars);
  assert.equal(green.foreground, before.foreground);
  const greenPixels = green.screens.flatMap((screen, i) =>
    screen.pixels.map(
      (pixel, j) =>
        pixel.g - pixel.r >
        before.screens[i].pixels[j].g - before.screens[i].pixels[j].r + 25,
    ),
  );
  if (process.env.MOYU_SKIP_DESKTOP_PIXELS === "1") {
    console.log("SKIP: desktop pixel capture is unavailable in this Windows session.");
  } else assert.ok(
    greenPixels.filter(Boolean).length >= 3,
    "Configured color must reach actual desktop pixels",
  );
  await deactivate();

  await page.getByRole("tab", { name: "提醒", exact: true }).click();
  await page.getByRole("checkbox", { name: "边缘光", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "弹窗", exact: true }).check();
  await expect
    .poll(async () => (await invoke("load_settings")).alertMode)
    .toBe("popup");
  const fixture = await readFile("test-results/person-fixture.jpg");
  await page.getByLabel("选择提醒图片").setInputFiles({
    name: "custom-ad.jpg",
    mimeType: "image/jpeg",
    buffer: fixture,
  });
  await page.locator(".preview-window .custom img").waitFor();
  const imported = await bytes();
  const metadata = await sharp(Buffer.from(imported)).metadata();
  assert.equal(metadata.format, "jpeg");
  assert.deepEqual(
    Buffer.from(imported),
    fixture,
    "Custom images must be stored byte-for-byte without compression",
  );
  await page.reload();
  assert.deepEqual(
    await bytes(),
    imported,
    "Imported image must survive a control reload",
  );
  const popup = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((page) => page.url().includes("popup=1"));
  assert.ok(popup);
  popup.on("pageerror", (error) => errors.push(error.message));
  await activate();
  await popup.locator(".custom img").waitFor();
  await popup.waitForFunction(
    () => document.querySelector("img")?.naturalWidth > 0,
  );
  const showing = await inspect();
  const popupWindows = showing.windows.filter(
    (window) => window.title === "Moyu Sentinel Popup",
  );
  assert.equal(popupWindows.length, showing.screens.length);
  for (const screen of showing.screens) {
    const area = screen.workArea;
    const window = popupWindows.find(
      (window) =>
        window.x >= area.x &&
        window.y >= area.y &&
        window.x < area.x + area.width &&
        window.y < area.y + area.height,
    );
    assert.ok(window, "Every screen must have a popup");
    assert.ok(
      window.visible &&
        window.topmost &&
        window.noActivate &&
        !window.transparent,
      "Popup must accept clicks without stealing focus",
    );
    assert.ok(window.x >= area.x && window.y >= area.y);
    assert.ok(
      window.x + window.width <= area.x + area.width &&
        window.y + window.height <= area.y + area.height,
    );
    assert.ok(
      area.x + area.width - window.x - window.width < 40 &&
        area.y + area.height - window.y - window.height < 40,
      "Popup must sit at the bottom-right of the work area",
    );
  }
  assert.deepEqual(showing.taskbars, before.taskbars);
  assert.equal(showing.foreground, before.foreground);
  assert.ok(
    showing.windows
      .filter((window) => window.title === "Moyu Sentinel Alert")
      .every((window) => !window.visible),
  );
  await popup.screenshot({ path: "test-results/native-popup-custom.png" });
  const transparentPixels = Buffer.alloc(360 * 250 * 4);
  for (let y = 80; y < 170; y++) {
    for (let x = 100; x < 260; x++) {
      const offset = (y * 360 + x) * 4;
      transparentPixels[offset] = 240;
      transparentPixels[offset + 3] = 255;
    }
  }
  const transparentPng = await sharp(transparentPixels, {
    raw: { width: 360, height: 250, channels: 4 },
  })
    .png()
    .toBuffer();
  await invoke("reset_popup_image");
  await page.getByRole("tab", { name: "提醒", exact: true }).click();
  await page
    .getByLabel("选择提醒图片")
    .setInputFiles({
      name: "transparent.png",
      mimeType: "image/png",
      buffer: transparentPng,
    });
  await expect
    .poll(async () => Buffer.from(await bytes()).equals(transparentPng))
    .toBe(true);
  const popupPages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => page.url().includes("popup=1"));
  assert.equal(popupPages.length, showing.screens.length);
  for (const [index, candidate] of popupPages.entries()) {
    await candidate.waitForFunction(
      () => document.querySelector("img")?.naturalWidth === 360,
    );
    const styles = await candidate.evaluate(() => ({
      backgrounds: [
        document.documentElement,
        document.body,
        document.querySelector("#root"),
        document.querySelector(".popup-card"),
      ].map((element) => getComputedStyle(element).backgroundColor),
      shadow: getComputedStyle(document.querySelector(".popup-close"))
        .boxShadow,
    }));
    assert.ok(
      styles.backgrounds.every((color) => color === "rgba(0, 0, 0, 0)"),
    );
    assert.equal(styles.shadow, "none");
    const screenshot = await candidate.screenshot({
      omitBackground: true,
      path: `test-results/transparent-popup-${index}.png`,
    });
    const { data, info } = await sharp(screenshot)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(
      data[(50 * info.width + 50) * 4 + 3],
      0,
      "Transparent image areas must remain transparent through the webview",
    );
    assert.equal(
      data[
        (Math.floor(info.height / 2) * info.width +
          Math.floor(info.width / 2)) *
          4 +
          3
      ],
      255,
      "Image content must stay visible",
    );
  }
  const raw = Buffer.alloc(80 * 120 * 3);
  for (let pixel = 0; pixel < 80 * 120; pixel++) {
    raw[pixel * 3 + (pixel < 80 * 60 ? 0 : 1)] = 240;
  }
  const gif = await sharp(raw, {
    raw: { width: 80, height: 120, channels: 3, pageHeight: 60 },
  })
    .gif({ loop: 0, delay: [300, 300] })
    .toBuffer();
  assert.equal((await sharp(gif, { animated: true }).metadata()).pages, 2);
  await invoke("reset_popup_image");
  await page.getByRole("tab", { name: "提醒", exact: true }).click();
  await page.getByLabel("选择提醒图片").setInputFiles({
    name: "animated.gif",
    mimeType: "image/gif",
    buffer: gif,
  });
  await expect
    .poll(async () => Buffer.from(await bytes()).equals(gif))
    .toBe(true);
  await popup.waitForFunction(
    () => document.querySelector("img")?.naturalWidth === 80,
  );
  const colors = [];
  for (let frame = 0; frame < 5; frame++) {
    const shot = await popup.screenshot();
    const { data, info } = await sharp(shot)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const offset =
      (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) *
      info.channels;
    colors.push([data[offset], data[offset + 1]]);
    await page.waitForTimeout(170);
  }
  assert.ok(
    colors.some(([r, g]) => r > g + 100) &&
      colors.some(([r, g]) => g > r + 100),
    "GIF must visibly animate in the native popup",
  );
  await popup
    .getByRole("button", { name: "关闭并暂停提醒", exact: true })
    .click();
  const snooze = await invoke("reminder_state");
  assert.ok(
    snooze.snoozeUntil - Date.now() > 175000 &&
      snooze.snoozeUntil - Date.now() <= 180000,
  );
  await page.waitForTimeout(800);
  const dismissed = await inspect();
  assert.ok(
    dismissed.windows
      .filter((window) => window.title === "Moyu Sentinel Popup")
      .every((window) => !window.visible),
    "Closing one popup must hide every screen's popup",
  );
  await page.getByRole("button", { name: "恢复提醒", exact: true }).waitFor();
  await page.getByRole("tab", { name: "提醒", exact: true }).click();
  await page.getByRole("checkbox", { name: "弹窗", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "边缘光", exact: true }).check();
  await page.waitForTimeout(700);
  assert.ok(
    (await inspect()).windows
      .filter((window) => window.title === "Moyu Sentinel Alert")
      .every((window) => !window.visible),
    "Changing modes must not bypass snooze",
  );
  await page.getByRole("button", { name: "恢复提醒", exact: true }).click();
  await page.waitForTimeout(600);
  assert.ok(
    (await inspect()).windows
      .filter((window) => window.title === "Moyu Sentinel Alert")
      .every((window) => window.visible),
    "Explicit resume must restore alerts",
  );
  await deactivate();

  await page.getByRole("checkbox", { name: "边缘光", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "弹窗", exact: true }).check();
  await page.getByLabel("关闭后暂停分钟").fill("1");
  await page.getByRole("button", { name: "恢复默认图片", exact: true }).click();
  await page.locator(".preview-window .default-ad img").waitFor();
  await page.waitForTimeout(500);
  await activate();
  await popup.locator(".default-ad img").waitFor();
  await popup.screenshot({ path: "test-results/native-popup-default.png" });
  await popup
    .getByRole("button", { name: "关闭并暂停提醒", exact: true })
    .click();
  const customSnooze = await invoke("reminder_state");
  assert.ok(
    customSnooze.snoozeUntil - Date.now() > 55000 &&
      customSnooze.snoozeUntil - Date.now() <= 60000,
  );
  await deactivate();
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  await page.locator(".camera-image").waitFor({ timeout: 20000 });
  const start = await invoke("monitor_state");
  await page.waitForTimeout(2500);
  const end = await invoke("monitor_state");
  assert.ok(
    end.inferenceCount > start.inferenceCount,
    "Snooze must leave inference running",
  );
  assert.equal(
    (await inspect()).windows.find(
      (window) => window.title === "Moyu Sentinel Popup",
    ).visible,
    false,
  );
  await page.screenshot({
    path: "test-results/native-reminder-settings.png",
    fullPage: true,
    mask: [page.locator(".camera-frame")],
  });
  assert.deepEqual(errors, []);
  await writeFile(
    "test-results/native-reminders-report.json",
    JSON.stringify(
      {
        before,
        green,
        showing,
        dismissed,
        image: {
          width: metadata.width,
          height: metadata.height,
          bytes: imported.length,
        },
        snooze,
        customSnooze,
        inferencesWhilePaused: end.inferenceCount - start.inferenceCount,
        errors,
        desktopPixelsChecked: process.env.MOYU_SKIP_DESKTOP_PIXELS !== "1",
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: native edge color, popup work-area position, custom image import, clickable close, configurable global snooze, resume, and inference during snooze.",
  );
} finally {
  clearInterval(heartbeat);
  await invoke("stop_monitoring").catch(() => {});
  await deactivate().catch(() => {});
  await invoke("resume_reminders");
  if (savedImage.length)
    await page.evaluate(
      (bytes) =>
        window.__TAURI_INTERNALS__.invoke(
          "import_popup_image",
          new Uint8Array(bytes).buffer,
        ),
      savedImage,
    );
  else await invoke("reset_popup_image");
  if (savedSettings) await invoke("save_settings", { settings: savedSettings });
  await page.reload();
  await browser.close();
}
