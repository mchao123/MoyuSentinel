import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ImagePlus, RotateCcw, Trash2 } from "lucide-react";
import { onEvent } from "./bridge";
import { addPopupImages, galleryThumbnail, popupGallery, removePopupImage, reorderPopupImages, clearGallery, updateImageCaption, defaultCaption, type Caption, type Gallery, type AdImage } from "./gallery";
import defaultAd from "./assets/default-ad.jpg";

function Thumbnail({ id }: { id: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    let disposed = false; let current = "";
    void galleryThumbnail(id).then((blob) => {
      if (!disposed) { current = URL.createObjectURL(blob); setUrl(current); }
    }).catch(() => {});
    return () => { disposed = true; if (current) URL.revokeObjectURL(current); };
  }, [id]);
  return url ? <img src={url} alt="提醒图片" /> : <span className="thumbnail-placeholder" />;
}
export function AdGallery({ selection, onSelection, onError, onBusy, onPreview }: {
  selection: "random" | "sequential";
  onSelection: (selection: "random" | "sequential") => void;
  onError: (error: string) => void;
  onBusy: (busy: boolean) => void;
  onPreview: (image?: { id: string; caption: Caption }) => void;
}) {
  const [gallery, setGallery] = useState<Gallery>({ items: [], selectedId: null, defaultCaption });
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
      <button className="icon-button bordered" title="恢复默认图片" aria-label="恢复默认图片" disabled={busy} onClick={() => { onPreview(); void perform(clearGallery); }}><RotateCcw size={16} /></button>
    </div>
    <label className="gallery-mode">图片抽取<select aria-label="图片抽取方式" value={selection} onChange={(event) => onSelection(event.target.value as "random" | "sequential")}><option value="random">随机</option><option value="sequential">顺序</option></select></label>
    <ol className="gallery-list" aria-label="提醒图库" tabIndex={0}>{(gallery.items.length ? gallery.items : [{ id: "", name: "默认耳机广告", caption: gallery.defaultCaption }]).map((image, index) => <li key={image.id} className={image.id === gallery.selectedId ? "selected" : ""}>
      <div className="gallery-image-controls">
      <button className="gallery-preview-button" title="预览图片" aria-label={`预览 ${image.name}`} onClick={() => onPreview(image)}>{image.id ? <Thumbnail id={image.id} /> : <img src={defaultAd} alt="默认耳机广告" />}</button>
      {image.id && <div className="gallery-item-actions">
      <button className="icon-button" title="上移" aria-label={`上移 ${image.name}`} disabled={busy || index === 0} onClick={() => move(index, -1)}><ArrowUp size={13} /></button>
      <button className="icon-button" title="下移" aria-label={`下移 ${image.name}`} disabled={busy || index === gallery.items.length - 1} onClick={() => move(index, 1)}><ArrowDown size={13} /></button>
      <button className="icon-button" title="删除图片" aria-label={`删除 ${image.name}`} disabled={busy} onClick={() => { onPreview(); void perform(() => removePopupImage(image.id)); }}><Trash2 size={13} /></button>
      </div>}
      </div>
      <CaptionEditor image={image} onPreview={onPreview} onError={onError} />
    </li>)}</ol>
  </div>;
}
function CaptionEditor({ image, onPreview, onError }: { image: AdImage; onPreview: (image: { id: string; caption: Caption }) => void; onError: (message: string) => void }) {
  const [caption, setCaption] = useState(image.caption);
  const latest = useRef(caption);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const queue = useRef(Promise.resolve());
  const dirty = useRef(false);
  const writes = useRef(0);
  const save = () => {
    clearTimeout(pending.current);
    if (!dirty.current) return;
    dirty.current = false;
    const value = latest.current;
    writes.current++;
    queue.current = queue.current.then(() => updateImageCaption(image.id, value)).catch((error) => onError(String(error))).finally(() => { writes.current--; });
  };
  useEffect(() => {
    if (!dirty.current && !writes.current) { setCaption(image.caption); latest.current = image.caption; }
  }, [image.caption.title, image.caption.text]);
  useEffect(() => () => save(), [image.id]);
  const change = (key: keyof Caption, value: string) => {
    const next = { ...latest.current, [key]: value };
    latest.current = next; dirty.current = true; setCaption(next); onPreview({ id: image.id, caption: next });
    clearTimeout(pending.current); pending.current = setTimeout(save, 400);
  };
  return <div className="gallery-caption-editor" onFocus={() => onPreview({ id: image.id, caption: latest.current })} onBlur={save}>
    <input aria-label={`${image.name} 标题`} placeholder="标题" maxLength={80} value={caption.title} onChange={(e) => change("title", e.target.value)} />
    <textarea aria-label={`${image.name} 文案`} placeholder="文案" rows={2} maxLength={1000} value={caption.text} onChange={(e) => change("text", e.target.value)} />
  </div>;
}
