import { useEffect, useRef, useState, type ReactNode } from "react";
import { hasEdge, hasPopup, popupWindowSize, type Settings } from "./domain";
import { PopupCard, popupPosition } from "./Popup";
import { GlowLayer } from "./Overlay";
import type { Caption } from "./gallery";

export function ReminderPreview({ settings, url, caption, imageSize: sourceImageSize, actions }: { settings: Settings; url: string; caption: Caption; imageSize: { width: number; height: number }; actions?: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [screenSize, setScreenSize] = useState({ width: screen.width, height: screen.height });
  const [loadedImageSize, setLoadedImageSize] = useState({ width: 0, height: 0 });
  const imageSize = sourceImageSize.width > 0 && sourceImageSize.height > 0 ? sourceImageSize : loadedImageSize;
  useEffect(() => {
    const updateScreenSize = () => setScreenSize({ width: screen.width, height: screen.height });
    const observer = new ResizeObserver(([entry]) => {
      setAvailable({ width: entry.contentRect.width, height: entry.contentRect.height });
      updateScreenSize();
    });
    observer.observe(stage.current!);
    window.addEventListener("resize", updateScreenSize);
    screen.orientation?.addEventListener("change", updateScreenSize);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateScreenSize);
      screen.orientation?.removeEventListener("change", updateScreenSize);
    };
  }, []);
  const [view, setView] = useState<"popup" | "desktop">("desktop");
  const popup = hasPopup(settings) && view === "popup";
  const fittedPopup = popupWindowSize(settings.popup, imageSize);
  const width = popup ? fittedPopup.width : Math.max(1, screenSize.width);
  const height = popup ? fittedPopup.height : Math.max(1, screenSize.height);
  const scale = Math.max(0, Math.min(available.width / width, available.height / height));
  return <div className="reminder-preview">
    <div className="reminder-preview-toolbar">
      <div className="preview-toolbar" role="group" aria-label="预览视图"><button aria-pressed={!popup} onClick={() => setView("desktop")}>桌面</button><button aria-pressed={popup} disabled={!hasPopup(settings)} onClick={() => setView("popup")}>弹窗</button></div>
      {actions && <div className="reminder-preview-actions">{actions}</div>}
    </div>
    <div ref={stage} className="reminder-preview-stage" aria-label={popup ? "弹窗预览" : "桌面组合预览"}>
    <div className={`preview-window ${popup ? "image-preview" : "edge-preview"}`} style={{ width: width * scale, height: height * scale }}>
      {/* Scale the entire native-size surface, including captions and controls. */}
      <div className="preview-native-surface" style={{ width, height, transform: `scale(${scale})` }}>
        {popup ? <PopupCard url={url} options={settings.popup} caption={caption} preview onImageSize={(width, height) => setLoadedImageSize({ width, height })} /> : <>
          {hasEdge(settings) && <GlowLayer glow={{ active: true, color: settings.glowColor, width: settings.edgeWidth, intensity: settings.intensity }} style={{ position: "absolute" }} />}
          {hasPopup(settings) && <div style={popupPosition(settings.popup, fittedPopup)}><PopupCard url={url} options={settings.popup} caption={caption} preview onImageSize={(width, height) => setLoadedImageSize({ width, height })} /></div>}
        </>}
      </div>
    </div>
  </div></div>;
}
