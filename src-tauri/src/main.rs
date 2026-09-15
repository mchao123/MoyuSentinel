#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod detection;
mod monitor;
mod reminders;
mod ads;
mod sharing;
mod automation;

use serde::Serialize;
use std::{
    fs,
    path::PathBuf,
    sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Mutex},
    collections::HashMap,
    time::{Duration, Instant},
};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{
    Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";

#[derive(Clone, Serialize, PartialEq)]
struct Glow {
    active: bool,
    intensity: f64,
    width: u32,
    color: String,
}

#[derive(Default)]
struct GlowTransition {
    active: bool,
    hide_at: Option<Instant>,
}
impl GlowTransition {
    fn visible(&mut self, active: bool, now: Instant) -> bool {
        if active {
            self.hide_at = None;
        } else if self.active {
            // Keep the native surface alive beyond the 1000 ms CSS fade-out.
            self.hide_at = Some(now + Duration::from_millis(1200));
        }
        self.active = active;
        active || self.hide_at.is_some_and(|until| now < until)
    }
}

struct Alert {
    deadline: Option<Instant>,
    intensity: f64,
    width: u32,
}
impl Alert {
    fn glow(&self) -> Glow {
        Glow {
            active: self.deadline.is_some_and(|until| until > Instant::now()),
            intensity: self.intensity,
            width: self.width,
            color: "#ff1930".into(),
        }
    }
}

type MonitorGeometry = (i32, i32, u32, u32);
struct Runtime {
    alert: Mutex<Alert>,
    monitors: Mutex<Vec<MonitorGeometry>>,
    data_dir: PathBuf,
    monitor: monitor::Monitor,
    snooze: Mutex<reminders::Snooze>,
    settings_write: Mutex<()>,
    exiting: AtomicBool,
    ads: Mutex<ads::Library>,
    sharing: sharing::Sharing,
    popup_revision: AtomicU64,
    popup_ready: Mutex<HashMap<String, u64>>,
}

#[tauri::command]
async fn list_cameras(window: WebviewWindow) -> Result<Vec<monitor::Device>, String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(monitor::devices)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn start_monitoring(
    app: tauri::AppHandle,
    window: WebviewWindow,
    settings: detection::Settings,
) -> Result<(), String> {
    main_only(&window)?;
    if settings.has_popup() {
        reminders::ensure_popup(&app)?;
    }
    create_overlays(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<Runtime>().monitor.start(app.clone(), settings)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn stop_monitoring(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || app.state::<Runtime>().monitor.stop())
        .await
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn monitor_state(
    window: WebviewWindow,
    state: tauri::State<Runtime>,
) -> Result<monitor::Snapshot, String> {
    main_only(&window)?;
    Ok(state.monitor.snapshot())
}
#[tauri::command]
async fn preview_frame(
    app: tauri::AppHandle,
    window: WebviewWindow,
    device_id: Option<String>,
    restart: Option<bool>,
) -> Result<tauri::ipc::Response, String> {
    main_only(&window)?;
    let visible = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Runtime>();
        state.monitor.preview(
            app.clone(),
            visible,
            device_id.unwrap_or_else(|| state.monitor.settings().device_id),
            restart.unwrap_or(false),
        ).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Command is restricted to the control window".into())
    }
}

#[tauri::command]
fn set_alert(
    window: WebviewWindow,
    state: tauri::State<Runtime>,
    active: bool,
    intensity: f64,
    width: u32,
    test: bool,
) -> Result<(), String> {
    main_only(&window)?;
    if !intensity.is_finite() {
        return Err("Invalid glow intensity".into());
    }
    let mut alert = state.alert.lock().map_err(|e| e.to_string())?;
    alert.intensity = intensity.clamp(0.2, 1.0);
    alert.width = width.clamp(16, 100);
    // An expiring lease clears the native overlay even if the webview stops responding.
    alert.deadline =
        active.then(|| Instant::now() + Duration::from_millis(if test { 3000 } else { 2000 }));
    Ok(())
}

#[tauri::command]
fn overlay_state(state: tauri::State<Runtime>) -> Result<Glow, String> {
    let settings = state.monitor.settings();
    let mut glow = state.alert.lock().map_err(|e| e.to_string())?.glow();
    if state.monitor.reminder_active(settings.edge_hold()) || state.sharing.reminder_active(settings.edge_hold()) {
        glow.active = true;
        glow.intensity = settings.intensity;
        glow.width = settings.edge_width;
    }
    glow.color = settings.glow_color.clone();
    glow.active &= settings.has_edge()
        && !state
            .snooze
            .lock()
            .map_err(|e| e.to_string())?
            .active(Instant::now());
    Ok(glow)
}

fn create_overlays(app: &tauri::AppHandle) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("Control window is unavailable")?;
    let monitors = main.available_monitors().map_err(|e| e.to_string())?;
    let geometry: Vec<MonitorGeometry> = monitors
        .iter()
        .map(|m| {
            (
                m.position().x,
                m.position().y,
                m.size().width,
                m.size().height,
            )
        })
        .collect();
    let state = app.state::<Runtime>();
    let mut previous = state.monitors.lock().map_err(|e| e.to_string())?;
    if *previous == geometry && !geometry.is_empty() {
        return Ok(());
    }
    for (label, window) in app.webview_windows() {
        if label.starts_with("glow-") {
            window.destroy().map_err(|e| e.to_string())?;
        }
    }
    previous.clear();
    for (index, monitor) in monitors.iter().enumerate() {
        // Split the surface so Windows never classifies a glow window as fullscreen.
        let height = monitor.size().height;
        let split = height / 2;
        for (part, offset, slice) in [("top", 0, split), ("bottom", split, height - split)] {
            let window = WebviewWindowBuilder::new(
                app,
                format!("glow-{index}-{part}"),
                WebviewUrl::App(
                    format!("index.html?overlay=1&part={part}&height={height}&slice={slice}")
                        .into(),
                ),
            )
            .title("Moyu Sentinel Alert")
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .focused(false)
            .focusable(false)
            .visible(false)
            .data_directory(state.data_dir.join("webview"))
            .additional_browser_args(BROWSER_ARGS)
            .build()
            .map_err(|e| e.to_string())?;
            window
                .set_ignore_cursor_events(true)
                .map_err(|e| e.to_string())?;
            window
                .set_position(PhysicalPosition::new(
                    monitor.position().x,
                    monitor.position().y + offset as i32,
                ))
                .map_err(|e| e.to_string())?;
            window
                .set_size(PhysicalSize::new(monitor.size().width, slice))
                .map_err(|e| e.to_string())?;
        }
    }
    *previous = geometry;
    Ok(())
}

#[tauri::command]
async fn prepare_overlays(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    create_overlays(&app)
}

#[tauri::command]
fn load_settings(
    window: WebviewWindow,
    state: tauri::State<Runtime>,
) -> Result<serde_json::Value, String> {
    main_only(&window)?;
    let path = state.data_dir.join("settings.json");
    if !path.exists() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())
}

#[tauri::command]
async fn save_settings(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, Runtime>,
    settings: serde_json::Value,
) -> Result<(), String> {
    main_only(&window)?;
    let _write = state.settings_write.lock().map_err(|e| e.to_string())?;
    let validated = serde_json::from_value::<detection::Settings>(settings.clone())
        .map_err(|e| e.to_string())?
        .validated();
    if validated.has_popup() {
        reminders::ensure_popup(&app)?;
    }
    let temporary = state.data_dir.join("settings.json.tmp");
    fs::write(
        &temporary,
        serde_json::to_vec_pretty(&validated).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(temporary, state.data_dir.join("settings.json")).map_err(|e| e.to_string())?;
    state.monitor.update(validated.clone());
    for (label, popup) in app.webview_windows() {
        if label.starts_with("popup-") {
            let _ = popup.emit("popup-settings-changed", &validated.popup);
            reminders::place_popup(&popup)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn hide_to_tray(window: WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    window.hide().map_err(|e| e.to_string())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let executable = std::env::current_exe()?;
            let data_dir = executable.parent().ok_or("Executable directory is unavailable")?.join("MoyuSentinel-data");
            fs::create_dir_all(&data_dir)?;
            app.manage(Runtime {
                alert: Mutex::new(Alert { deadline: None, intensity: 0.7, width: 52 }),
                monitors: Mutex::new(Vec::new()), data_dir: data_dir.clone(), monitor: monitor::Monitor::default(),
                snooze: Mutex::new(reminders::Snooze::default()),
                settings_write: Mutex::new(()),
                exiting: AtomicBool::new(false),
                ads: Mutex::new(ads::Library::load(&data_dir)?),
                sharing: sharing::Sharing::load(&data_dir)?,
                popup_revision: AtomicU64::new(0),
                popup_ready: Mutex::new(HashMap::new()),
            });
            let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Moyu Sentinel - 来人提醒")
                .inner_size(940.0, 650.0).min_inner_size(700.0, 500.0)
                .center().data_directory(data_dir.join("webview"))
                .additional_browser_args(BROWSER_ARGS)
                .build()?;
            if let Ok(bytes) = fs::read(data_dir.join("settings.json")) {
                if let Ok(settings) = serde_json::from_slice::<detection::Settings>(&bytes) {
                    app.state::<Runtime>().monitor.update(settings);
                }
            }
            let share_config = app.state::<Runtime>().sharing.config();
            if share_config.receive_enabled && !share_config.peers.is_empty() {
                create_overlays(app.handle())?;
                if app.state::<Runtime>().monitor.settings().has_popup() { reminders::ensure_popup(app.handle())?; }
            }
            sharing::start(app.handle().clone());
            let handle = app.handle().clone();
            main.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(window) = handle.get_webview_window("main") { let _ = window.hide(); }
                }
            });
            let show = MenuItem::with_id(app, "show", "打开控制台", true, None::<&str>)?;
            let monitor_action = MenuItem::with_id(app, "toggle-monitoring", "开始检测", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &monitor_action, &quit])?;
            TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))?)
                .tooltip("Moyu Sentinel - 来人提醒")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "toggle-monitoring" => {
                        let app = app.clone();
                        if app.state::<Runtime>().monitor.snapshot().phase == "idle" {
                            if let Some(window) = app.get_webview_window("main") {
                                let settings = app.state::<Runtime>().monitor.settings();
                                tauri::async_runtime::spawn(async move {
                                    if let Err(error) = start_monitoring(app.clone(), window, settings).await {
                                        let _ = app.emit_to("main", "monitor-error", error);
                                        show_main(&app);
                                    }
                                });
                            }
                        } else {
                            tauri::async_runtime::spawn_blocking(move || {
                                app.state::<Runtime>().monitor.stop();
                                if let Ok(mut alert) = app.state::<Runtime>().alert.lock() { alert.deadline = None; }
                                let _ = app.emit_to("main", "stop-monitoring", ());
                            });
                        }
                    },
                    "quit" => app.state::<Runtime>().exiting.store(true, Ordering::Relaxed),
                    _ => {},
                }).build(app)?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
              let mut control_visible = None;
              let mut previous_glow = None;
              let mut glow_transition = GlowTransition::default();
              let mut previous_monitor_action = "";
              let mut previous_popup_active = false;
              let mut previous_popup_event = (0, 0);
              let mut action_gate = automation::ActionGate::default();
              loop {
                std::thread::sleep(Duration::from_millis(350));
                let visible = handle.get_webview_window("main").is_some_and(|window| window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true));
                if control_visible != Some(visible) { control_visible = Some(visible); let _ = handle.emit_to("main", "control-visible", visible); }
                let state = handle.state::<Runtime>();
                let phase = state.monitor.snapshot().phase;
                let action_text = match phase.as_str() {
                    "idle" => "开始检测",
                    "loading" => "取消连接",
                    _ => "停止检测",
                };
                if previous_monitor_action != action_text {
                    if monitor_action.set_text(action_text).is_ok() { previous_monitor_action = action_text; }
                }
                let settings = state.monitor.settings();
                // A reminder is a notification event, independent of whether its
                // source is the local camera or a remote shared device.
                let local_alert = match state.alert.lock() {
                    Ok(alert) => alert.glow(),
                    Err(_) => continue,
                };
                let local_source_active = state.monitor.active() || local_alert.active;
                let remote_source_active = state.sharing.active();
                let snoozed = state.snooze.lock().map(|snooze| snooze.active(Instant::now())).unwrap_or(true);
                let edge_active = (local_alert.active || state.monitor.reminder_active(settings.edge_hold()) || state.sharing.reminder_active(settings.edge_hold())) && !snoozed;
                let popup_reminder_active = (local_alert.active || state.monitor.reminder_active(settings.popup_hold()) || state.sharing.reminder_active(settings.popup_hold())) && !snoozed;
                let mut glow = local_alert.clone();
                glow.active = edge_active;
                if remote_source_active && !local_source_active {
                    glow.intensity = settings.intensity;
                    glow.width = settings.edge_width;
                }
                glow.color = settings.glow_color.clone();
                if snoozed { glow.active = false; }
                let exiting = state.exiting.load(Ordering::Relaxed);
                glow.active &= !exiting;
                let popup_active = popup_reminder_active && settings.has_popup() && !exiting;
                let popup_event = (state.monitor.snapshot().alert_event, state.sharing.event_count.load(Ordering::Relaxed));
                if popup_active && (!previous_popup_active || popup_event != previous_popup_event) {
                    if let Err(error) = ads::select_next(&handle, &settings.image_selection) {
                        let _ = handle.emit_to("main", "monitor-error", error);
                    }
                }
                previous_popup_active = popup_active;
                previous_popup_event = popup_event;
                glow.active &= settings.has_edge();
                // Preview leases never launch applications. Suppressed detections are
                // consumed so resuming reminders cannot replay an old window action.
                if action_gate.update(state.monitor.active() || remote_source_active, popup_event, snoozed || exiting) {
                    let actions = settings.actions.clone();
                    let app = handle.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        let state = app.state::<Runtime>();
                        if state.exiting.load(Ordering::Relaxed) || state.snooze.lock().map(|s| s.active(Instant::now())).unwrap_or(true) { return; }
                        if let Err(error) = automation::execute(&actions) { let _ = app.emit_to("main", "monitor-error", error); }
                    });
                }
                let keep_glow_visible = glow_transition.visible(glow.active, Instant::now());
                let changed = previous_glow.as_ref() != Some(&glow);
                previous_glow = Some(glow.clone());
                for (label, window) in handle.webview_windows() {
                    if label.starts_with("popup-") {
                        let ready = state.popup_ready.lock().unwrap().get(&label).copied() == Some(state.popup_revision.load(Ordering::Relaxed));
                        if popup_active && ready && !window.is_visible().unwrap_or(false) {
                            if reminders::place_popup(&window).is_ok() { let _ = window.show(); }
                        } else if !popup_active && window.is_visible().unwrap_or(false) { let _ = window.hide(); }
                        continue;
                    }
                    if !label.starts_with("glow-") { continue; }
                    if glow.active {
                        let showing = !window.is_visible().unwrap_or(false);
                        if showing { let _ = window.show(); }
                        if changed || showing { let _ = window.emit("glow", &glow); }
                    } else {
                        if changed { let _ = window.emit("glow", &glow); }
                        if !keep_glow_visible && window.is_visible().unwrap_or(false) { let _ = window.hide(); }
                    }
                }
                if exiting && !keep_glow_visible { handle.exit(0); break; }
              }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![set_alert, overlay_state, prepare_overlays, load_settings, save_settings, hide_to_tray, list_cameras, start_monitoring, stop_monitoring, monitor_state, preview_frame, reminders::reminder_state, reminders::dismiss_popup, reminders::resume_reminders, reminders::popup_image, reminders::popup_settings, reminders::import_popup_image, reminders::reset_popup_image, ads::popup_gallery, ads::gallery_image, ads::add_popup_image, ads::remove_popup_image, ads::reorder_popup_images, ads::popup_image_revision, ads::popup_ready, ads::popup_image_state, ads::update_image_caption, sharing::sharing_state, sharing::save_sharing, automation::list_target_windows, automation::test_actions])
        .run(tauri::generate_context!())
        .expect("Failed to start Moyu Sentinel. Put the portable app in a writable folder and ensure Microsoft Edge WebView2 is installed.");
}

#[cfg(test)]
mod glow_tests {
    use super::*;

    #[test]
    fn dismissal_keeps_the_surface_until_animation_finishes() {
        let mut transition = GlowTransition::default();
        let now = Instant::now();
        assert!(!transition.visible(false, now));
        assert!(transition.visible(true, now));
        assert!(transition.visible(false, now));
        assert!(transition.visible(false, now + Duration::from_millis(1000)));
        assert!(!transition.visible(false, now + Duration::from_millis(1200)));
    }

    #[test]
    fn reactivation_cancels_the_pending_hide() {
        let mut transition = GlowTransition::default();
        let now = Instant::now();
        assert!(transition.visible(true, now));
        assert!(transition.visible(false, now));
        assert!(transition.visible(true, now + Duration::from_millis(200)));
        assert!(transition.visible(true, now + Duration::from_millis(1500)));
        assert!(transition.visible(false, now + Duration::from_millis(1600)));
        assert!(transition.visible(false, now + Duration::from_millis(2600)));
        assert!(!transition.visible(false, now + Duration::from_millis(2800)));
    }
}
