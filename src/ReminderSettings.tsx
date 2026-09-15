import { useEffect, useState, type ReactNode } from "react";
import { ExternalLink, RefreshCw, Play, AppWindow, Bell, Image, Zap } from "lucide-react";
import { hasEdge, hasPopup, validWebUrl, withReminder, type Settings, type PopupOptions, type AlertActions } from "./domain";
import { listTargetWindows, testActions, native, type WindowTarget } from "./bridge";

export function ReminderSettings({ settings, update, onError, paused, gallery }: {
  settings: Settings;
  update: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
  onError: (message: string) => void;
  paused: boolean;
  gallery: ReactNode;
}) {
  const [windows, setWindows] = useState<WindowTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const popup = settings.popup;
  const actions = settings.actions;
  const setPopup = <K extends keyof PopupOptions>(key: K, value: PopupOptions[K]) => update("popup", { ...popup, [key]: value });
  const setActions = (value: Partial<AlertActions>) => { update("actions", { ...actions, ...value }); setTested(false); };
  const refresh = async () => {
    setLoading(true);
    try { setWindows(await listTargetWindows()); } catch (error) { onError(String(error)); }
    finally { setLoading(false); }
  };
  const test = async () => {
    setTesting(true); setTested(false); onError("");
    try { await testActions(actions); setTested(true); } catch (error) { onError(String(error)); }
    finally { setTesting(false); }
  };
  return <>
    <div className="reminder-toggles" role="group" aria-label="提醒组合">
      <label><input type="checkbox" checked={hasEdge(settings)} onChange={(e) => update("alertMode", withReminder(settings, "edge", e.target.checked))} /><Bell size={16} />边缘光</label>
      <label><input type="checkbox" checked={hasPopup(settings)} onChange={(e) => update("alertMode", withReminder(settings, "popup", e.target.checked))} /><Image size={16} />弹窗</label>
      <label><input type="checkbox" checked={actions.enabled} onChange={(e) => setActions({ enabled: e.target.checked })} /><Zap size={16} />自动操作</label>
    </div>
    {hasEdge(settings) && <fieldset className="reminder-fields">
      <legend>边缘光</legend>
      <label className="color-field">提醒颜色<input type="color" aria-label="提醒颜色" value={settings.glowColor} onChange={(e) => update("glowColor", e.target.value)} /></label>
      <Range label="边缘光强度" value={settings.intensity} min={0.2} max={1} step={0.05} display={`${Math.round(settings.intensity * 100)}%`} onChange={(v) => update("intensity", v)} />
      <Range label="边缘宽度" value={settings.edgeWidth} min={16} max={100} step={2} display={`${settings.edgeWidth} px`} onChange={(v) => update("edgeWidth", v)} />
      <Range label="边缘光离开后保留" value={settings.edgeHoldSeconds} min={1} max={10} step={1} display={`${settings.edgeHoldSeconds} 秒`} onChange={(v) => update("edgeHoldSeconds", v)} />
    </fieldset>}
    {hasPopup(settings) && <fieldset className="reminder-fields">
      <legend>弹窗</legend>
      {gallery}
        <Range label="文字大小" value={popup.fontSize} min={12} max={48} step={1} display={`${popup.fontSize} px`} onChange={(v) => setPopup("fontSize", v)} />
        <div className="paired-fields">
          <label className="color-field">文字颜色<input aria-label="文字颜色" type="color" value={popup.textColor} onChange={(e) => setPopup("textColor", e.target.value)} /></label>
          <label className="color-field">背景颜色<input aria-label="背景颜色" type="color" value={popup.backgroundColor} onChange={(e) => setPopup("backgroundColor", e.target.value)} /></label>
        </div>
      <div className="paired-fields">
        <Numeric label="弹窗宽度" value={popup.width} min={180} max={1200} onChange={(v) => setPopup("width", v)} />
        <Numeric label="弹窗高度" value={popup.height} min={120} max={900} onChange={(v) => setPopup("height", v)} />
      </div>
      <label className="editor-field">弹窗位置<select aria-label="弹窗位置" value={popup.position} onChange={(e) => setPopup("position", e.target.value as PopupOptions["position"])}>
        <option value="top-left">左上角</option><option value="top-right">右上角</option><option value="bottom-left">左下角</option><option value="bottom-right">右下角</option><option value="center">居中</option>
      </select></label>
      <Range label="屏幕边距" value={popup.margin} min={0} max={200} step={1} display={`${popup.margin} px`} onChange={(v) => setPopup("margin", v)} />
      <Range label="弹窗不透明度" value={popup.opacity} min={0.2} max={1} step={0.05} display={`${Math.round(popup.opacity * 100)}%`} onChange={(v) => setPopup("opacity", v)} />
      <Range label="弹窗离开后保留" value={popup.holdSeconds} min={1} max={10} step={1} display={`${popup.holdSeconds} 秒`} onChange={(v) => setPopup("holdSeconds", v)} />
      <Numeric label="关闭后暂停分钟" value={settings.snoozeMinutes} min={1} max={60} onChange={(v) => update("snoozeMinutes", v)} />
    </fieldset>}
    {actions.enabled && <fieldset className="reminder-fields">
      <legend>自动操作</legend>
      <label className="action-toggle"><input type="checkbox" checked={actions.openUrl} onChange={(e) => setActions({ openUrl: e.target.checked })} /><ExternalLink size={16} />打开网页</label>
      {actions.openUrl && <label className="editor-field">网页地址<input aria-label="网页地址" type="url" placeholder="https://" maxLength={2048} value={actions.url} aria-invalid={!validWebUrl(actions.url)} onChange={(e) => setActions({ url: e.target.value })} />
        {!validWebUrl(actions.url) && <span className="sharing-error">请输入完整的 HTTP 或 HTTPS 地址</span>}
      </label>}
      <label className="action-toggle"><input type="checkbox" checked={actions.focusWindow} onChange={(e) => { setActions({ focusWindow: e.target.checked }); if (e.target.checked && native) void refresh(); }} /><AppWindow size={16} />切换应用窗口</label>
      {actions.focusWindow && <>
        <label className="editor-field">目标窗口<div className="input-actions"><select aria-label="目标窗口" value="" onChange={(e) => {
          const target = windows[Number(e.target.value)];
          if (target) setActions({ windowProcess: target.process, windowTitle: target.title });
        }}>
          <option value="" disabled>{loading ? "正在读取窗口" : windows.length ? "选择已打开的窗口" : "暂无窗口"}</option>
          {windows.map((target, i) => <option key={i} value={i}>{target.title}</option>)}
        </select><button className="icon-button bordered" title="刷新窗口列表" aria-label="刷新窗口列表" disabled={loading || !native} onClick={() => void refresh()}><RefreshCw size={16} className={loading ? "spinning" : ""} /></button></div></label>
        {actions.windowProcess && <span className="target-process" title={actions.windowProcess}>{actions.windowProcess.split(/[\\/]/).pop()}</span>}
        <label className="editor-field">窗口标题包含<input maxLength={512} value={actions.windowTitle} onChange={(e) => setActions({ windowTitle: e.target.value })} /></label>
      </>}
      <button className="secondary-button" disabled={!native || paused || testing || (!actions.openUrl && !actions.focusWindow) || (actions.openUrl && !validWebUrl(actions.url)) || (actions.focusWindow && !actions.windowProcess)} title={!native ? "需要 Windows 桌面程序" : undefined} onClick={() => void test()}><Play size={14} />{testing ? "正在执行" : "测试自动操作"}</button>
      {tested && <span className="connection-state watching" role="status">自动操作已执行</span>}
    </fieldset>}
  </>;
}
function Numeric({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const next = Math.max(min, Math.min(max, Math.round(Number(draft) || min)));
    setDraft(String(next)); onChange(next);
  };
  return <label className="editor-field">{label}<input type="number" value={draft} min={min} max={max} step={1}
    onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} /></label>;
}
export function Range({ label, value, min, max, step, display, onChange }: {
  label: string; value: number; min: number; max: number; step: number; display: string; onChange: (value: number) => void;
}) {
  return <label className="range-field"><span>{label}<output>{display}</output></span><input type="range" aria-label={label} value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} /></label>;
}
