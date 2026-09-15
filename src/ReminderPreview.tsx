import { useEffect, useRef, useState } from "react";
import type { Settings } from "./domain";
import { PopupCard } from "./Popup";
import { GlowLayer } from "./Overlay";

export function ReminderPreview({ settings, url }: { settings: Settings; url: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState({ width: 0, height: 0 });
  const [screenSize, setScreenSize] = useState({ width: screen.width, height: screen.height });
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      setAvailable({ width: entry.contentRect.width, height: entry.contentRect.height });
      setScreenSize({ width: screen.width, height: screen.height });
    });
    observer.observe(stage.current!);
    return () => observer.disconnect();
  }, []);
  const popup = settings.alertMode === "popup";
  const width = popup ? 360 : Math.max(1, screenSize.width);
  const height = popup ? 250 : Math.max(1, screenSize.height);
  const scale = Math.max(0, Math.min(available.width / width, available.height / height));
  return <div ref={stage} className="reminder-preview-stage" aria-label={popup ? "图片弹窗预览" : "边缘光预览"}>
    <div className={`preview-window ${popup ? "image-preview" : "edge-preview"}`} style={{ width: width * scale, height: height * scale }}>
      {/* Scale the entire native-size surface, including captions and controls. */}
      <div className="preview-native-surface" style={{ width, height, transform: `scale(${scale})` }}>
        {popup ? <PopupCard url={url} preview /> : <GlowLayer glow={{ active: true, color: settings.glowColor, width: settings.edgeWidth, intensity: settings.intensity }} style={{ position: "absolute" }} />}
      </div>
    </div>
  </div>;
}
