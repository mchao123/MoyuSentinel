use crate::{main_only, Runtime, BROWSER_ARGS};
use serde::{Deserialize, Serialize};
use std::{
    io::Cursor,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PopupOptions {
    pub hold_seconds: Option<f64>,
    pub width: u32,
    pub height: u32,
    pub opacity: f64,
    pub position: String,
    pub margin: u32,
    pub font_size: u32,
    pub text_color: String,
    pub background_color: String,
}
impl Default for PopupOptions {
    fn default() -> Self {
        Self { hold_seconds: None,
            width: 360, height: 250, opacity: 1.0, position: "bottom-right".into(), margin: 12,
            font_size: 15, text_color: "#32353b".into(), background_color: "#ffffff".into() }
    }
}
impl PopupOptions {
    pub fn validated(mut self) -> Self {
        if !["top-left", "top-right", "bottom-left", "bottom-right", "center"].contains(&self.position.as_str()) { self.position = "bottom-right".into(); }
        self.width = self.width.clamp(180, 1200);
        self.height = self.height.clamp(120, 900);
        self.opacity = if self.opacity.is_finite() { self.opacity.clamp(0.2, 1.0) } else { 1.0 };
        self.margin = self.margin.min(200);
        self.font_size = self.font_size.clamp(12, 48);
        let color = |value: &str| value.len() == 7 && value.starts_with('#') && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit);
        if !color(&self.text_color) { self.text_color = "#32353b".into(); }
        if !color(&self.background_color) { self.background_color = "#ffffff".into(); }
        self
    }
    fn geometry(&self, area: (i32, i32, u32, u32), scale: f64) -> (i32, i32, u32, u32) {
        let (x, y, available_width, available_height) = area;
        let margin_x = ((self.margin as f64 * scale) as u32).min(available_width.saturating_sub((180.0 * scale) as u32) / 2);
        let margin_y = ((self.margin as f64 * scale) as u32).min(available_height.saturating_sub((120.0 * scale) as u32) / 2);
        let width = ((self.width as f64 * scale) as u32).min(available_width.saturating_sub(2 * margin_x).max(1));
        let height = ((self.height as f64 * scale) as u32).min(available_height.saturating_sub(2 * margin_y).max(1));
        let left = if self.position == "center" { available_width.saturating_sub(width) / 2 }
            else if self.position.ends_with("left") { margin_x } else { available_width.saturating_sub(width + margin_x) };
        let top = if self.position == "center" { available_height.saturating_sub(height) / 2 }
            else if self.position.starts_with("top") { margin_y } else { available_height.saturating_sub(height + margin_y) };
        (x + left as i32, y + top as i32, width, height)
    }
}
#[tauri::command]
pub fn popup_settings(window: WebviewWindow, state: tauri::State<Runtime>) -> Result<PopupOptions, String> {
    if window.label() != "main" && !window.label().starts_with("popup-") { return Err("Popup access denied".into()); }
    Ok(state.monitor.settings().popup)
}

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
    let options = popup.app_handle().state::<Runtime>().monitor.settings().popup;
    let (x, y, width, height) = options.geometry((area.position.x, area.position.y, area.size.width, area.size.height), scale);
    popup
        .set_position(PhysicalPosition::new(
            x,
            y,
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
    fn legacy_and_combined_settings_survive_deserialization() {
        let legacy: crate::detection::Settings = serde_json::from_str(r##"{"alertMode":"popup","glowColor":"#00ff80"}"##).unwrap();
        let legacy = legacy.validated();
        assert!(legacy.has_popup() && !legacy.has_edge());
        assert_eq!(legacy.popup.width, 360);
        assert_eq!(legacy.popup.hold_seconds, Some(3.0));
        assert!(!legacy.actions.open_url && !legacy.actions.focus_window);
        let mixed: crate::detection::Settings = serde_json::from_str(r##"{"alertMode":"mixed","popup":{"content":"text","width":5000,"height":1,"opacity":9,"position":"bad","textColor":"bad"}}"##).unwrap();
        let mixed = mixed.validated();
        assert!(mixed.has_popup() && mixed.has_edge());
        assert_eq!(mixed.popup.width, 1200);
        assert_eq!(mixed.popup.height, 120);
        assert_eq!(mixed.popup.opacity, 1.0);
        assert_eq!(mixed.popup.position, "bottom-right");
        assert_eq!(mixed.popup.text_color, "#32353b");
    }
    #[test]
    fn popup_positions_stay_in_each_monitors_work_area() {
        let mut options = PopupOptions::default();
        assert_eq!(options.geometry((-1920, 0, 1920, 1040), 1.0), (-372, 778, 360, 250));
        options.position = "top-left".into();
        assert_eq!(options.geometry((-1920, -500, 1920, 1040), 1.5), (-1902, -482, 540, 375));
        options.position = "center".into();
        assert_eq!(options.geometry((0, 0, 1000, 800), 1.0), (320, 275, 360, 250));
        options.margin = 200;
        for position in ["top-left", "top-right", "bottom-left", "bottom-right", "center"] {
            options.position = position.into();
            let (x, y, width, height) = options.geometry((0, 0, 200, 100), 2.0);
            assert!(x >= 0 && y >= 0 && x as u32 + width <= 200 && y as u32 + height <= 100);
            assert_eq!((width, height), (200, 100));
        }
    }
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
