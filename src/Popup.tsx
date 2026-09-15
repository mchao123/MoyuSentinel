import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { native, onEvent, popupImage } from "./bridge";
import defaultAd from "./assets/default-ad.jpg";

export function usePopupImage() {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [imageRevision, setImageRevision] = useState(-1);
  useEffect(() => {
    let disposed = false;
    let current = "";
    let revision = 0;
    const refresh = async () => {
      const requested = ++revision;
      let next = "";
      try {
        const readyRevision = native ? await invoke<number>("popup_image_revision") : requested;
        const blob = await popupImage();
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
  }, []);
  return { url, error, revision: imageRevision };
}

export function PopupCard({
  url,
  onClose,
  error = "",
  disabled = false,
  preview = false,
}: {
  url: string;
  onClose?: () => void;
  error?: string;
  disabled?: boolean;
  preview?: boolean;
}) {
  return (
    <div className={`popup-card ${url ? "custom" : "default-ad"}`}>
      <img
        src={url || defaultAd}
        alt={url ? "自定义提醒图片" : "耳机限时推荐"}
      />
      {!url && (
        <div className="ad-caption">
          <strong>好声音，随时随地</strong>
          <span>今日好物推荐</span>
        </div>
      )}
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
  const image = usePopupImage();
  useEffect(() => {
    if (native && image.revision >= 0 && !image.error) {
      void invoke("popup_ready", { revision: image.revision });
    }
  }, [image.revision, image.error, image.url]);
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
      error={error || image.error}
      disabled={closing}
      onClose={() => {
        void close();
      }}
    />
  );
}
