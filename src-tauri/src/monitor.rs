use crate::detection::{AlertGate, Detector, Person, Settings};
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, RgbImage};
use nokhwa::{
    pixel_format::RgbFormat,
    utils::{ApiBackend, CameraIndex, FrameFormat, RequestedFormat, RequestedFormatType},
    Buffer, Camera,
};
use serde::Serialize;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub device_id: String,
    pub label: String,
}
pub fn devices() -> Result<Vec<Device>, String> {
    nokhwa::query(ApiBackend::MediaFoundation)
        .map_err(|e| e.to_string())
        .map(|list| {
            list.into_iter()
                .map(|info| Device {
                    device_id: info.index().to_string(),
                    label: info.human_name(),
                })
                .collect()
        })
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub phase: String,
    pub error: Option<String>,
    pub people: Vec<Person>,
    pub latency: u64,
    pub width: u32,
    pub height: u32,
    pub camera_fps: u32,
    pub inference_count: u64,
    pub preview_count: u64,
    pub preview_bytes: usize,
    pub alert_event: u64,
    pub alert_people: usize,
    pub alert_at: u64,
    pub present: bool,
}
struct Captured {
    sequence: u64,
    at: Instant,
    buffer: Buffer,
}
struct Shared {
    running: AtomicBool,
    // Odd generations enable inference; every toggle invalidates in-flight results.
    detection_generation: AtomicU64,
    settings: Mutex<Settings>,
    snapshot: Mutex<Snapshot>,
    latest: Mutex<Option<Captured>>,
    jpeg: Mutex<Vec<u8>>,
    preview_requested: Mutex<Option<Instant>>,
    confirmed_at: Mutex<Option<Instant>>,
}
pub struct Monitor {
    shared: Arc<Shared>,
    worker: Mutex<Option<Worker>>,
}
struct Worker {
    handle: JoinHandle<()>,
    device_id: String,
}
#[cfg(test)]
mod reminder_tests {
    use super::*;
    #[test]
    fn local_reminders_have_independent_holds_and_stop_with_detection() {
        let monitor = Monitor::default();
        monitor.shared.running.store(true, Ordering::Relaxed);
        monitor.shared.snapshot.lock().unwrap().phase = "alert".into();
        *monitor.shared.confirmed_at.lock().unwrap() = Some(Instant::now() - Duration::from_secs(4));
        assert!(!monitor.reminder_active(2.0));
        assert!(monitor.reminder_active(8.0));
        monitor.shared.snapshot.lock().unwrap().phase = "idle".into();
        assert!(!monitor.reminder_active(8.0));
        monitor.shared.snapshot.lock().unwrap().phase = "alert".into();
        monitor.shared.running.store(false, Ordering::Relaxed);
        assert!(!monitor.reminder_active(8.0));
    }
}
impl Default for Monitor {
    fn default() -> Self {
        Self {
            shared: Arc::new(Shared {
                running: AtomicBool::new(false),
                detection_generation: AtomicU64::new(0),
                settings: Mutex::new(Settings::default()),
                snapshot: Mutex::new(Snapshot {
                    phase: "idle".into(),
                    ..Snapshot::default()
                }),
                latest: Mutex::new(None),
                jpeg: Mutex::new(Vec::new()),
                preview_requested: Mutex::new(None),
                confirmed_at: Mutex::new(None),
            }),
            worker: Mutex::new(None),
        }
    }
}
impl Monitor {
    pub fn snapshot(&self) -> Snapshot {
        self.shared.snapshot.lock().unwrap().clone()
    }
    pub fn update(&self, settings: Settings) {
        *self.shared.settings.lock().unwrap() = settings.validated();
    }
    pub fn settings(&self) -> Settings {
        self.shared.settings.lock().unwrap().clone()
    }
    pub fn active(&self) -> bool {
        self.shared.running.load(Ordering::Relaxed) && self.snapshot().phase == "alert"
    }
    pub fn reminder_active(&self, hold_seconds: f64) -> bool {
        self.active() && self.shared.confirmed_at.lock().unwrap().is_some_and(|at|
            Instant::now().duration_since(at) < Duration::from_secs_f64(hold_seconds))
    }
    pub fn start(&self, app: tauri::AppHandle, settings: Settings) -> Result<(), String> {
        let mut worker = self.worker.lock().map_err(|e| e.to_string())?;
        self.update(settings.clone());
        let mut snapshot = self.shared.snapshot.lock().unwrap();
        let reuse = self.shared.running.load(Ordering::Relaxed)
            && worker.as_ref().is_some_and(|worker| {
                !worker.handle.is_finished() && worker.device_id == settings.device_id
            });
        if !reuse {
            self.shared.running.store(false, Ordering::Relaxed);
            drop(snapshot);
            if let Some(worker) = worker.take() {
                let _ = worker.handle.join();
            }
            snapshot = self.shared.snapshot.lock().unwrap();
        }
        let generation = self.shared.detection_generation.load(Ordering::Relaxed);
        if generation % 2 == 0 {
            self.shared
                .detection_generation
                .store(generation + 1, Ordering::Relaxed);
        }
        snapshot.phase = "loading".into();
        snapshot.error = None;
        drop(snapshot);
        if !reuse {
            *worker = Some(self.spawn(app.clone(), settings.device_id));
        }
        let _ = app.emit_to("main", "monitor-state", self.snapshot());
        Ok(())
    }
    fn spawn(&self, app: tauri::AppHandle, device_id: String) -> Worker {
        *self.shared.confirmed_at.lock().unwrap() = None;
        *self.shared.latest.lock().unwrap() = None;
        self.shared.jpeg.lock().unwrap().clear();
        let event = self.snapshot().alert_event;
        *self.shared.snapshot.lock().unwrap() = Snapshot {
            phase: if self.shared.detection_generation.load(Ordering::Relaxed) % 2 == 1 {
                "loading"
            } else {
                "idle"
            }
            .into(),
            alert_event: event,
            ..Snapshot::default()
        };
        self.shared.running.store(true, Ordering::Relaxed);
        let shared = self.shared.clone();
        let camera_id = device_id.clone();
        let handle = thread::spawn(move || {
            if let Err(error) = pipeline(&app, &shared, camera_id) {
                fail(&shared, error);
            }
            shared.running.store(false, Ordering::Relaxed);
            shared.jpeg.lock().unwrap().clear();
            shared.latest.lock().unwrap().take();
            let mut snapshot = shared.snapshot.lock().unwrap();
            snapshot.phase = "idle".into();
            snapshot.people.clear();
            let _ = app.emit_to("main", "monitor-state", snapshot.clone());
        });
        Worker { handle, device_id }
    }
    pub fn stop(&self) {
        let _worker = self.worker.lock().unwrap();
        let mut snapshot = self.shared.snapshot.lock().unwrap();
        let generation = self.shared.detection_generation.load(Ordering::Relaxed);
        if generation % 2 == 1 {
            self.shared
                .detection_generation
                .store(generation + 1, Ordering::Relaxed);
        }
        snapshot.phase = "idle".into();
        snapshot.people.clear();
        snapshot.latency = 0;
    }
    pub fn preview(
        &self,
        app: tauri::AppHandle,
        visible: bool,
        device_id: String,
        restart: bool,
    ) -> Result<Vec<u8>, String> {
        if !visible {
            return Ok(Vec::new());
        }
        let mut worker = self.worker.lock().map_err(|e| e.to_string())?;
        if restart {
            self.shared.snapshot.lock().unwrap().error = None;
        }
        *self.shared.preview_requested.lock().unwrap() = Some(Instant::now());
        let detecting = self.shared.detection_generation.load(Ordering::Relaxed) % 2 == 1;
        if worker
            .as_ref()
            .is_some_and(|worker| !worker.handle.is_finished())
        {
            if !detecting && worker.as_ref().unwrap().device_id != device_id {
                self.shared.running.store(false, Ordering::Relaxed);
            }
            return Ok(if self.shared.running.load(Ordering::Relaxed) {
                self.shared.jpeg.lock().unwrap().clone()
            } else {
                Vec::new()
            });
        }
        if let Some(worker) = worker.take() {
            let _ = worker.handle.join();
            if worker.device_id != device_id {
                self.shared.snapshot.lock().unwrap().error = None;
            }
        }
        if let Some(error) = self.snapshot().error {
            return Err(error);
        }
        *worker = Some(self.spawn(app, device_id));
        Ok(Vec::new())
    }
}
fn fail(shared: &Shared, error: String) {
    shared.running.store(false, Ordering::Relaxed);
    let mut snapshot = shared.snapshot.lock().unwrap();
    let generation = shared.detection_generation.load(Ordering::Relaxed);
    if generation % 2 == 1 {
        shared
            .detection_generation
            .store(generation + 1, Ordering::Relaxed);
    }
    snapshot.error = Some(error);
    snapshot.phase = "idle".into();
    snapshot.people.clear();
}
fn capture(shared: &Shared, device_id: String) -> Result<(), String> {
    let index = if device_id.is_empty() {
        CameraIndex::Index(0)
    } else if let Ok(index) = device_id.parse::<u32>() {
        CameraIndex::Index(index)
    } else {
        CameraIndex::String(device_id)
    };
    // Select an advertised native mode near VGA/30 fps, including non-MJPEG cameras.
    let request = RequestedFormat::new::<RgbFormat>(RequestedFormatType::None);
    let mut camera = Camera::with_backend(index, request, ApiBackend::MediaFoundation)
        .map_err(|e| format!("摄像头连接失败：{e}"))?;
    let mut formats = camera
        .compatible_camera_formats()
        .map_err(|e| e.to_string())?;
    formats.sort_by_key(|format| {
        (
            format.width().abs_diff(640) + format.height().abs_diff(480),
            format.format() != FrameFormat::MJPEG,
            format.frame_rate().abs_diff(30),
        )
    });
    if let Some(format) = formats.first() {
        camera
            .set_camera_requset(RequestedFormat::new::<RgbFormat>(
                RequestedFormatType::Exact(*format),
            ))
            .map_err(|e| e.to_string())?;
    }
    camera
        .open_stream()
        .map_err(|e| format!("摄像头启动失败：{e}"))?;
    let format = camera.camera_format();
    {
        let mut snapshot = shared.snapshot.lock().unwrap();
        snapshot.width = format.width();
        snapshot.height = format.height();
    }
    let mut sequence = 0;
    let mut rate_started = Instant::now();
    let mut rate_frames = 0;
    while shared.running.load(Ordering::Relaxed) {
        let bytes = camera
            .frame_raw()
            .map_err(|e| format!("摄像头读取失败：{e}"))?;
        sequence += 1;
        rate_frames += 1;
        if rate_started.elapsed() >= Duration::from_secs(1) {
            shared.snapshot.lock().unwrap().camera_fps =
                (rate_frames as f64 / rate_started.elapsed().as_secs_f64()).round() as u32;
            rate_started = Instant::now();
            rate_frames = 0;
        }
        let frame = Captured {
            sequence,
            at: Instant::now(),
            buffer: Buffer::new(format.resolution(), &bytes, format.format()),
        };
        *shared.latest.lock().unwrap() = Some(frame);
    }
    let _ = camera.stop_stream();
    Ok(())
}
fn decode(buffer: &Buffer) -> Result<RgbImage, String> {
    if buffer.source_frame_format() == FrameFormat::MJPEG {
        image::load_from_memory_with_format(buffer.buffer(), image::ImageFormat::Jpeg)
            .map(|image| image.to_rgb8())
            .map_err(|e| e.to_string())
    } else {
        buffer
            .decode_image::<RgbFormat>()
            .map_err(|e| e.to_string())
    }
}
fn pipeline(app: &tauri::AppHandle, shared: &Arc<Shared>, device_id: String) -> Result<(), String> {
    if !shared.running.load(Ordering::Relaxed) {
        return Ok(());
    }
    let captured = shared.clone();
    let capture_worker = thread::spawn(move || {
        if let Err(error) = capture(&captured, device_id) {
            fail(&captured, error);
        }
    });
    let result = process(app, shared);
    if let Err(error) = &result {
        fail(shared, error.clone());
        let _ = app.emit_to(
            "main",
            "monitor-state",
            shared.snapshot.lock().unwrap().clone(),
        );
    }
    shared.running.store(false, Ordering::Relaxed);
    // Keep ownership until the device releases, preventing concurrent open attempts.
    let _ = capture_worker.join();
    result
}
fn process(app: &tauri::AppHandle, shared: &Arc<Shared>) -> Result<(), String> {
    let mut detector = None;
    let mut generation = 0;
    let started = Instant::now();
    let mut last_detection: Option<Instant> = None;
    let mut last_preview = Instant::now() - Duration::from_secs(1);
    let mut last_sequence = 0;
    let mut gate = AlertGate::default();
    while shared.running.load(Ordering::Relaxed) {
        let now = Instant::now();
        let settings = shared.settings.lock().unwrap().clone();
        let next_generation = shared.detection_generation.load(Ordering::Relaxed);
        if generation != next_generation {
            generation = next_generation;
            gate = AlertGate::default();
            *shared.confirmed_at.lock().unwrap() = None;
            last_detection = None;
        }
        let detecting = generation % 2 == 1;
        let infer_due = detecting
            && last_detection.is_none_or(|last| {
                now.duration_since(last) >= Duration::from_millis(settings.detection_interval_ms)
            });
        let visible = app.get_webview_window("main").is_some_and(|window| {
            window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true)
        });
        let wants_preview = visible
            && shared
                .preview_requested
                .lock()
                .unwrap()
                .is_some_and(|last| now.duration_since(last) < Duration::from_millis(400));
        let preview_due =
            wants_preview && now.duration_since(last_preview) >= Duration::from_millis(100);
        let mut snapshot = shared.snapshot.lock().unwrap();
        if !wants_preview
            && !detecting
            && shared.detection_generation.load(Ordering::Relaxed) == generation
        {
            shared.running.store(false, Ordering::Relaxed);
            break;
        }
        if snapshot.phase == "alert" && !gate.active(now) {
            snapshot.phase = "watching".into();
            let _ = app.emit_to("main", "monitor-state", snapshot.clone());
        }
        drop(snapshot);
        let frame = {
            let latest = shared.latest.lock().unwrap();
            if latest.as_ref().map_or(
                now.duration_since(started) > Duration::from_secs(15),
                |frame| now.duration_since(frame.at) > Duration::from_secs(5),
            ) {
                return Err("摄像头未返回画面，请检查设备连接或占用情况。".into());
            }
            latest
                .as_ref()
                .filter(|frame| frame.sequence != last_sequence && (infer_due || preview_due))
                .map(|frame| (frame.sequence, frame.buffer.clone()))
        };
        if let Some((sequence, buffer)) = frame {
            last_sequence = sequence;
            let image = decode(&buffer)?;
            if infer_due {
                if detector.is_none() {
                    detector =
                        Some(Detector::new().map_err(|e| format!("本地检测模型加载失败：{e}"))?);
                }
                let inference_started = Instant::now();
                let people = detector.as_mut().unwrap().detect(&image, &settings)?;
                let active = gate.update(
                    people.len() >= settings.min_people,
                    Instant::now(),
                    &settings,
                );
                last_detection = Some(Instant::now());
                let mut snapshot = shared.snapshot.lock().unwrap();
                if !shared.running.load(Ordering::Relaxed)
                    || shared.detection_generation.load(Ordering::Relaxed) != generation
                {
                    continue;
                }
                if active && snapshot.phase != "alert" {
                    snapshot.alert_event += 1;
                    snapshot.alert_people = people.len();
                    snapshot.alert_at = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                }
                snapshot.people = people;
                snapshot.present = gate.confirmed_at().is_some_and(|at| Some(at) != *shared.confirmed_at.lock().unwrap());
                *shared.confirmed_at.lock().unwrap() = gate.confirmed_at();
                snapshot.latency = inference_started.elapsed().as_millis() as u64;
                snapshot.inference_count += 1;
                snapshot.phase = if active { "alert" } else { "watching" }.into();
                let _ = app.emit_to("main", "monitor-state", snapshot.clone());
            }
            if preview_due && shared.running.load(Ordering::Relaxed) {
                let ratio = (640.0 / image.width() as f32)
                    .min(480.0 / image.height() as f32)
                    .min(1.0);
                let thumbnail = image::imageops::resize(
                    &image,
                    (image.width() as f32 * ratio).max(1.0) as u32,
                    (image.height() as f32 * ratio).max(1.0) as u32,
                    FilterType::Triangle,
                );
                let mut jpeg = Vec::new();
                JpegEncoder::new_with_quality(&mut jpeg, 65)
                    .encode_image(&thumbnail)
                    .map_err(|e| e.to_string())?;
                let mut snapshot = shared.snapshot.lock().unwrap();
                snapshot.preview_count += 1;
                snapshot.preview_bytes = jpeg.len();
                *shared.jpeg.lock().unwrap() = jpeg;
                if snapshot.preview_count == 1 {
                    let _ = app.emit_to("main", "monitor-state", snapshot.clone());
                }
                last_preview = Instant::now();
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}
