import { invoke, isTauri } from "@tauri-apps/api/core";

export interface AdImage { id: string; name: string }
export interface Gallery { items: AdImage[]; selectedId: string | null }
const key = "moyu-gallery";
const native = isTauri();
const changed = () => window.dispatchEvent(new Event("popup-image-changed"));
async function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("moyu-images", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("images");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function imageRecord(id: string, value?: { original: Blob; thumbnail: Blob } | null): Promise<{ original: Blob; thumbnail: Blob } | undefined> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction("images", value === undefined ? "readonly" : "readwrite");
      const store = transaction.objectStore("images");
      const request = value === undefined ? store.get(id) : value === null ? store.delete(id) : store.put(value, id);
      transaction.oncomplete = () => resolve(value === undefined ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
export async function popupGallery(): Promise<Gallery> {
  if (native) return invoke("popup_gallery");
  const saved = localStorage.getItem(key);
  if (saved) return JSON.parse(saved);
  const legacy = localStorage.getItem("moyu-popup-image");
  if (legacy) {
    const original = await (await fetch(legacy)).blob();
    const id = crypto.randomUUID();
    await imageRecord(id, { original, thumbnail: original });
    const gallery = { items: [{ id, name: "原有图片" }], selectedId: null };
    localStorage.setItem(key, JSON.stringify(gallery));
    localStorage.removeItem("moyu-popup-image");
    return gallery;
  }
  return { items: [], selectedId: null };
}
export async function currentGalleryImage(): Promise<Blob | null> {
  const gallery = await popupGallery();
  const id = gallery.selectedId ?? gallery.items[0]?.id;
  return id ? (await imageRecord(id))?.original ?? null : null;
}
export async function galleryThumbnail(id: string): Promise<Blob> {
  if (native) return new Blob([await invoke<ArrayBuffer>("gallery_image", { id })], { type: "image/png" });
  const record = await imageRecord(id);
  if (!record) throw new Error("图片不存在");
  return record.thumbnail;
}
async function validate(file: File): Promise<Blob> {
  if (file.size > 64 * 1024 * 1024) throw new Error(`${file.name} 超过 64 MB`);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url;
    await image.decode().catch(() => { throw new Error(`${file.name} 无法读取，请选择 PNG、JPEG、GIF 或 WebP 图片`); });
    const ratio = Math.min(160 / image.naturalWidth, 110 / image.naturalHeight, 1);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
    canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("缩略图生成失败")), "image/png"));
  } finally { URL.revokeObjectURL(url); }
}
export async function addPopupImages(files: File[]) {
  for (const file of files) {
    const thumbnail = await validate(file);
    if (native) {
      await invoke("add_popup_image", await file.arrayBuffer(), { headers: { "x-image-name": encodeURIComponent(file.name) } });
    } else {
      const gallery = await popupGallery();
      if (gallery.items.length >= 32) throw new Error("最多添加 32 张图片");
      const id = crypto.randomUUID();
      await imageRecord(id, { original: file, thumbnail });
      gallery.items.push({ id, name: file.name });
      localStorage.setItem(key, JSON.stringify(gallery));
      changed();
    }
  }
}
export async function removePopupImage(id: string) {
  if (native) return invoke("remove_popup_image", { id });
  const gallery = await popupGallery();
  gallery.items = gallery.items.filter((image) => image.id !== id);
  if (gallery.selectedId === id) gallery.selectedId = null;
  localStorage.setItem(key, JSON.stringify(gallery));
  await imageRecord(id, null);
  changed();
}
export async function reorderPopupImages(ids: string[]) {
  if (native) return invoke("reorder_popup_images", { ids });
  const gallery = await popupGallery();
  if (new Set(ids).size !== ids.length || ids.length !== gallery.items.length || ids.some((id) => !gallery.items.some((image) => image.id === id))) throw new Error("图片顺序无效");
  gallery.items = ids.map((id) => gallery.items.find((image) => image.id === id)!);
  localStorage.setItem(key, JSON.stringify(gallery));
  changed();
}
export async function clearGallery() {
  if (native) return invoke("reset_popup_image");
  const gallery = await popupGallery();
  localStorage.setItem(key, JSON.stringify({ items: [], selectedId: null }));
  localStorage.removeItem("moyu-popup-image");
  for (const image of gallery.items) await imageRecord(image.id, null);
  changed();
}
export async function replaceGalleryImage(file: File) {
  const previous = (await popupGallery()).items;
  await addPopupImages([file]);
  for (const image of previous) await removePopupImage(image.id);
}
export async function chooseGalleryImage(mode: "random" | "sequential") {
  const gallery = await popupGallery();
  if (!gallery.items.length) return;
  const previous = gallery.items.findIndex((image) => image.id === gallery.selectedId);
  const candidates = gallery.items.length > 1 ? gallery.items.filter((_, index) => index !== previous) : gallery.items;
  gallery.selectedId = mode === "sequential" ? gallery.items[(previous + 1) % gallery.items.length].id : candidates[Math.floor(Math.random() * candidates.length)].id;
  localStorage.setItem(key, JSON.stringify(gallery));
  changed();
}
