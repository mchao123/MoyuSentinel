import { useEffect, useRef, useState, type FormEvent } from "react";
import { Check, Copy, Eye, EyeOff, Network, Pencil, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge";

export interface Peer { id: string; name: string; address: string; accessCode: string; enabled: boolean }
export interface SharingConfig { enabled: boolean; receiveEnabled: boolean; port: number; deviceName: string; sourceId: string; accessCode: string; peers: Peer[] }
export interface SharedPeerState { id: string; name: string; phase: string; people: number; lastSeen: number; latency: number; error: string | null }
export interface SharingState { config: SharingConfig; addresses: string[]; listening: boolean; error: string | null; peers: SharedPeerState[]; activeSources: string[] }
export interface SharedEvent { id: string; source: string; people: number; at: number }
const emptyState: SharingState = { config: { enabled: false, receiveEnabled: true, port: 18420, deviceName: "本机", sourceId: "", accessCode: "", peers: [] }, addresses: [], listening: false, error: null, peers: [], activeSources: [] };
export function useSharingState() {
  const [state, setState] = useState<SharingState>(emptyState);
  const revision = useRef(0);
  useEffect(() => {
    if (!native) return;
    let disposed = false; let pending = false;
    const refresh = async () => {
      if (pending || disposed) return;
      pending = true;
      const requested = revision.current;
      try { const value = await invoke<SharingState>("sharing_state"); if (!disposed && requested === revision.current) setState(value); }
      catch (error) { if (!disposed) setState((old) => ({ ...old, error: String(error) })); }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, []);
  const save = async (config: SharingConfig) => {
    if (!native) throw new Error("局域网共享需要在桌面程序中启用");
    revision.current++;
    const next = await invoke<SharingState>("save_sharing", { config });
    revision.current++;
    setState(next);
    return next;
  };
  return { state, save };
}

function CopyButton({ value, label, onError }: { value: string; label: string; onError: (message: string) => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(timer); }, [copied]);
  return <button type="button" className="icon-button bordered" title={copied ? "已复制" : label} aria-label={label} disabled={!value} onClick={() => {
    void navigator.clipboard.writeText(value).then(() => setCopied(true)).catch(() => onError("复制失败"));
  }}>{copied ? <Check size={15} /> : <Copy size={15} />}</button>;
}
function PeerDialog({ peer, onSave, onClose }: { peer: Peer; onSave: (peer: Peer) => Promise<void>; onClose: () => void }) {
  const [draft, setDraft] = useState(peer);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { await onSave(draft); onClose(); } catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  return <dialog className="peer-dialog" ref={dialog} onCancel={onClose}>
    <form onSubmit={(event) => void submit(event)}>
      <div className="sharing-section-heading"><strong>共享设备</strong><button type="button" className="icon-button" title="关闭" aria-label="关闭设备设置" onClick={onClose}><X size={17} /></button></div>
      <label>备注名称<input autoFocus value={draft.name} maxLength={80} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>设备地址<input required value={draft.address} placeholder="192.168.1.20:18420" onChange={(event) => setDraft({ ...draft, address: event.target.value })} /></label>
      <label>对方访问码<input required type="password" value={draft.accessCode} maxLength={128} autoComplete="off" onChange={(event) => setDraft({ ...draft, accessCode: event.target.value })} /></label>
      {error && <div role="alert" className="sharing-error">{error}</div>}
      <div className="dialog-actions"><button type="button" className="text-button" onClick={onClose}>取消</button><button className="primary-button" disabled={busy}><Save size={15} />{busy ? "正在连接" : "保存并连接"}</button></div>
    </form>
  </dialog>;
}
const phases: Record<string, string> = { idle: "未开启检测", loading: "连接摄像头中", watching: "正在检测", alert: "检测到来人", disabled: "已停用", connecting: "正在连接", offline: "离线" };
export function SharingPage({ state, onSave, onError }: { state: SharingState; onSave: (config: SharingConfig) => Promise<SharingState>; onError: (message: string) => void }) {
  const [draft, setDraft] = useState({ enabled: state.config.enabled, deviceName: state.config.deviceName, port: state.config.port, accessCode: state.config.accessCode });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [editing, setEditing] = useState<Peer | null>(null);
  useEffect(() => {
    if (!dirty) setDraft({ enabled: state.config.enabled, deviceName: state.config.deviceName, port: state.config.port, accessCode: state.config.accessCode });
  }, [state.config, dirty]);
  const update = (value: Partial<typeof draft>) => { setDraft((old) => ({ ...old, ...value })); setDirty(true); };
  async function persist(config: SharingConfig) {
    setBusy(true);
    try { await onSave(config); } finally { setBusy(false); }
  }
  async function saveLocal(event: FormEvent) {
    event.preventDefault();
    try { await persist({ ...state.config, ...draft }); setDirty(false); }
    catch (error) { onError(String(error)); }
  }
  return <section className="sharing-page" aria-label="共享检测">
    <form className="sharing-local" onSubmit={(event) => void saveLocal(event)}>
      <div className="sharing-section-heading"><strong><Network size={17} />本机共享</strong><span className={`connection-state ${state.listening ? "watching" : "idle"}`}>{state.listening ? "共享中" : "未共享"}</span></div>
      <div className="sharing-form-grid">
        <label>设备名称<input required maxLength={80} value={draft.deviceName} onChange={(event) => update({ deviceName: event.target.value })} /></label>
        <label>共享端口<input required type="number" min={1024} max={65535} value={draft.port} onChange={(event) => update({ port: Number(event.target.value) })} /></label>
        <label className="sharing-code">访问码<span className="input-actions"><input aria-label="本机访问码" readOnly type={showCode ? "text" : "password"} value={draft.accessCode} /><button type="button" className="icon-button bordered" aria-label={showCode ? "隐藏访问码" : "显示访问码"} title={showCode ? "隐藏访问码" : "显示访问码"} onClick={() => setShowCode(!showCode)}>{showCode ? <EyeOff size={15} /> : <Eye size={15} />}</button><CopyButton value={draft.accessCode} label="复制访问码" onError={onError} /><button type="button" className="icon-button bordered" aria-label="更换访问码" title="更换访问码" onClick={() => update({ accessCode: crypto.randomUUID().replaceAll("-", "") })}><RefreshCw size={15} /></button></span></label>
        <div className="sharing-local-actions"><label className="switch-label"><input type="checkbox" role="switch" checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} />共享本机检测</label><button className="primary-button" disabled={busy || !dirty}><Save size={15} />保存设置</button></div>
      </div>
      {state.listening && <div className="sharing-addresses">{state.addresses.map((address) => <div key={address}><code>{address}</code><CopyButton value={address} label={`复制地址 ${address}`} onError={onError} /></div>)}</div>}
      {state.error && <div role="alert" className="sharing-error">{state.error}</div>}
    </form>
    <section className="sharing-peers">
      <div className="sharing-section-heading"><strong>共享设备 <span className="count">{state.config.peers.length}</span></strong><div className="sharing-peer-actions"><label className="switch-label"><input type="checkbox" role="switch" checked={state.config.receiveEnabled} disabled={busy} onChange={(event) => void persist({ ...state.config, receiveEnabled: event.target.checked }).catch((error) => onError(String(error)))} />接收共享提醒</label><button className="primary-button" disabled={busy || state.config.peers.length >= 16} onClick={() => setEditing({ id: crypto.randomUUID(), name: "", address: "", accessCode: "", enabled: true })}><Plus size={15} />添加设备</button></div></div>
      {state.config.peers.length ? <div className="peer-list">{state.config.peers.map((peer) => {
        const status = state.peers.find((value) => value.id === peer.id);
        return <div className="peer-row" key={peer.id}>
          <label className="peer-enable"><input type="checkbox" checked={peer.enabled} aria-label={`接收 ${peer.name || peer.address}`} disabled={busy} onChange={(event) => void persist({ ...state.config, peers: state.config.peers.map((value) => value.id === peer.id ? { ...value, enabled: event.target.checked } : value) }).catch((error) => onError(String(error)))} /></label>
          <div className="peer-identity"><strong>{status?.name || peer.name || peer.address}</strong><code>{peer.address}</code>{status?.error && <span className="sharing-error">{status.error}</span>}</div>
          <div className="peer-status"><span className={`connection-state ${status?.phase || "connecting"}`}>{phases[status?.phase || "connecting"]}</span><span>{status?.people || 0} 人{status?.latency ? ` · ${status.latency} ms` : ""}</span></div>
          <div className="peer-tools"><button className="icon-button" title="编辑设备" aria-label={`编辑 ${peer.name || peer.address}`} disabled={busy} onClick={() => setEditing(peer)}><Pencil size={16} /></button><button className="icon-button" title="删除设备" aria-label={`删除 ${peer.name || peer.address}`} disabled={busy} onClick={() => void persist({ ...state.config, peers: state.config.peers.filter((value) => value.id !== peer.id) }).catch((error) => onError(String(error)))}><Trash2 size={16} /></button></div>
        </div>;
      })}</div> : <div className="sharing-empty"><Network size={26} strokeWidth={1.4} /><span>尚未添加设备</span></div>}
    </section>
    {editing && <PeerDialog peer={editing} onClose={() => setEditing(null)} onSave={async (peer) => {
      const exists = state.config.peers.some((value) => value.id === peer.id);
      await persist({ ...state.config, peers: exists ? state.config.peers.map((value) => value.id === peer.id ? peer : value) : [...state.config.peers, peer] });
    }} />}
  </section>;
}
