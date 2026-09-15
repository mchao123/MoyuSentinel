import { chromium, expect } from "@playwright/test";
import sharp from "sharp";
import assert from "node:assert/strict";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const base = process.env.MOYU_TEST_URL || "http://127.0.0.1:1421";
try {
  const context = await browser.newContext({ viewport: { width: 940, height: 650 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(base);
  await expect(page.locator(".test-button")).toHaveCount(0);
  await page.getByRole("tab", { name: "提醒", exact: true }).click();
  await page.getByRole("button", { name: "图片弹窗", exact: true }).click();
  const dimensions = () => page.evaluate(() => {
    const box = (selector) => {
      const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height };
    };
    return { preview: box(".preview-window"), controls: box(".mode-switch"), stage: box(".reminder-preview-stage"),
      button: box(".test-button"), media: box(".reminder-media"),
      pageHeight: document.documentElement.scrollHeight, pageWidth: document.documentElement.scrollWidth,
      listHeight: document.querySelector(".gallery-list")?.clientHeight };
  });
  await page.waitForTimeout(200);
  const empty = await dimensions();
  const files = await Promise.all(Array.from({ length: 32 }, async (_, index) => ({
    name: `advertisement-${index + 1}.png`, mimeType: "image/png",
    buffer: await sharp({ create: { width: 360, height: 250, channels: 4, background: index % 2 ? "#218c77" : "#f05065" } }).png().toBuffer(),
  })));
  await page.locator('input[type="file"]').setInputFiles(files);
  await expect(page.locator(".gallery-list li")).toHaveCount(32);
  const populated = await dimensions();
  assert.deepEqual(populated, empty, "Importing images must not change any layout dimensions");
  for (const viewport of [{ width: 940, height: 650 }, { width: 700, height: 500 }, { width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(180);
    const popup = await dimensions();
    assert.equal(popup.pageHeight, viewport.height, "No document vertical scroll");
    assert.equal(popup.pageWidth, viewport.width, "No document horizontal scroll");
    assert(Math.abs(popup.preview.width / popup.preview.height - 360 / 250) < 0.001, "Exact popup aspect ratio");
    if (viewport.width >= 621) assert(Math.abs(popup.preview.y - popup.controls.y) <= 1.1, "Preview and controls align at the top");
    assert(popup.button.y + popup.button.height < viewport.height, "Test button stays visible");
    const list = page.locator(".gallery-list");
    assert(await list.evaluate((el) => el.scrollHeight > el.clientHeight), "Image list scrolls internally");
    await list.hover();
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(200);
    await expect(list.locator("li").last()).toBeInViewport();
    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => scrollY), 0, "Wheel at list boundary must not scroll the page");
    await page.screenshot({ path: `test-results/reminder-popup-${viewport.width}.png` });
    await page.getByRole("button", { name: "边缘光", exact: true }).click();
    await page.waitForTimeout(500);
    const edge = await dimensions();
    assert.deepEqual(edge.media, popup.media, "Both modes reserve the same media area");
    assert.deepEqual(edge.button, popup.button, "Mode changes must not move the test button");
    assert.equal(edge.pageHeight, viewport.height);
    const screenRatio = await page.evaluate(() => screen.width / screen.height);
    assert(Math.abs(edge.preview.width / edge.preview.height - screenRatio) < 0.001);
    await page.getByLabel("提醒颜色", { exact: true }).fill("#00e060");
    await page.getByRole("slider", { name: "边缘宽度", exact: true }).fill("100");
    await page.getByRole("slider", { name: "边缘光强度", exact: true }).fill("1");
    const pixels = await sharp(await page.locator(".preview-window").screenshot()).removeAlpha().raw().toBuffer();
    let green = 0;
    for (let i = 0; i < pixels.length; i += 3) if (pixels[i + 1] > pixels[i] + 25 && pixels[i + 1] > pixels[i + 2] + 25) green++;
    assert(green > 20, "Edge preview renders the selected color");
    await page.screenshot({ path: `test-results/reminder-edge-${viewport.width}.png` });
    await page.getByRole("button", { name: "图片弹窗", exact: true }).click();
  }
  // Compare the scaled preview with the real popup page for both captioned and
  // portrait images. Transparent margins must match the real renderer as well.
  await page.setViewportSize({ width: 940, height: 650 });
  await page.getByRole("button", { name: "恢复默认图片", exact: true }).click();
  const reference = await page.context().newPage();
  await reference.setViewportSize({ width: 360, height: 250 });
  for (const portrait of [false, true]) {
    if (portrait) await page.locator('input[type="file"]').setInputFiles({
      name: "portrait.png", mimeType: "image/png",
      buffer: await sharp({ create: { width: 120, height: 250, channels: 4, background: "#dc4050" } }).png().toBuffer(),
    });
    await reference.goto(`${base}/?popup=1`);
    await reference.evaluate(() => { document.body.style.background = "#eef1f4"; });
    await page.waitForTimeout(450);
    await reference.waitForTimeout(450);
    const sample = await page.locator(".preview-window").screenshot();
    const { width, height } = await sharp(sample).metadata();
    const actual = await sharp(sample).removeAlpha().raw().toBuffer();
    const expected = await sharp(await reference.screenshot()).resize(width, height).removeAlpha().raw().toBuffer();
    let difference = 0;
    for (let i = 0; i < actual.length; i++) difference += Math.abs(actual[i] - expected[i]);
    assert(difference / actual.length < 8, `Preview must match popup pixels: ${difference / actual.length}`);
  }
  assert.deepEqual(errors, []);
  console.log("PASS: exact popup and screen ratios, real popup pixel comparison, live edge settings, aligned stable modes, 32-image isolated scrolling, and visible test button at four viewport sizes.");
} finally { await browser.close(); }
