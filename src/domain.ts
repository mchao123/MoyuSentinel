export type Region = "full" | "left" | "right" | "center";
export interface PopupOptions {
  holdSeconds: number;
  width: number;
  height: number;
  opacity: number;
  position: "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
  margin: number;
  fontSize: number;
  textColor: string;
  backgroundColor: string;
}
export interface AlertActions {
  enabled: boolean;
  openUrl: boolean;
  url: string;
  focusWindow: boolean;
  windowProcess: string;
  windowTitle: string;
}
export const popupDefaults: PopupOptions = {
  holdSeconds: 3, width: 360, height: 250,
  opacity: 1, position: "bottom-right", margin: 12, fontSize: 15,
  textColor: "#32353b", backgroundColor: "#ffffff",
};
export const actionDefaults: AlertActions = {
  enabled: false, openUrl: false, url: "", focusWindow: false, windowProcess: "", windowTitle: "",
};
export const hasEdge = (settings: Settings) => ["edge", "mixed"].includes(settings.alertMode);
export const hasPopup = (settings: Settings) => ["popup", "mixed"].includes(settings.alertMode);
export function withReminder(settings: Settings, kind: "edge" | "popup", enabled: boolean): Settings["alertMode"] {
  const edge = kind === "edge" ? enabled : hasEdge(settings);
  const popup = kind === "popup" ? enabled : hasPopup(settings);
  return edge ? (popup ? "mixed" : "edge") : (popup ? "popup" : "none");
}
export function validWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return value.length <= 2048 && !/[\x00-\x20]/.test(value) && ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
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
  edgeHoldSeconds: number;
  intensity: number;
  edgeWidth: number;
  region: Region;
  minPeople: number;
  detectionIntervalMs: number;
  alertMode: "edge" | "popup" | "mixed" | "none";
  glowColor: string;
  snoozeMinutes: number;
  imageSelection: "random" | "sequential";
  popup: PopupOptions;
  actions: AlertActions;
}
export const defaults: Settings = {
  deviceId: "",
  confidence: 0.55,
  holdSeconds: 3,
  edgeHoldSeconds: 3,
  intensity: 0.72,
  edgeWidth: 52,
  region: "full",
  minPeople: 1,
  detectionIntervalMs: 500,
  alertMode: "edge",
  glowColor: "#ff1930",
  snoozeMinutes: 3,
  imageSelection: "random",
  popup: popupDefaults,
  actions: actionDefaults,
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
    edgeHoldSeconds: v.edgeHoldSeconds === undefined ? number("holdSeconds", 1, 10) : number("edgeHoldSeconds", 1, 10),
    intensity: number("intensity", 0.2, 1),
    edgeWidth: number("edgeWidth", 16, 100),
    region: ["full", "left", "right", "center"].includes(v.region ?? "")
      ? v.region!
      : "full",
    minPeople: Math.round(number("minPeople", 1, 5)),
    detectionIntervalMs: Math.round(number("detectionIntervalMs", 100, 2000)),
    alertMode: ["edge", "popup", "mixed", "none"].includes(v.alertMode ?? "") ? v.alertMode! : "edge",
    glowColor:
      typeof v.glowColor === "string" && /^#[0-9a-f]{6}$/i.test(v.glowColor)
        ? v.glowColor.toLowerCase()
        : defaults.glowColor,
    snoozeMinutes: Math.round(number("snoozeMinutes", 1, 60)),
    imageSelection: v.imageSelection === "sequential" ? "sequential" : "random",
    popup: normalizePopup(v.popup, number("holdSeconds", 1, 10)),
    actions: normalizeActions(v.actions),
  };
}
function normalizePopup(value: unknown, legacyHold: number): PopupOptions {
  const v = value && typeof value === "object" ? value as Partial<PopupOptions> : {};
  const bounded = (key: "width" | "height" | "opacity" | "margin" | "fontSize" | "holdSeconds", min: number, max: number) =>
    typeof v[key] === "number" && Number.isFinite(v[key]) ? Math.max(min, Math.min(max, v[key]!)) : popupDefaults[key];
  const color = (value: unknown, fallback: string) => typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : fallback;
  return {
    holdSeconds: v.holdSeconds === undefined ? legacyHold : bounded("holdSeconds", 1, 10),
    width: Math.round(bounded("width", 180, 1200)), height: Math.round(bounded("height", 120, 900)),
    opacity: bounded("opacity", 0.2, 1), margin: Math.round(bounded("margin", 0, 200)),
    fontSize: Math.round(bounded("fontSize", 12, 48)),
    position: ["top-left", "top-right", "bottom-left", "bottom-right", "center"].includes(v.position ?? "") ? v.position! : "bottom-right",
    textColor: color(v.textColor, popupDefaults.textColor), backgroundColor: color(v.backgroundColor, popupDefaults.backgroundColor),
  };
}
function normalizeActions(value: unknown): AlertActions {
  const v = value && typeof value === "object" ? value as Partial<AlertActions> : {};
  return {
    enabled: typeof v.enabled === "boolean" ? v.enabled : v.openUrl === true || v.focusWindow === true,
    openUrl: v.openUrl === true, url: typeof v.url === "string" ? v.url.trim().slice(0, 2048) : "",
    focusWindow: v.focusWindow === true,
    windowProcess: typeof v.windowProcess === "string" ? v.windowProcess.slice(0, 32768) : "",
    windowTitle: typeof v.windowTitle === "string" ? v.windowTitle.trim().slice(0, 512) : "",
  };
}
