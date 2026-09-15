import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";

await mkdir("test-results", { recursive: true });
try {
  await readFile("test-results/person-fixture.jpg");
} catch {
  const response = await fetch(
    "https://raw.githubusercontent.com/ultralytics/assets/main/im/bus.jpg",
  );
  if (!response.ok)
    throw new Error(
      `Could not load the model test fixture: ${response.status}`,
    );
  await writeFile(
    "test-results/person-fixture.jpg",
    Buffer.from(await response.arrayBuffer()),
  );
}
const browser = await chromium.launch({ channel: "msedge", headless: true });
const errors = [];
try {
  const page = await browser.newPage({
    viewport: { width: 940, height: 650 },
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(process.env.MOYU_TEST_URL || "http://127.0.0.1:1420");
  await page.getByRole("button", { name: "开始检测", exact: true }).waitFor();
  await page.screenshot({
    path: "test-results/desktop-idle.png",
    fullPage: true,
  });
  await page.locator('.app-nav button').nth(1).click();
  await page.getByRole("button", { name: /测试提醒/ }).click();
  await page.waitForFunction(() =>
    document.querySelector(".app-shell > .glow-layer")?.classList.contains("active"),
  );
  assert.equal(
    await page
      .locator(".app-shell > .glow-layer")
      .evaluate((el) => getComputedStyle(el).pointerEvents),
    "none",
  );
  await page.waitForFunction(
    () => !document.querySelector(".app-shell > .glow-layer")?.classList.contains("active"),
  );
  await page.getByRole("tab", { name: "摄像头", exact: true }).click();
  const interval = page.getByRole("slider", { name: "检测间隔", exact: true });
  const bounds = await interval.boundingBox();
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.8,
    bounds.y + bounds.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  assert.ok(
    Number(await interval.inputValue()) > 1000,
    "Interval must be draggable",
  );
  await interval.press("Home");
  assert.equal(await interval.inputValue(), "100");
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForFunction(
    () =>
      document.querySelector('input[aria-label="检测间隔"]')?.value === "100",
  );
  assert.equal(await page.locator("h1, h2, h3, h4, footer").count(), 0);
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight,
    ),
    "Default controls must fit the desktop window",
  );
  await page.setViewportSize({ width: 700, height: 500 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: "test-results/compact.png", fullPage: true });
  await page.getByRole("button", { name: "开始检测", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "桌面程序" }).waitFor();
  await page.getByRole("button", { name: "关闭错误提示" }).click();
  await page.getByRole("tab", { name: "提醒", exact: true }).click();
  await page.getByLabel("提醒颜色", { exact: true }).evaluate((input) => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    ).set.call(input, "#00c878");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.getByRole("button", { name: /测试提醒/ }).click();
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector(".app-shell > .glow-layer")).getPropertyValue(
        "--glow-color",
      ) === "0 200 120",
  );
  await page.waitForTimeout(3200);
  await page.getByRole("checkbox", { name: "边缘光", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "弹窗", exact: true }).check();
  assert.equal(await page.getByLabel("关闭后暂停分钟").inputValue(), "3");
  await page
    .getByLabel("选择提醒图片")
    .setInputFiles("test-results/person-fixture.jpg");
  await page.locator(".preview-window .custom img").waitFor();
  await page.getByLabel("关闭后暂停分钟").fill("5");
  await page.getByLabel("关闭后暂停分钟").blur();
  await page.waitForTimeout(500);
  await page.reload();
  await page.getByRole("tab", { name: "提醒", exact: true }).click();
  await page.locator(".preview-window .custom img").waitFor();
  assert.equal(await page.getByLabel("关闭后暂停分钟").inputValue(), "5");
  await page.getByRole("button", { name: /测试提醒/ }).click();
  await page.locator(".browser-popup").waitFor();
  await page
    .getByRole("button", { name: "关闭并暂停提醒", exact: true })
    .click();
  await page.getByRole("button", { name: "恢复提醒", exact: true }).waitFor();
  assert.equal(await page.locator(".browser-popup").count(), 0);
  await page.getByRole("button", { name: "恢复提醒", exact: true }).click();
  await page.waitForTimeout(3200);
  await page.getByRole("button", { name: "恢复默认图片", exact: true }).click();
  await page.locator(".preview-window .default-ad img").waitFor();
  await page.setViewportSize({ width: 940, height: 650 });
  await page.screenshot({
    path: "test-results/reminder-settings.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await page.locator(".app-nav [role=tab]").nth(3).click();
  await page.locator("#about-page").waitFor();
  assert.equal(await page.locator("#about-page .about-version").textContent(), "vbrowser");
  assert((await page.locator("#about-page").textContent()).includes("mchao123"));
  assert.deepEqual(errors, []);
  console.log(
    "PASS: desktop/mobile control layout, red glow preview, persisted detection frequency, and browser-mode error handling.",
  );
} finally {
  await browser.close();
}
