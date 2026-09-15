import { useEffect, useState, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { native, onEvent, type Glow } from "./bridge";

export function GlowLayer({
  glow,
  style,
}: {
  glow: Glow;
  style?: CSSProperties;
}) {
  const color = /^#[0-9a-f]{6}$/i.test(glow.color ?? "") ? glow.color! : "#ff1930";
  const channels = [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16)).join(" ");
  return (
    <div
      aria-hidden="true"
      className={`glow-layer ${glow.active ? "active" : ""}`}
      style={
        {
          "--glow-opacity": glow.intensity,
          "--glow-width": `${glow.width}px`,
          "--glow-color": channels,
          ...style,
        } as CSSProperties
      }
    />
  );
}
export function Overlay() {
  const [glow, setGlow] = useState<Glow>({
    active: false,
    intensity: 0.7,
    width: 52,
  });
  useEffect(() => {
    const unlisten = onEvent<Glow>("glow", setGlow);
    if (native) void invoke<Glow>("overlay_state").then(setGlow);
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
  const params = new URLSearchParams(window.location.search);
  const height = Number(params.get("height"));
  const slice = Number(params.get("slice"));
  const bottom = params.get("part") === "bottom";
  return (
    <GlowLayer
      glow={glow}
      style={
        height > 0 && slice > 0
          ? {
              height: `${(height / slice) * 100}%`,
              top: bottom ? "auto" : 0,
              bottom: bottom ? 0 : "auto",
            }
          : undefined
      }
    />
  );
}
