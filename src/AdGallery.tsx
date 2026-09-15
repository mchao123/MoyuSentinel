import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, RotateCcw, Trash2 } from "lucide-react";
import { onEvent } from "./bridge";
import { addPopupImages, galleryThumbnail, popupGallery, removePopupImage, reorderPopupImages, clearGallery, type Gallery } from "./gallery";

function Thumbnail({ id, name }: { id: string; name: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let disposed = false; let current = "";
    void galleryThumbnail(id).then((blob) => {
      if (!disposed) { current = URL.createObjectURL(blob); setUrl(current); }
    }).catch(() => {});
    return () => { disposed = true; if (current) URL.revokeObjectURL(current); };
  }, [id]);
  return url ? <img src={url} alt={name} /> : <span className="thumbnail-placeholder" />;
}
export function AdGallery({ selection, onSelection, onError, onBusy }: {
  selection: "random" | "sequential";
  onSelection: (selection: "random" | "sequential") => void;
  onError: (error: string) => void;
  onBusy: (busy: boolean) => void;
}) {
  const [gallery, setGallery] = useState<Gallery>({ items: [], selectedId: null });
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let disposed = false;
    const refresh = () => { void popupGallery().then((value) => { if (!disposed) setGallery(value); }).catch((error) => { if (!disposed) onError(String(error)); }); };
    const listener = onEvent("popup-image-changed", refresh);
    window.addEventListener("popup-image-changed", refresh);
    refresh();
    return () => { disposed = true; window.removeEventListener("popup-image-changed", refresh); void listener.then((unlisten) => unlisten()); };
  }, [onError]);
  async function perform(action: () => Promise<unknown>) {
    setBusy(true); onBusy(true);
    try { await action(); setGallery(await popupGallery()); }
    catch (error) { onError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); onBusy(false); }
  }
  function move(index: number, delta: number) {
    const ids = gallery.items.map((image) => image.id);
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    void perform(() => reorderPopupImages(ids));
  }
  return <div className="ad-gallery">
    <div className="image-actions">
      <input ref={input} type="file" multiple accept="image/png,image/jpeg,image/gif,image/webp" aria-label="选择提醒图片" hidden onChange={(event) => {
        const files = Array.from(event.target.files ?? []); event.target.value = "";
        if (files.length) void perform(() => addPopupImages(files));
      }} />
      <button className="image-upload" disabled={busy || gallery.items.length >= 32} onClick={() => input.current?.click()}><ImagePlus size={15} />{busy ? "正在导入" : "添加图片"}<span>{gallery.items.length}/32</span></button>
      <button className="icon-button bordered" title="恢复默认图片" aria-label="恢复默认图片" disabled={busy || !gallery.items.length} onClick={() => void perform(clearGallery)}><RotateCcw size={16} /></button>
    </div>
    <label className="gallery-mode">图片抽取<select aria-label="图片抽取方式" value={selection} onChange={(event) => onSelection(event.target.value as "random" | "sequential")}><option value="random">随机</option><option value="sequential">顺序</option></select></label>
    <ol className="gallery-list" aria-label="提醒图库" tabIndex={0}>{gallery.items.map((image, index) => <li key={image.id} className={image.id === gallery.selectedId ? "selected" : ""}>
      <Thumbnail id={image.id} name={image.name} /><span className="gallery-name" title={image.name}>{image.name}</span>
      <button className="icon-button" title="上移" aria-label={`上移 ${image.name}`} disabled={busy || index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
      <button className="icon-button" title="下移" aria-label={`下移 ${image.name}`} disabled={busy || index === gallery.items.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
      <button className="icon-button" title="删除图片" aria-label={`删除 ${image.name}`} disabled={busy} onClick={() => void perform(() => removePopupImage(image.id))}><Trash2 size={13} /></button>
    </li>)}</ol>
  </div>;
}
