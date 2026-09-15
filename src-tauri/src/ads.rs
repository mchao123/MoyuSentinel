use crate::{main_only, reminders::validate_image, Runtime};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Cursor,
    path::{Path, PathBuf},
};
use tauri::{Emitter, Manager, WebviewWindow};
use uuid::Uuid;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Caption { pub title: String, pub text: String }
fn default_caption() -> Caption {
    Caption { title: "好声音，随时随地".into(), text: "今日好物推荐".into() }
}
impl Caption {
    fn validated(self) -> Self {
        Self { title: self.title.chars().take(80).collect(), text: self.text.chars().take(1000).collect() }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdImage {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub caption: Caption,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Gallery {
    pub items: Vec<AdImage>,
    pub selected_id: Option<String>,
    pub default_caption: Caption,
}
impl Default for Gallery {
    fn default() -> Self { Self { items: Vec::new(), selected_id: None, default_caption: default_caption() } }
}

pub struct Library {
    directory: PathBuf,
    gallery: Gallery,
}

impl Library {
    pub fn load(directory: &Path) -> Result<Self, String> {
        let manifest = directory.join("popup-images.json");
        let saved: Option<serde_json::Value> = if manifest.exists() {
            Some(serde_json::from_slice(&fs::read(&manifest).map_err(|e| e.to_string())?).map_err(|e| format!("图片列表读取失败：{e}"))?)
        } else { None };
        let mut library = Self {
            directory: directory.to_path_buf(),
            gallery: if let Some(saved) = &saved {
                serde_json::from_value(saved.clone())
                    .map_err(|e| format!("图片列表读取失败：{e}"))?
            } else {
                Gallery::default()
            },
        };
        if !manifest.exists() {
            for name in ["popup.image", "popup.jpg"] {
                let path = directory.join(name);
                if path.exists() {
                    library.add(
                        &fs::read(path).map_err(|e| e.to_string())?,
                        "原有图片".into(),
                    )?;
                    break;
                }
            }
        }
        // Earlier builds stored one global caption. Move it to the current image
        // once, before the control window saves the new settings schema.
        if saved.as_ref().is_none_or(|value| value.get("defaultCaption").is_none()) {
            let previous = fs::read(directory.join("settings.json")).ok()
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
            if let Some(popup) = previous.as_ref().and_then(|value| value.get("popup")) {
                if popup.get("content").and_then(|value| value.as_str()).is_some_and(|value| ["mixed", "text"].contains(&value)) {
                    let caption = serde_json::from_value::<Caption>(popup.clone()).unwrap_or_default();
                    let id = library.gallery.selected_id.clone().or_else(|| library.gallery.items.first().map(|item| item.id.clone())).unwrap_or_default();
                    library.update_caption(&id, caption)?;
                }
            }
            library.persist(&library.gallery)?;
        }
        Ok(library)
    }
    fn path(&self, id: &str, thumbnail: bool) -> PathBuf {
        self.directory
            .join("popup-images")
            .join(format!("{id}.{}", if thumbnail { "png" } else { "image" }))
    }
    fn persist(&self, gallery: &Gallery) -> Result<(), String> {
        fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
        let temporary = self.directory.join("popup-images.json.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(gallery).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        fs::rename(temporary, self.directory.join("popup-images.json")).map_err(|e| e.to_string())
    }
    pub fn snapshot(&self) -> Gallery {
        self.gallery.clone()
    }
    pub fn read(&self, id: Option<&str>, thumbnail: bool) -> Result<Vec<u8>, String> {
        let id = match id {
            Some(id) => Some(id),
            None => self
                .gallery
                .selected_id
                .as_deref()
                .or_else(|| self.gallery.items.first().map(|item| item.id.as_str())),
        };
        let Some(id) = id else {
            return Ok(Vec::new());
        };
        if !self.gallery.items.iter().any(|item| item.id == id) {
            return Err("图片不存在".into());
        }
        fs::read(self.path(id, thumbnail)).map_err(|e| format!("图片读取失败：{e}"))
    }
    pub fn add(&mut self, bytes: &[u8], name: String) -> Result<(), String> {
        if self.gallery.items.len() >= 32 {
            return Err("最多添加 32 张图片".into());
        }
        validate_image(bytes)?;
        let image = image::ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|e| e.to_string())?
            .decode()
            .map_err(|e| format!("图片解码失败：{e}"))?;
        let mut thumbnail = Cursor::new(Vec::new());
        image
            .thumbnail(160, 110)
            .write_to(&mut thumbnail, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        let id = Uuid::new_v4().to_string();
        fs::create_dir_all(self.directory.join("popup-images")).map_err(|e| e.to_string())?;
        let original = self.path(&id, false);
        let thumb = self.path(&id, true);
        let mut next = self.gallery.clone();
        next.items.push(AdImage {
            id,
            name: name.trim().chars().take(120).collect::<String>(),
            caption: Caption::default(),
        });
        let result = (|| {
            fs::write(&original, bytes).map_err(|e| e.to_string())?;
            fs::write(&thumb, thumbnail.into_inner()).map_err(|e| e.to_string())?;
            self.persist(&next)
        })();
        if result.is_err() {
            let _ = fs::remove_file(original);
            let _ = fs::remove_file(thumb);
        }
        result?;
        self.gallery = next;
        Ok(())
    }
    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        if !self.gallery.items.iter().any(|item| item.id == id) {
            return Err("图片不存在".into());
        }
        let mut next = self.gallery.clone();
        next.items.retain(|item| item.id != id);
        if next.selected_id.as_deref() == Some(id) {
            next.selected_id = None;
        }
        self.persist(&next)?;
        self.gallery = next;
        let _ = fs::remove_file(self.path(id, false));
        let _ = fs::remove_file(self.path(id, true));
        Ok(())
    }
    pub fn update_caption(&mut self, id: &str, caption: Caption) -> Result<(), String> {
        let mut next = self.gallery.clone();
        if id.is_empty() { next.default_caption = caption.validated(); }
        else { next.items.iter_mut().find(|item| item.id == id).ok_or("图片不存在")?.caption = caption.validated(); }
        self.persist(&next)?;
        self.gallery = next;
        Ok(())
    }
    pub fn clear(&mut self) -> Result<(), String> {
        let previous = self.gallery.clone();
        self.persist(&Gallery::default())?;
        self.gallery = Gallery::default();
        for item in previous.items {
            let _ = fs::remove_file(self.path(&item.id, false));
            let _ = fs::remove_file(self.path(&item.id, true));
        }
        for name in ["popup.image", "popup.jpg"] {
            let _ = fs::remove_file(self.directory.join(name));
        }
        Ok(())
    }
    pub fn reorder(&mut self, ids: Vec<String>) -> Result<(), String> {
        let mut unique = std::collections::HashSet::new();
        if ids.len() != self.gallery.items.len()
            || ids.iter().any(|id| {
                !unique.insert(id) || !self.gallery.items.iter().any(|item| &item.id == id)
            })
        {
            return Err("图片顺序无效".into());
        }
        let mut next = self.gallery.clone();
        next.items = ids
            .iter()
            .map(|id| {
                self.gallery
                    .items
                    .iter()
                    .find(|item| &item.id == id)
                    .unwrap()
                    .clone()
            })
            .collect();
        self.persist(&next)?;
        self.gallery = next;
        Ok(())
    }
    pub fn select_next(&mut self, mode: &str, random: u128) -> Result<(), String> {
        let len = self.gallery.items.len();
        if len == 0 {
            return Ok(());
        }
        let previous = self
            .gallery
            .items
            .iter()
            .position(|item| Some(&item.id) == self.gallery.selected_id.as_ref());
        let index = if mode == "sequential" {
            previous.map_or(0, |index| (index + 1) % len)
        } else if len > 1 {
            let candidate = (random % (len - usize::from(previous.is_some())) as u128) as usize;
            candidate + usize::from(previous.is_some_and(|index| candidate >= index))
        } else {
            0
        };
        let mut next = self.gallery.clone();
        next.selected_id = Some(next.items[index].id.clone());
        self.persist(&next)?;
        self.gallery = next;
        Ok(())
    }
}

pub fn notify(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<Runtime>()
        .popup_revision
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    app.emit("popup-image-changed", ())
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn popup_image_revision(
    window: WebviewWindow,
    state: tauri::State<Runtime>,
) -> Result<u64, String> {
    if window.label() != "main" && !window.label().starts_with("popup-") {
        return Err("Image access denied".into());
    }
    Ok(state
        .popup_revision
        .load(std::sync::atomic::Ordering::Relaxed))
}
#[derive(Serialize)]
pub struct ImageState { id: String, caption: Caption, revision: u64 }
#[tauri::command]
pub fn popup_image_state(window: WebviewWindow, state: tauri::State<Runtime>, id: Option<String>) -> Result<ImageState, String> {
    if window.label() != "main" && !window.label().starts_with("popup-") { return Err("Image access denied".into()); }
    let library = state.ads.lock().map_err(|e| e.to_string())?;
    let gallery = &library.gallery;
    let id = id.or_else(|| gallery.selected_id.clone()).or_else(|| gallery.items.first().map(|item| item.id.clone())).unwrap_or_default();
    let caption = if id.is_empty() { gallery.default_caption.clone() }
        else { gallery.items.iter().find(|item| item.id == id).ok_or("图片不存在")?.caption.clone() };
    Ok(ImageState { id, caption, revision: state.popup_revision.load(std::sync::atomic::Ordering::Relaxed) })
}
#[tauri::command]
pub fn update_image_caption(app: tauri::AppHandle, window: WebviewWindow, id: String, caption: Caption) -> Result<(), String> {
    main_only(&window)?;
    app.state::<Runtime>().ads.lock().map_err(|e| e.to_string())?.update_caption(&id, caption)?;
    notify(&app)
}
#[tauri::command]
pub fn popup_ready(
    window: WebviewWindow,
    state: tauri::State<Runtime>,
    revision: u64,
) -> Result<(), String> {
    if !window.label().starts_with("popup-") {
        return Err("Command is restricted to the popup".into());
    }
    state
        .popup_ready
        .lock()
        .unwrap()
        .insert(window.label().to_owned(), revision);
    Ok(())
}
pub fn select_next(app: &tauri::AppHandle, mode: &str) -> Result<(), String> {
    app.state::<Runtime>()
        .ads
        .lock()
        .unwrap()
        .select_next(mode, Uuid::new_v4().as_u128())?;
    notify(app)
}
#[tauri::command]
pub fn popup_gallery(
    window: WebviewWindow,
    state: tauri::State<Runtime>,
) -> Result<Gallery, String> {
    main_only(&window)?;
    Ok(state.ads.lock().unwrap().snapshot())
}
#[tauri::command]
pub fn gallery_image(
    window: WebviewWindow,
    state: tauri::State<Runtime>,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    main_only(&window)?;
    state
        .ads
        .lock()
        .unwrap()
        .read(Some(&id), true)
        .map(tauri::ipc::Response::new)
}
#[tauri::command]
pub async fn add_popup_image(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    main_only(&window)?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("Expected image bytes".into()),
    };
    let name = request
        .headers()
        .get("x-image-name")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image");
    let name = percent_encoding::percent_decode_str(name)
        .decode_utf8_lossy()
        .into_owned();
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        handle
            .state::<Runtime>()
            .ads
            .lock()
            .unwrap()
            .add(&bytes, name)
    })
    .await
    .map_err(|e| e.to_string())??;
    notify(&app)
}
#[tauri::command]
pub fn remove_popup_image(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<(), String> {
    main_only(&window)?;
    app.state::<Runtime>().ads.lock().unwrap().remove(&id)?;
    notify(&app)
}
#[tauri::command]
pub fn reorder_popup_images(
    app: tauri::AppHandle,
    window: WebviewWindow,
    ids: Vec<String>,
) -> Result<(), String> {
    main_only(&window)?;
    app.state::<Runtime>().ads.lock().unwrap().reorder(ids)?;
    notify(&app)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn captions_are_per_image_and_persist_without_changing_original_bytes() {
        let directory = std::env::temp_dir().join(format!("moyu-captions-{}", Uuid::new_v4()));
        let mut library = Library::load(&directory).unwrap();
        let mut bytes = Cursor::new(Vec::new());
        image::RgbImage::new(4, 4).write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        library.add(bytes.get_ref(), "one".into()).unwrap();
        library.add(bytes.get_ref(), "two".into()).unwrap();
        let id = library.snapshot().items[0].id.clone();
        library.update_caption(&id, Caption { title: "First".into(), text: "Caption".into() }).unwrap();
        library.update_caption("", Caption::default()).unwrap();
        let restored = Library::load(&directory).unwrap();
        assert_eq!(restored.snapshot().items[0].caption.text, "Caption");
        assert_eq!(restored.snapshot().items[1].caption.text, "");
        assert_eq!(restored.snapshot().default_caption.title, "");
        assert_eq!(restored.read(Some(&id), false).unwrap(), *bytes.get_ref());
        assert!(library.update_caption("missing", Caption::default()).is_err());
        let legacy: Gallery = serde_json::from_str(r#"{"items":[{"id":"one","name":"one"}],"selectedId":"one"}"#).unwrap();
        assert_eq!(legacy.items[0].caption.text, "");
        assert_eq!(legacy.default_caption.title, default_caption().title);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn global_caption_migrates_once_and_does_not_restore_cleared_text() {
        let directory = std::env::temp_dir().join(format!("moyu-caption-migration-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("settings.json"), br#"{"popup":{"content":"mixed","title":"Saved title","text":"Saved text"}}"#).unwrap();
        let mut library = Library::load(&directory).unwrap();
        assert_eq!(library.snapshot().default_caption.text, "Saved text");
        library.update_caption("", Caption::default()).unwrap();
        assert_eq!(Library::load(&directory).unwrap().snapshot().default_caption.text, "");
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn gallery_preserves_bytes_order_and_selection_across_restarts() {
        let directory = std::env::temp_dir().join(format!("moyu-gallery-{}", Uuid::new_v4()));
        let mut library = Library::load(&directory).unwrap();
        let mut bytes = Cursor::new(Vec::new());
        image::RgbImage::from_pixel(8, 8, image::Rgb([120, 0, 0]))
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        for name in ["first", "second", "third"] {
            library.add(bytes.get_ref(), name.into()).unwrap();
        }
        let ids: Vec<_> = library
            .snapshot()
            .items
            .iter()
            .map(|item| item.id.clone())
            .collect();
        for id in &ids {
            library.select_next("sequential", 0).unwrap();
            assert_eq!(library.snapshot().selected_id.as_ref(), Some(id));
            assert_eq!(library.read(None, false).unwrap(), *bytes.get_ref());
        }
        library.select_next("sequential", 0).unwrap();
        assert_eq!(library.snapshot().selected_id.as_ref(), Some(&ids[0]));
        for seed in 0..20 {
            let previous = library.snapshot().selected_id;
            library.select_next("random", seed).unwrap();
            assert_ne!(library.snapshot().selected_id, previous);
        }
        assert!(library.reorder(vec![ids[0].clone(); 3]).is_err());
        library
            .reorder(ids.iter().rev().cloned().collect())
            .unwrap();
        let restored = Library::load(&directory).unwrap();
        assert_eq!(restored.snapshot().items[0].id, ids[2]);
        assert_eq!(
            restored.snapshot().selected_id,
            library.snapshot().selected_id
        );
        library.clear().unwrap();
        assert!(Library::load(&directory)
            .unwrap()
            .snapshot()
            .items
            .is_empty());
        fs::remove_dir_all(directory).unwrap();
    }
}
