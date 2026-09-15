import { expect, it } from "vitest";
import { normalizeSettings, regionBounds } from "./domain";

it("migrates saved settings to low-frequency native detection", () => {
  expect(normalizeSettings({ minPeople: 2, confidence: 0.6 })).toMatchObject({
    minPeople: 2,
    confidence: 0.6,
    detectionIntervalMs: 500,
  });
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
