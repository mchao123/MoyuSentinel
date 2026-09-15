import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { hasPopup, type Settings, type AlertActions } from "./domain";
import type { Person } from "./domain";
import { chooseGalleryImage, clearGallery, currentGalleryImage, replaceGalleryImage } from "./gallery";

export interface CameraDevice {
  deviceId: string;
  label: string;
}
export interface MonitorState {
  phase: "idle" | "loading" | "watching" | "alert";
  error: string | null;
  people: Person[];
  latency: number;
  width: number;
  height: number;
  cameraFps: number;
  inferenceCount: number;
  previewCount: number;
  previewBytes: number;
  alertEvent: number;
  alertPeople: number;
  alertAt: number;
}
export const idleState: MonitorState = {
  phase: "idle",
  error: null,
  people: [],
  latency: 0,
  width: 0,
  height: 0,
  cameraFps: 0,
  inferenceCount: 0,
  previewCount: 0,
  previewBytes: 0,
  alertEvent: 0,
  alertPeople: 0,
  alertAt: 0,
};
export async function listCameras(): Promise<CameraDevice[]> {
  return native ? invoke("list_cameras") : [];
}
export async function startMonitoring(settings: Settings) {
  if (!native)
    throw new Error("摄像头检测需要在 Moyu Sentinel 桌面程序中启动。");
  await invoke("start_monitoring", { settings });
}
export async function stopMonitoring() {
  if (native) await invoke("stop_monitoring");
}
export async function monitorState(): Promise<MonitorState> {
  return native ? invoke("monitor_state") : idleState;
}
export async function previewFrame(deviceId: string, restart = false): Promise<ArrayBuffer> {
  return native ? invoke("preview_frame", { deviceId, restart }) : new ArrayBuffer(0);
}

export const native = isTauri();
export interface Glow {
  active: boolean;
  intensity: number;
  width: number;
  color?: string;
}
export async function setGlow(
  active: boolean,
  settings: Settings,
  test = false,
) {
  const glow = {
    active,
    intensity: settings.intensity,
    width: settings.edgeWidth,
    color: settings.glowColor,
  };
  if (native) {
    if (test) await saveSettings(settings);
    await invoke("set_alert", { ...glow, test });
  } else {
    if (active && hasPopup(settings)) await chooseGalleryImage(settings.imageSelection);
    window.dispatchEvent(new CustomEvent("preview-glow", { detail: glow }));
  }
}
export async function onEvent<T>(event: string, handler: (value: T) => void) {
  if (!native) return () => {};
  return listen<T>(event, (e) => handler(e.payload));
}
export async function loadSettings(): Promise<unknown> {
  if (native) return invoke("load_settings");
  return JSON.parse(localStorage.getItem("moyu-settings") ?? "null");
}
export async function saveSettings(settings: Settings) {
  if (native) await invoke("save_settings", { settings });
  else localStorage.setItem("moyu-settings", JSON.stringify(settings));
}
export async function prepareOverlays() {
  if (native) await invoke("prepare_overlays");
}
export const appVersion = (): Promise<string> =>
  native ? invoke("app_version") : Promise.resolve("browser");
export interface UpdateInfo {
  currentVersion: string;
  version: string;
  notes: string;
  publishedAt: string;
}
export interface UpdateProgress { downloaded: number; total: number }
export const checkUpdate = (): Promise<UpdateInfo | null> =>
  native ? invoke("check_update") : Promise.resolve(null);
export const installUpdate = async () => {
  if (native) await invoke("install_update");
};
export interface WindowTarget { title: string; process: string }
export async function listTargetWindows(): Promise<WindowTarget[]> {
  if (!native) throw new Error("应用窗口列表需要 Windows 桌面程序");
  return invoke("list_target_windows");
}
export async function testActions(actions: AlertActions) {
  if (!native) throw new Error("自动操作需要 Windows 桌面程序");
  await invoke("test_actions", { actions });
}
export async function hideToTray() {
  if (native) await invoke("hide_to_tray");
}

export interface ReminderState {
  snoozeUntil: number;
}
export const reminderState = (): Promise<ReminderState> =>
  native ? invoke("reminder_state") : Promise.resolve({ snoozeUntil: 0 });
export const resumeReminders = async () => {
  if (native) await invoke("resume_reminders");
};

export async function popupImage(id?: string): Promise<Blob | null> {
  if (!native) {
    return currentGalleryImage(id);
  }
  if (id === "") return null;
  const bytes = await invoke<ArrayBuffer>("popup_image", { id });
  return bytes.byteLength ? new Blob([bytes]) : null;
}
export async function importPopupImage(file: File) {
  if (file.size > 64 * 1024 * 1024) throw new Error("图片不能超过 64 MB");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => {
      throw new Error("无法读取图片，请选择 PNG、JPEG、GIF 或 WebP 图片");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
  if (native) {
    await invoke("import_popup_image", await file.arrayBuffer());
  } else {
    await replaceGalleryImage(file);
  }
}
export async function resetPopupImage() {
  if (native) await invoke("reset_popup_image");
  else await clearGallery();
}
