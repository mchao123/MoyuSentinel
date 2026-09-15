use crate::{main_only, Runtime, BROWSER_ARGS};
use serde::Serialize;
use std::{
    io::Cursor,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

#[derive(Default)]
pub struct Snooze {
    until: Option<Instant>,
    epoch_ms: u64,
}
impl Snooze {
    pub fn active(&self, now: Instant) -> bool {
        self.until.is_some_and(|until| now < until)
    }
    fn dismiss(&mut self, now: Instant, minutes: u64) {
        let duration = Duration::from_secs(minutes.clamp(1, 60) * 60);
        self.until = Some(now + duration);
        self.epoch_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
            + duration.as_millis() as u64;
    }
    fn snapshot(&self) -> ReminderState {
        ReminderState {
            snooze_until: if self.active(Instant::now()) {
                self.epoch_ms
            } else {
                0
            },
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderState {
    snooze_until: u64,
}

fn notify(app: &tauri::AppHandle) {
    let state = app.state::<Runtime>();
    if let Ok(snooze) = state.snooze.lock() {
        let _ = app.emit_to("main", "reminder-state", snooze.snapshot());
    };
}
#[tauri::command]
pub fn reminder_state(state: tauri::State<Runtime>) -> Result<ReminderState, String> {
    Ok(state.snooze.lock().map_err(|e| e.to_string())?.snapshot())
}
pub fn dismiss(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<Runtime>();
    let minutes = state.monitor.settings().snooze_minutes;
    state
        .snooze
        .lock()
        .map_err(|e| e.to_string())?
        .dismiss(Instant::now(), minutes);
    if let Ok(mut alert) = state.alert.lock() {
        alert.deadline = None;
    }
    for (label, window) in app.webview_windows() {
        if label.starts_with("popup-") {
            let _ = window.hide();
        }
    }
    notify(app);
    Ok(())
}
#[tauri::command]
pub fn dismiss_popup(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    if !window.label().starts_with("popup-") {
        return Err("Command is restricted to the popup".into());
    }
    dismiss(&app)
}
#[tauri::command]
pub fn resume_reminders(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    *app.state::<Runtime>()
        .snooze
        .lock()
        .map_err(|e| e.to_string())? = Snooze::default();
    notify(&app);
    Ok(())
}

pub fn ensure_popup(app: &tauri::AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("Control window is unavailable")?;
    let monitors = main.available_monitors().map_err(|e| e.to_string())?;
    let state = app.state::<Runtime>();
    for (label, window) in app.webview_windows() {
        if let Some(index) = label
            .strip_prefix("popup-")
            .and_then(|index| index.parse::<usize>().ok())
        {
            if index >= monitors.len() {
                window.destroy().map_err(|e| e.to_string())?;
            }
        }
    }
    for index in 0..monitors.len() {
        let label = format!("popup-{index}");
        if let Some(popup) = app.get_webview_window(&label) {
            place_popup(&popup)?;
            continue;
        }
        let popup = WebviewWindowBuilder::new(
            app,
            label,
            WebviewUrl::App(format!("index.html?popup=1&screen={index}").into()),
        )
        .title("Moyu Sentinel Popup")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .inner_size(360.0, 250.0)
        .data_directory(state.data_dir.join("webview"))
        .additional_browser_args(BROWSER_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
        let handle = app.clone();
        popup.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = dismiss(&handle);
            }
        });
        place_popup(&popup)?;
    }
    Ok(())
}
pub fn place_popup(popup: &WebviewWindow) -> Result<(), String> {
    let index = popup
        .label()
        .strip_prefix("popup-")
        .and_then(|index| index.parse::<usize>().ok())
        .ok_or("Invalid popup monitor")?;
    let monitor = popup
        .available_monitors()
        .map_err(|e| e.to_string())?
        .into_iter()
        .nth(index)
        .ok_or("Popup monitor is unavailable")?;
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let margin = (12.0 * scale) as u32;
    let width = (360.0 * scale) as u32;
    let height = (250.0 * scale) as u32;
    let width = width.min(area.size.width.saturating_sub(margin * 2).max(1));
    let height = height.min(area.size.height.saturating_sub(margin * 2).max(1));
    popup
        .set_position(PhysicalPosition::new(
            area.position.x + area.size.width.saturating_sub(width + margin) as i32,
            area.position.y + area.size.height.saturating_sub(height + margin) as i32,
        ))
        .map_err(|e| e.to_string())?;
    popup
        .set_size(PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn popup_image(
    window: WebviewWindow,
    state: tauri::State<Runtime>,
    id: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    if window.label() != "main" && !window.label().starts_with("popup-") {
        return Err("Image access denied".into());
    }
    let bytes = state.ads.lock().unwrap().read(id.as_deref(), false)?;
    Ok(tauri::ipc::Response::new(bytes))
}

pub(crate) fn validate_image(bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("Image is too large".into());
    }
    let reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    if !matches!(
        reader.format(),
        Some(
            image::ImageFormat::Jpeg
                | image::ImageFormat::Png
                | image::ImageFormat::Gif
                | image::ImageFormat::WebP
        )
    ) {
        return Err("Expected a PNG, JPEG, GIF or WebP image".into());
    }
    let (width, height) = reader.into_dimensions().map_err(|e| e.to_string())?;
    if width == 0 || height == 0 {
        return Err("Image dimensions are empty".into());
    }
    Ok(())
}
#[tauri::command]
pub async fn import_popup_image(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    main_only(&window)?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.clone(),
        _ => return Err("Expected an image binary body".into()),
    };
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<Runtime>();
        let mut library = state.ads.lock().unwrap();
        let previous = library.snapshot().items;
        library.add(&bytes, "提醒图片".into())?;
        for item in previous { library.remove(&item.id)?; }
        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    crate::ads::notify(&app)
}
#[tauri::command]
pub fn reset_popup_image(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    app.state::<Runtime>().ads.lock().unwrap().clear()?;
    crate::ads::notify(&app)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dismissal_expires_and_can_be_resumed() {
        let now = Instant::now();
        let mut snooze = Snooze::default();
        snooze.dismiss(now, 3);
        assert!(snooze.active(now + Duration::from_secs(179)));
        assert!(!snooze.active(now + Duration::from_secs(180)));
        snooze.dismiss(now, 1);
        assert!(!snooze.active(now + Duration::from_secs(60)));
        snooze.dismiss(now, 60);
        assert!(snooze.active(now + Duration::from_secs(3599)));
        snooze = Snooze::default();
        assert!(!snooze.active(now));
    }
    #[test]
    fn imported_images_preserve_large_images_and_animation() {
        assert!(validate_image(b"not an image").is_err());
        let mut bytes = Vec::new();
        image::codecs::jpeg::JpegEncoder::new(&mut bytes)
            .encode_image(&image::RgbImage::new(961, 640))
            .unwrap();
        assert!(validate_image(&bytes).is_ok());
        bytes.clear();
        image::codecs::jpeg::JpegEncoder::new(&mut bytes)
            .encode_image(&image::RgbImage::new(640, 480))
            .unwrap();
        assert!(validate_image(&bytes).is_ok());
        bytes.clear();
        {
            let mut encoder = image::codecs::gif::GifEncoder::new(&mut bytes);
            encoder
                .set_repeat(image::codecs::gif::Repeat::Infinite)
                .unwrap();
            for color in [[255, 0, 0, 255], [0, 255, 0, 255]] {
                encoder
                    .encode_frame(image::Frame::from_parts(
                        image::RgbaImage::from_pixel(2, 2, image::Rgba(color)),
                        0,
                        0,
                        image::Delay::from_numer_denom_ms(200, 1),
                    ))
                    .unwrap();
            }
        }
        let original = bytes.clone();
        assert!(validate_image(&bytes).is_ok());
        assert_eq!(bytes, original);
    }
}
