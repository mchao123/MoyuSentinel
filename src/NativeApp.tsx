import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Camera,
  Bell,
  ChevronDown,
  CircleAlert,
  Eye,
  EyeOff,
  Gauge,
  History,
  LoaderCircle,
  Monitor,
  Play,
  RefreshCw,
  Square,
  Users,
  X,
  Network,
  Download,
  Info,
} from "lucide-react";
import {
  defaults,
  normalizeSettings,
  regionBounds,
  type Settings,
  hasEdge,
  hasPopup,
  popupWindowSize,
} from "./domain";
import {
  hideToTray,
  loadSettings,
  native,
  onEvent,
  prepareOverlays,
  saveSettings,
  setGlow,
  type Glow,
  listCameras,
  monitorState,
  previewFrame,
  startMonitoring,
  stopMonitoring,
  idleState,
  type MonitorState,
  type CameraDevice,
  reminderState,
  resumeReminders,
  type ReminderState,
  appVersion,
  checkUpdate,
  installUpdate,
  type UpdateInfo,
  type UpdateProgress,
} from "./bridge";
import { GlowLayer } from "./Overlay";
import { PopupCard, popupPosition, usePopupImage } from "./Popup";
import { ReminderSettings } from "./ReminderSettings";
import { AdGallery } from "./AdGallery";
import type { Caption } from "./gallery";
import { ReminderPreview } from "./ReminderPreview";
import { SharingPage, useSharingState, type SharedEvent } from "./Sharing";
import { AboutPage } from "./AboutPage";

interface Entry {
  id: number | string;
  time: string;
  people: number;
  source: string;
}
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function App() {
  const [settings, setSettings] = useState<Settings>(defaults);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [loaded, setLoaded] = useState(false);
  const [devices, setDevices] = useState<CameraDevice[]>([]);
  const [state, setState] = useState<MonitorState>(idleState);
  const [error, setError] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [preview, setPreview] = useState(true);
  const [controlVisible, setControlVisible] = useState(true);
  const [testing, setTesting] = useState(false);
  const [frameUrl, setFrameUrl] = useState("");
  const [settingsTab, setSettingsTab] = useState<"detection" | "reminder">(
    "detection",
  );
  const [snoozeUntil, setSnoozeUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [importing, setImporting] = useState(false);
  const [page, setPage] = useState<"monitor" | "reminder" | "sharing" | "about">("monitor");
  const sharing = useSharingState();
  const [version, setVersion] = useState("");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateChecked, setUpdateChecked] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null);
  const popupImage = usePopupImage();
  const [editingImage, setEditingImage] = useState<{ id: string; caption: Caption }>();
  const editedImage = usePopupImage(editingImage?.id);
  const paused = snoozeUntil > now;
  useEffect(() => {
    let disposed = false;
    const unlisten = onEvent<ReminderState>("reminder-state", (value) => {
      setSnoozeUntil(value.snoozeUntil);
      setNow(Date.now());
    });
    void unlisten
      .then(() => reminderState())
      .then((value) => {
        if (!disposed) setSnoozeUntil(value.snoozeUntil);
      })
      .catch((e) => {
        if (!disposed) setError(message(e));
      });
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
    };
  }, []);
  useEffect(() => {
    if (!snoozeUntil) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= snoozeUntil) setSnoozeUntil(0);
    }, 1000);
    return () => clearInterval(timer);
  }, [snoozeUntil]);
  const [previewGlow, setPreviewGlow] = useState<Glow>({
    active: false,
    intensity: 0.7,
    width: 52,
  });
  const lastEvent = useRef(0);
  const busy = useRef(false);
  const phase = state.phase;
  const running = phase === "watching" || phase === "alert";
  const people = state.people;
  const acceptState = useCallback((next: MonitorState) => {
    setState(next);
    if (next.error) setError(next.error);
    if (next.alertEvent > lastEvent.current) {
      lastEvent.current = next.alertEvent;
      setEntries((old) =>
        [
          {
            id: next.alertEvent,
            people: next.alertPeople,
            source: "本机",
            time: new Date(next.alertAt).toLocaleTimeString("zh-CN", {
              hour12: false,
            }),
          },
          ...old,
        ].slice(0, 30),
      );
    }
  }, []);
  const refreshDevices = useCallback(async () => {
    setDevices(await listCameras());
  }, []);
  useEffect(() => {
    let disposed = false;
    void appVersion()
      .then((value) => { if (!disposed) setVersion(value); })
      .catch(() => {});
    if (!native) return () => { disposed = true; };
    const progress = onEvent<UpdateProgress>("update-progress", setUpdateProgress);
    const timer = setTimeout(() => {
      if (!disposed) void checkForUpdate(true);
    }, 1200);
    return () => {
      disposed = true;
      clearTimeout(timer);
      void progress.then((fn) => fn());
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    void Promise.all([loadSettings(), listCameras()])
      .then(([value, cameras]) => {
        if (disposed) return;
        const restored = normalizeSettings(value);
        if (!cameras.some((camera) => camera.deviceId === restored.deviceId))
          restored.deviceId = "";
        setSettings(restored);
        setDevices(cameras);
      })
      .catch((e) => {
        if (!disposed) setError(message(e));
      })
      .finally(() => {
        if (!disposed) setLoaded(true);
      });
    void monitorState().then((next) => {
      if (!disposed) acceptState(next);
    });
    const unlisten = onEvent<MonitorState>("monitor-state", acceptState);
    const stopped = onEvent("stop-monitoring", () => {
      void monitorState().then(acceptState);
    });
    const monitorError = onEvent<string>("monitor-error", setError);
    const sharedDetection = onEvent<SharedEvent>("shared-detection", (value) => {
      setEntries((old) => [{ id: value.id, source: value.source, people: value.people,
        time: new Date(value.at).toLocaleTimeString("zh-CN", { hour12: false }) }, ...old].slice(0, 30));
    });
    const visibility = onEvent<boolean>("control-visible", setControlVisible);
    const previewEvent = (event: Event) =>
      setPreviewGlow((event as CustomEvent<Glow>).detail);
    window.addEventListener("preview-glow", previewEvent);
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
      void stopped.then((fn) => fn());
      void monitorError.then((fn) => fn());
      void sharedDetection.then((fn) => fn());
      void visibility.then((fn) => fn());
      window.removeEventListener("preview-glow", previewEvent);
    };
  }, [acceptState]);
  useEffect(() => {
    if (!loaded) return;
    const timer = setTimeout(() => {
      void saveSettings(settings).catch((e) =>
        setError(`设置保存失败：${message(e)}`),
      );
    }, 300);
    return () => clearTimeout(timer);
  }, [settings, loaded]);
  useEffect(() => {
    setFrameUrl("");
    if (!native || !loaded || !preview || !controlVisible || page !== "monitor") {
      return;
    }
    let disposed = false;
    let pending = false;
    let failed = false;
    let restart = true;
    let currentUrl = "";
    const pull = async () => {
      if (disposed || pending || failed || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const bytes = await previewFrame(settings.deviceId, restart);
        restart = false;
        if (disposed) return;
        if (bytes.byteLength === 0) {
          setFrameUrl("");
          if (currentUrl) URL.revokeObjectURL(currentUrl);
          currentUrl = "";
          return;
        }
        const next = URL.createObjectURL(
          new Blob([bytes], { type: "image/jpeg" }),
        );
        const image = new Image();
        image.src = next;
        try {
          await image.decode();
        } catch (error) {
          URL.revokeObjectURL(next);
          throw error;
        }
        if (disposed) {
          URL.revokeObjectURL(next);
          return;
        }
        const previous = currentUrl;
        currentUrl = next;
        setFrameUrl(next);
        if (previous) URL.revokeObjectURL(previous);
      } catch (e) {
        if (!disposed) {
          failed = true;
          setFrameUrl("");
          setError(`预览读取失败：${message(e)}`);
        }
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => {
      void pull();
    }, 100);
    void pull();
    return () => {
      disposed = true;
      clearInterval(timer);
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [loaded, preview, controlVisible, settings.deviceId, phase === "idle", page]);
  async function start() {
    if (!loaded || busy.current) return;
    busy.current = true;
    setError("");
    setState((old) => ({ ...old, phase: "loading", error: null }));
    try {
      await startMonitoring(settingsRef.current);
      acceptState(await monitorState());
    } catch (e) {
      setError(message(e));
      setState((old) => ({ ...old, phase: "idle" }));
    } finally {
      busy.current = false;
    }
  }
  async function stop() {
    try {
      await stopMonitoring();
      acceptState(await monitorState());
    } catch (e) {
      setError(message(e));
    }
  }
  async function checkForUpdate(silent = false) {
    if (checkingUpdate || updating) return;
    setCheckingUpdate(true);
    if (!silent) setError("");
    try {
      const value = await checkUpdate();
      setUpdateInfo(value);
      setUpdateChecked(true);
    } catch (e) {
      if (!silent) setError(`检查更新失败：${message(e)}`);
    } finally {
      setCheckingUpdate(false);
    }
  }
  async function installAvailableUpdate() {
    setUpdating(true);
    setUpdateProgress(null);
    setError("");
    try {
      await installUpdate();
    } catch (e) {
      setUpdating(false);
      setError(`更新失败：${message(e)}`);
    }
  }
  async function testGlow() {
    setTesting(true);
    setError("");
    try {
      await prepareOverlays();
      await setGlow(true, settingsRef.current, true);
      setTimeout(() => {
        setTesting(false);
        if (!native) void setGlow(false, settingsRef.current);
      }, 3000);
    } catch (e) {
      setTesting(false);
      setError(message(e));
    }
  }
  const update = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((old) => ({ ...old, [key]: value }));
  const [regionLeft, regionRight] = regionBounds(settings.region);
  const status = {
    idle: frameUrl && preview ? "仅预览" : "尚未启动",
    loading: "正在连接",
    watching: "正在检测",
    alert: "有人出现",
  }[phase];
  const aspect =
    state.width && state.height ? state.width / state.height : 4 / 3;

  return (
    <div className="app-shell">
      <main>
        <nav className="app-nav" role="tablist" aria-label="页面">
          <button role="tab" aria-selected={page === "monitor"} aria-controls="monitor-page" onClick={() => { setPage("monitor"); setSettingsTab("detection"); }}><Camera size={16} />摄像头</button>
          <button role="tab" aria-selected={page === "reminder"} aria-controls="reminder-page" onClick={() => { setPage("reminder"); setSettingsTab("reminder"); }}><Bell size={16} />提醒</button>
          <button role="tab" aria-selected={page === "sharing"} aria-controls="sharing-page" onClick={() => setPage("sharing")}><Network size={16} />共享</button>
          <button className="nav-right" role="tab" aria-selected={page === "about"} aria-controls="about-page" onClick={() => setPage("about")}><Info size={16} />关于</button>
        </nav>
        <div className="app-content">
        {paused && (
          <div className="snooze-banner" role="status">
            <span>
              提醒已暂停{" "}
              {Math.floor(Math.ceil((snoozeUntil - now) / 1000) / 60)}:
              {String(Math.ceil((snoozeUntil - now) / 1000) % 60).padStart(
                2,
                "0",
              )}
            </span>
            <button
              className="text-button"
              onClick={() => {
                void resumeReminders()
                  .then(() => setSnoozeUntil(0))
                  .catch((e) => setError(message(e)));
              }}
            >
              恢复提醒
            </button>
          </div>
        )}
        {error && (
          <div className="error-banner" role="alert">
            <CircleAlert size={19} />
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="关闭错误提示"
              title="关闭"
              onClick={() => setError("")}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {updateInfo && !updateDismissed && page !== "about" && (
          <div className="update-banner" role="status">
            <Download size={19} />
            <div>
              <strong>发现新版本 v{updateInfo.version}</strong>
              <span>{updateInfo.notes.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "建议更新到最新版本"}</span>
            </div>
            <button
              className="primary-button"
              type="button"
              disabled={updating}
              onClick={() => void installAvailableUpdate()}
            >
              {updating
                ? updateProgress?.total
                  ? `下载中 ${Math.round(updateProgress.downloaded / updateProgress.total * 100)}%`
                  : "正在准备"
                : "下载并安装"}
            </button>
            <button
              className="icon-button"
              type="button"
              aria-label="稍后提醒"
              disabled={updating}
              onClick={() => setUpdateDismissed(true)}
            >
              <X size={15} />
            </button>
          </div>
        )}
        {!paused && sharing.state.activeSources.length > 0 && <div className="shared-alert" role="status"><Network size={16} /><span>来人提醒：{sharing.state.activeSources.join("、")}</span></div>}
        {page === "sharing" && <div id="sharing-page" role="tabpanel"><SharingPage state={sharing.state} onSave={sharing.save} onError={setError} /></div>}
        {page === "about" && <AboutPage version={version || "..."} update={updateInfo} checked={updateChecked} checking={checkingUpdate} updating={updating} progress={updateProgress} onCheck={() => void checkForUpdate()} onInstall={() => void installAvailableUpdate()} />}
        <div className={`workspace ${page}`} id={page === "reminder" ? "reminder-page" : "monitor-page"} role="tabpanel" hidden={page === "sharing" || page === "about"}>
                    <section className="camera-section">
            <div className="section-heading">
              <span className={`status-badge ${phase}`}>
                <i />
                {status}
              </span>
              <div className="header-actions">
                {!native && <span className="browser-badge">浏览器预览</span>}
                <button
                  className="icon-button"
                  title={preview ? "隐藏预览" : "显示预览"}
                  aria-label={preview ? "隐藏预览" : "显示预览"}
                  onClick={() => {
                    setError("");
                    setPreview(!preview);
                  }}
                >
                  {preview ? <Eye size={17} /> : <EyeOff size={17} />}
                </button>
                {native && (
                  <button
                    className="icon-button"
                    title="收起到系统托盘"
                    aria-label="收起到系统托盘"
                    onClick={() => {
                      void hideToTray().catch((e) => setError(message(e)));
                    }}
                  >
                    <ChevronDown size={19} />
                  </button>
                )}
              </div>
            </div>
            <div
              className={`camera-frame ${phase === "alert" ? "detected" : ""}`}
              style={
                {
                  aspectRatio: aspect,
                  "--camera-aspect": aspect,
                } as CSSProperties
              }
            >
              {frameUrl && preview && (
                <img
                  className="camera-image"
                  src={frameUrl}
                  alt="摄像头实时画面"
                />
              )}
              {(!frameUrl || !preview) && (
                <div className="camera-placeholder">
                  {phase === "loading" ? (
                    <LoaderCircle className="spinning" size={34} />
                  ) : !preview ? (
                    <EyeOff size={34} />
                  ) : (
                    <Camera size={38} strokeWidth={1.3} />
                  )}
                  <strong>
                    {phase === "loading"
                      ? "正在连接摄像头"
                      : !preview
                        ? "预览已隐藏"
                        : running || (native && loaded && !error)
                          ? "正在获取画面"
                          : "摄像头待命"}
                  </strong>
                </div>
              )}
              {running && preview && frameUrl && (
                <>
                  {settings.region !== "full" && (
                    <div
                      className="region-mask"
                      style={{
                        left: `${regionLeft * 100}%`,
                        width: `${(regionRight - regionLeft) * 100}%`,
                      }}
                    >
                      <span>检测区域</span>
                    </div>
                  )}
                  {people.map((p, i) => (
                    <div
                      key={i}
                      className="person-box"
                      style={{
                        left: `${p.x * 100}%`,
                        top: `${p.y * 100}%`,
                        width: `${p.width * 100}%`,
                        height: `${p.height * 100}%`,
                      }}
                    >
                      <span>人形 {Math.round(p.score * 100)}%</span>
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="camera-stats">
              <span>
                <Users size={15} />
                <b>{people.length}</b> 检测人数
              </span>
              <span>
                <Gauge size={15} />
                <b>{state.latency || "--"}</b> ms
              </span>
            </div>
            <div className="camera-controls">
              <div className="select-wrap">
                <Camera size={16} />
                <select
                  aria-label="摄像头"
                  disabled={phase !== "idle"}
                  value={settings.deviceId}
                  onChange={(e) => {
                    setError("");
                    update("deviceId", e.target.value);
                  }}
                >
                  <option value="">默认摄像头</option>
                  {devices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </div>
              <button
                className="icon-button bordered"
                aria-label="刷新摄像头"
                title="刷新摄像头"
                disabled={phase !== "idle"}
                onClick={() => {
                  void refreshDevices().catch((e) => setError(message(e)));
                }}
              >
                <RefreshCw size={17} />
              </button>
              <button
                className={`primary-button ${phase !== "idle" ? "stop-button" : ""}`}
                disabled={!loaded}
                onClick={() => (phase === "idle" ? void start() : void stop())}
              >
                {phase === "idle" ? (
                  <Play size={16} fill="currentColor" />
                ) : (
                  <Square size={15} fill="currentColor" />
                )}
                {phase === "idle"
                  ? "开始检测"
                  : phase === "loading"
                    ? "取消连接"
                    : "停止检测"}
              </button>
            </div>
            <details className="activity-section">
              <summary>
                <History size={15} />
                最近提醒 <span className="count">{entries.length}</span>
              </summary>
              <div className="section-heading">
                {entries.length > 0 && (
                  <button
                    className="text-button"
                    onClick={() => setEntries([])}
                  >
                    清空
                  </button>
                )}
              </div>
              {entries.length ? (
                <div className="activity-list">
                  {entries.map((entry) => (
                    <div className="activity-row" key={entry.id}>
                      <span className="event-dot" />
                      <span title={entry.source}>{entry.source} · 检测到来人</span>
                      <span className="event-people">{entry.people} 人</span>
                      <time>{entry.time}</time>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="activity-empty">暂无提醒记录</div>
              )}
            </details>
          </section>
          <aside className="settings-section">
            <div className="settings-tabs" role="tablist" aria-label="设置">
              <button
                role="tab"
                aria-selected={settingsTab === "detection"}
                aria-controls="detection-settings"
                id="detection-tab"
                onClick={() => setSettingsTab("detection")}
              >
                检测
              </button>
              <button
                role="tab"
                aria-selected={settingsTab === "reminder"}
                aria-controls="reminder-settings"
                id="reminder-tab"
                onClick={() => setSettingsTab("reminder")}
              >
                提醒
              </button>
            </div>
            {settingsTab === "detection" && (
              <div
                className="settings-group"
                role="tabpanel"
                id="detection-settings"
                aria-labelledby="detection-tab"
              >
                <label className="field-label" htmlFor="region">
                  检测区域
                </label>
                <select
                  id="region"
                  value={settings.region}
                  onChange={(e) =>
                    update("region", e.target.value as Settings["region"])
                  }
                >
                  <option value="full">全部画面</option>
                  <option value="left">画面左半侧</option>
                  <option value="right">画面右半侧</option>
                  <option value="center">画面中间区域</option>
                </select>
                <label className="field-label" htmlFor="min-people">
                  触发人数
                </label>
                <select
                  id="min-people"
                  value={settings.minPeople}
                  onChange={(e) => update("minPeople", Number(e.target.value))}
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      至少 {n} 人
                    </option>
                  ))}
                </select>
                <Range
                  label="检测间隔"
                  value={settings.detectionIntervalMs}
                  min={100}
                  max={2000}
                  step={50}
                  display={`${settings.detectionIntervalMs} ms`}
                  onChange={(v) => update("detectionIntervalMs", v)}
                />
                <Range
                  label="识别置信度"
                  value={settings.confidence}
                  min={0.3}
                  max={0.9}
                  step={0.05}
                  display={`${Math.round(settings.confidence * 100)}%`}
                  onChange={(v) => update("confidence", v)}
                />
              </div>
            )}
            {settingsTab === "reminder" && (
              <div
                className="settings-group reminder-editor"
                role="tabpanel"
                id="reminder-settings"
                aria-labelledby="reminder-tab"
              >
                <ReminderSettings settings={settings} update={update} onError={setError} paused={paused} gallery={
                  <AdGallery selection={settings.imageSelection} onSelection={(value) => update("imageSelection", value)} onError={setError} onBusy={setImporting} onPreview={setEditingImage} />
                } />
              </div>
            )}
            {page === "reminder" && <div className="reminder-media">
              <ReminderPreview settings={settings} url={editedImage.url} caption={editingImage?.caption ?? editedImage.caption} imageSize={{ width: editedImage.width, height: editedImage.height }} actions={<button className="test-button" disabled={testing || paused || importing} onClick={() => void testGlow()}><Monitor size={16} />{testing ? "提醒测试中…" : "测试提醒"}<small>3 秒</small></button>} />
            </div>}
          </aside>
        </div>
        </div>
      </main>
      {!native && hasEdge(settings) && (
        <GlowLayer glow={{ ...previewGlow, active: previewGlow.active && !paused }} />
      )}
      {!native &&
        hasPopup(settings) &&
        previewGlow.active &&
        !paused && (
          <div className="browser-popup" style={{ ...popupPosition(settings.popup, popupWindowSize(settings.popup, popupImage)), position: "fixed" }}>
            <PopupCard
              url={popupImage.url}
              options={settings.popup}
              caption={popupImage.caption}
              onClose={() => {
                setSnoozeUntil(Date.now() + settings.snoozeMinutes * 60000);
                setNow(Date.now());
                setPreviewGlow((old) => ({ ...old, active: false }));
              }}
            />
          </div>
        )}
    </div>
  );
}
function Range({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-field">
      <span>
        {label}
        <output>{display}</output>
      </span>
      <input
        type="range"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
