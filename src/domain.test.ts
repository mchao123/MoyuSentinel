import { expect, it } from "vitest";
import { defaults, hasEdge, hasPopup, normalizeSettings, popupWindowSize, regionBounds, validWebUrl, withReminder } from "./domain";

it("migrates saved settings to low-frequency native detection", () => {
  expect(normalizeSettings({ minPeople: 2, confidence: 0.6 })).toMatchObject({
    minPeople: 2,
    confidence: 0.6,
    detectionIntervalMs: 500,
  });
});
it("combines independent reminders and preserves legacy modes", () => {
  expect(withReminder(defaults, "popup", true)).toBe("mixed");
  const mixed = normalizeSettings({ alertMode: "mixed" });
  expect(hasEdge(mixed) && hasPopup(mixed)).toBe(true);
  expect(withReminder(mixed, "edge", false)).toBe("popup");
  expect(withReminder(mixed, "popup", false)).toBe("edge");
  expect(withReminder(normalizeSettings({ alertMode: "popup" }), "popup", false)).toBe("none");
  expect(normalizeSettings({ alertMode: "popup", holdSeconds: 6 }).popup.holdSeconds).toBe(6);
  expect(normalizeSettings({ alertMode: "none" }).alertMode).toBe("none");
});
it("keeps independent hold durations and the automation master switch", () => {
  const settings = normalizeSettings({ holdSeconds: 6, edgeHoldSeconds: 2, popup: { holdSeconds: 9 }, actions: { enabled: false, openUrl: true } });
  expect(settings.edgeHoldSeconds).toBe(2);
  expect(settings.popup.holdSeconds).toBe(9);
  expect(settings.actions.enabled).toBe(false);
  expect(normalizeSettings({ holdSeconds: 6 }).edgeHoldSeconds).toBe(6);
  expect(normalizeSettings({ actions: { openUrl: true } }).actions.enabled).toBe(true);
});
it("normalizes custom popup limits and leaves automatic actions opt-in", () => {
  expect(normalizeSettings({ popup: { width: 9999, height: 0, opacity: NaN, textColor: "url(bad)", position: "bad", fontSize: 80 } }).popup).toMatchObject({
    width: 1200, height: 120, opacity: 1, textColor: "#32353b", position: "bottom-right", fontSize: 48,
  });
  expect(normalizeSettings({}).actions).toMatchObject({ openUrl: false, focusWindow: false });
  expect(normalizeSettings({ actions: { openUrl: "true", focusWindow: true, windowTitle: " Report " } }).actions).toMatchObject({ openUrl: false, focusWindow: true, windowTitle: "Report" });
});
it("fits popup windows to the image ratio only when enabled", () => {
  const options = { ...defaults.popup, width: 360, height: 250 };
  expect(popupWindowSize(options, { width: 4000, height: 2000 })).toEqual({ width: 360, height: 250 });
  const fitted = { ...options, fitImage: true };
  expect(popupWindowSize(fitted, { width: 4000, height: 2000 })).toEqual({ width: 360, height: 180 });
  expect(popupWindowSize(fitted, { width: 1000, height: 4000 })).toEqual({ width: 63, height: 250 });
});
it("accepts web addresses without allowing local programs or script URLs", () => {
  expect(validWebUrl("https://example.com/?q=a&b=2")).toBe(true);
  for (const url of ["file:///C:/test.exe", "javascript:alert(1)", "https://user:pass@example.com", "https://example.com/\0", "example.com", ""]) expect(validWebUrl(url)).toBe(false);
});
it("bounds invalid settings and recovers corrupted values", () => {
  expect(
    normalizeSettings({
      intensity: 90,
      region: "bad",
      confidence: NaN,
      detectionIntervalMs: 0,
    }),
  ).toMatchObject({
    intensity: 1,
    region: "full",
    confidence: 0.55,
    detectionIntervalMs: 100,
  });
});
it("uses normalized bounds for the preview mask", () => {
  expect(regionBounds("right")).toEqual([0.5, 1]);
  expect(regionBounds("center")).toEqual([0.25, 0.75]);
});
it("migrates reminder options and bounds imported values", () => {
  expect(normalizeSettings({})).toMatchObject({
    alertMode: "edge",
    glowColor: "#ff1930",
    snoozeMinutes: 3,
  });
  expect(
    normalizeSettings({
      alertMode: "popup",
      glowColor: "#00FF80",
      snoozeMinutes: 90,
    }),
  ).toMatchObject({
    alertMode: "popup",
    glowColor: "#00ff80",
    snoozeMinutes: 60,
  });
  expect(
    normalizeSettings({ glowColor: "url(bad)", snoozeMinutes: 0 }),
  ).toMatchObject({ glowColor: "#ff1930", snoozeMinutes: 1 });
});
