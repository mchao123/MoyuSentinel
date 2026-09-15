export type Region = "full" | "left" | "right" | "center";
export interface Person {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}
export interface Settings {
  deviceId: string;
  confidence: number;
  holdSeconds: number;
  intensity: number;
  edgeWidth: number;
  region: Region;
  minPeople: number;
  detectionIntervalMs: number;
  alertMode: "edge" | "popup";
  glowColor: string;
  snoozeMinutes: number;
  imageSelection: "random" | "sequential";
}
export const defaults: Settings = {
  deviceId: "",
  confidence: 0.55,
  holdSeconds: 3,
  intensity: 0.72,
  edgeWidth: 52,
  region: "full",
  minPeople: 1,
  detectionIntervalMs: 500,
  alertMode: "edge",
  glowColor: "#ff1930",
  snoozeMinutes: 3,
  imageSelection: "random",
};
export function regionBounds(region: Region): [number, number] {
  return region === "left"
    ? [0, 0.5]
    : region === "right"
      ? [0.5, 1]
      : region === "center"
        ? [0.25, 0.75]
        : [0, 1];
}
export function normalizeSettings(value: unknown): Settings {
  const v =
    value && typeof value === "object" ? (value as Partial<Settings>) : {};
  const number = (key: keyof Settings, min: number, max: number) =>
    typeof v[key] === "number" && Number.isFinite(v[key])
      ? Math.max(min, Math.min(max, v[key] as number))
      : (defaults[key] as number);
  return {
    deviceId: typeof v.deviceId === "string" ? v.deviceId : "",
    confidence: number("confidence", 0.3, 0.9),
    holdSeconds: number("holdSeconds", 1, 10),
    intensity: number("intensity", 0.2, 1),
    edgeWidth: number("edgeWidth", 16, 100),
    region: ["full", "left", "right", "center"].includes(v.region ?? "")
      ? v.region!
      : "full",
    minPeople: Math.round(number("minPeople", 1, 5)),
    detectionIntervalMs: Math.round(number("detectionIntervalMs", 100, 2000)),
    alertMode: v.alertMode === "popup" ? "popup" : "edge",
    glowColor:
      typeof v.glowColor === "string" && /^#[0-9a-f]{6}$/i.test(v.glowColor)
        ? v.glowColor.toLowerCase()
        : defaults.glowColor,
    snoozeMinutes: Math.round(number("snoozeMinutes", 1, 60)),
    imageSelection: v.imageSelection === "sequential" ? "sequential" : "random",
  };
}
