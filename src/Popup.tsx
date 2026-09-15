import { useEffect, useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { native, onEvent, popupImage } from "./bridge";
import defaultAd from "./assets/default-ad.jpg";
import { normalizeSettings, popupDefaults, type PopupOptions } from "./domain";
import { defaultCaption, popupImageState, type Caption } from "./gallery";

export function popupPosition(options: PopupOptions): CSSProperties {
  const center = options.position === "center";
  const marginX = `min(${options.margin}px, max(0px, calc((100% - 180px) / 2)))`;
  const marginY = `min(${options.margin}px, max(0px, calc((100% - 120px) / 2)))`;
  return {
    position: "absolute", width: options.width, height: options.height,
    maxWidth: `max(min(100%, 180px), calc(100% - ${options.margin * 2}px))`, maxHeight: `max(min(100%, 120px), calc(100% - ${options.margin * 2}px))`,
    left: center ? "50%" : options.position.endsWith("left") ? marginX : "auto",
    right: !center && options.position.endsWith("right") ? marginX : "auto",
    top: center ? "50%" : options.position.startsWith("top") ? marginY : "auto",
    bottom: !center && options.position.startsWith("bottom") ? marginY : "auto",
    transform: center ? "translate(-50%, -50%)" : undefined,
  };
}

export function usePopupImage(id?: string) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [imageRevision, setImageRevision] = useState(-1);
  const [caption, setCaption] = useState<Caption>(defaultCaption);
  useEffect(() => {
    let disposed = false;
    let current = "";
    let revision = 0;
    const refresh = async () => {
      const requested = ++revision;
      let next = "";
      try {
        const metadata = await popupImageState(id);
        const readyRevision = native ? metadata.revision : requested;
        const blob = await popupImage(metadata.id);
        if (disposed || requested !== revision) return;
        next = blob ? URL.createObjectURL(blob) : "";
        const image = new Image();
        image.src = next || defaultAd;
        await image.decode();
        if (disposed || requested !== revision) { if (next) URL.revokeObjectURL(next); return; }
        if (current) URL.revokeObjectURL(current);
        current = next;
        setUrl(next);
        setImageRevision(readyRevision);
        setCaption(metadata.caption);
        setError("");
      } catch {
        if (next) URL.revokeObjectURL(next);
        if (!disposed) setError("图片读取失败");
      }
    };
    const changed = () => {
      void refresh();
    };
    const unlisten = onEvent("popup-image-changed", changed);
    window.addEventListener("popup-image-changed", changed);
    void unlisten.then(() => {
      if (!disposed) void refresh();
    });
    return () => {
      disposed = true;
      if (current) URL.revokeObjectURL(current);
      void unlisten.then((fn) => fn());
      window.removeEventListener("popup-image-changed", changed);
    };
  }, [id]);
  return { url, error, caption, revision: imageRevision };
}

export function PopupCard({
  url,
  onClose,
  error = "",
  disabled = false,
  preview = false,
  options = popupDefaults,
  caption = defaultCaption,
}: {
  url: string;
  onClose?: () => void;
  error?: string;
  disabled?: boolean;
  preview?: boolean;
  options?: PopupOptions;
  caption?: Caption;
}) {
  return (
    <div className={`popup-card ${url ? "custom" : "default-ad"}`}>
      <div className="popup-content" style={{ opacity: options.opacity }}>
      <div className="popup-image">
      <img
        src={url || defaultAd}
        alt={url ? "自定义提醒图片" : "耳机限时推荐"}
      />
      {(caption.title.trim() || caption.text.trim()) && (
        <div className="ad-caption" style={{ color: options.textColor, backgroundColor: `${options.backgroundColor}cc`, fontSize: options.fontSize }}>
          {caption.title.trim() && <strong>{caption.title}</strong>}
          {caption.text.trim() && <span>{caption.text}</span>}
        </div>
      )}
      </div>
      </div>
      {preview && <span className="popup-close" aria-hidden="true"><X size={18} /></span>}
      {onClose && (
        <button
          className="popup-close"
          title="关闭并暂停提醒"
          aria-label="关闭并暂停提醒"
          disabled={disabled}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      )}
      {error && (
        <div className="popup-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
export function Popup() {
  const [options, setOptions] = useState<PopupOptions | null>(null);
  const image = usePopupImage();
  useEffect(() => {
    let disposed = false;
    let changed = false;
    const unlisten = onEvent<PopupOptions>("popup-settings-changed", (value) => { changed = true; setOptions(value); });
    void unlisten.then(async () => {
      const value = native ? await invoke<PopupOptions>("popup_settings") : normalizeSettings(JSON.parse(localStorage.getItem("moyu-settings") ?? "null")).popup;
      if (!disposed && !changed) setOptions(value);
    }).catch(() => { if (!disposed) setOptions(popupDefaults); });
    return () => { disposed = true; void unlisten.then((fn) => fn()); };
  }, []);
  useEffect(() => {
    if (native && options && image.revision >= 0 && !image.error) {
      void invoke("popup_ready", { revision: image.revision });
    }
  }, [image.revision, image.error, image.url, options]);
  const [error, setError] = useState("");
  const [closing, setClosing] = useState(false);
  const close = async () => {
    setClosing(true);
    try {
      if (native) await invoke("dismiss_popup");
    } catch {
      setError("关闭失败，请重试");
    } finally {
      setClosing(false);
    }
  };
  return (
    <PopupCard
      url={image.url}
      options={options ?? popupDefaults}
      caption={image.caption}
      error={error || image.error}
      disabled={closing}
      onClose={() => {
        void close();
      }}
    />
  );
}
