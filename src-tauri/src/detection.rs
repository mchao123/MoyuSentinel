use image::{imageops::FilterType, RgbImage};
use ort::{session::Session, value::Tensor};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

const SIDE: usize = 416;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Person {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub score: f32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub device_id: String,
    pub confidence: f32,
    pub hold_seconds: f64,
    pub edge_hold_seconds: Option<f64>,
    pub intensity: f64,
    pub edge_width: u32,
    pub region: String,
    pub min_people: usize,
    pub detection_interval_ms: u64,
    pub alert_mode: String,
    pub glow_color: String,
    pub snooze_minutes: u64,
    pub image_selection: String,
    pub popup: crate::reminders::PopupOptions,
    pub actions: crate::automation::Actions,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            device_id: String::new(),
            confidence: 0.55,
            hold_seconds: 3.0,
            edge_hold_seconds: None,
            intensity: 0.72,
            edge_width: 52,
            region: "full".into(),
            min_people: 1,
            detection_interval_ms: 500,
            alert_mode: "edge".into(),
            glow_color: "#ff1930".into(),
            snooze_minutes: 3,
            image_selection: "random".into(),
            popup: crate::reminders::PopupOptions::default(),
            actions: crate::automation::Actions::default(),
        }
    }
}
impl Settings {
    pub fn validated(mut self) -> Self {
        self.confidence = if self.confidence.is_finite() {
            self.confidence.clamp(0.3, 0.9)
        } else {
            0.55
        };
        self.hold_seconds = if self.hold_seconds.is_finite() {
            self.hold_seconds.clamp(1.0, 10.0)
        } else {
            3.0
        };
        self.intensity = if self.intensity.is_finite() {
            self.intensity.clamp(0.2, 1.0)
        } else {
            0.72
        };
        self.edge_width = self.edge_width.clamp(16, 100);
        self.min_people = self.min_people.clamp(1, 5);
        self.detection_interval_ms = self.detection_interval_ms.clamp(100, 2000);
        if !["edge", "popup", "mixed", "none"].contains(&self.alert_mode.as_str()) {
            self.alert_mode = "edge".into();
        }
        if self.glow_color.len() != 7
            || !self.glow_color.starts_with('#')
            || !self.glow_color.as_bytes()[1..]
                .iter()
                .all(u8::is_ascii_hexdigit)
        {
            self.glow_color = "#ff1930".into();
        }
        self.snooze_minutes = self.snooze_minutes.clamp(1, 60);
        if !["random", "sequential"].contains(&self.image_selection.as_str()) {
            self.image_selection = "random".into();
        }
        if !["full", "left", "right", "center"].contains(&self.region.as_str()) {
            self.region = "full".into();
        }
        self.popup = self.popup.validated();
        let hold = |value: Option<f64>| value.filter(|v| v.is_finite()).unwrap_or(self.hold_seconds).clamp(1.0, 10.0);
        self.edge_hold_seconds = Some(hold(self.edge_hold_seconds));
        self.popup.hold_seconds = Some(hold(self.popup.hold_seconds));
        self.actions.url = self.actions.url.trim().to_owned();
        self.actions.window_title = self.actions.window_title.trim().to_owned();
        self
    }
    pub fn has_edge(&self) -> bool { ["edge", "mixed"].contains(&self.alert_mode.as_str()) }
    pub fn has_popup(&self) -> bool { ["popup", "mixed"].contains(&self.alert_mode.as_str()) }
    pub fn edge_hold(&self) -> f64 { self.edge_hold_seconds.unwrap_or(self.hold_seconds) }
    pub fn popup_hold(&self) -> f64 { self.popup.hold_seconds.unwrap_or(self.hold_seconds) }
    pub fn includes(&self, person: &Person) -> bool {
        let center = person.x + person.width / 2.0;
        match self.region.as_str() {
            "left" => center <= 0.5,
            "right" => center >= 0.5,
            "center" => (0.25..=0.75).contains(&center),
            _ => true,
        }
    }
}

#[derive(Default)]
pub struct AlertGate {
    consecutive: u32,
    previous: Option<Instant>,
    until: Option<Instant>,
    confirmed_at: Option<Instant>,
}
impl AlertGate {
    pub fn update(&mut self, positive: bool, now: Instant, settings: &Settings) -> bool {
        let max_gap = Duration::from_millis(settings.detection_interval_ms * 3);
        self.consecutive = if positive {
            if self
                .previous
                .is_some_and(|last| now.duration_since(last) <= max_gap)
            {
                self.consecutive + 1
            } else {
                1
            }
        } else {
            0
        };
        self.previous = Some(now);
        if self.consecutive >= 2 {
            self.confirmed_at = Some(now);
            self.until = Some(now + Duration::from_secs_f64(settings.edge_hold().max(settings.popup_hold())));
        }
        self.active(now)
    }
    pub fn active(&self, now: Instant) -> bool {
        self.until.is_some_and(|until| now < until)
    }
    pub fn confirmed_at(&self) -> Option<Instant> { self.confirmed_at }
}

pub struct Detector {
    session: Session,
}
impl Detector {
    pub fn new() -> Result<Self, String> {
        let session = Session::builder()
            .map_err(|e| e.to_string())?
            .with_intra_threads(2)
            .map_err(|e| e.to_string())?
            .with_inter_threads(1)
            .map_err(|e| e.to_string())?
            .with_config_entry("session.intra_op.allow_spinning", "0")
            .map_err(|e| e.to_string())?
            .with_config_entry("session.inter_op.allow_spinning", "0")
            .map_err(|e| e.to_string())?
            .commit_from_memory(include_bytes!("../models/yolox_nano.onnx"))
            .map_err(|e| e.to_string())?;
        Ok(Self { session })
    }
    pub fn detect(&mut self, image: &RgbImage, settings: &Settings) -> Result<Vec<Person>, String> {
        let ratio = (SIDE as f32 / image.width() as f32).min(SIDE as f32 / image.height() as f32);
        let width = (image.width() as f32 * ratio) as u32;
        let height = (image.height() as f32 * ratio) as u32;
        let scaled =
            image::imageops::resize(image, width.max(1), height.max(1), FilterType::Triangle);
        // YOLOX's published ONNX weights use BGR, 0..255, top-left letterboxing.
        let mut input = vec![114.0_f32; 3 * SIDE * SIDE];
        for (x, y, pixel) in scaled.enumerate_pixels() {
            let index = y as usize * SIDE + x as usize;
            input[index] = pixel[2] as f32;
            input[SIDE * SIDE + index] = pixel[1] as f32;
            input[2 * SIDE * SIDE + index] = pixel[0] as f32;
        }
        let tensor = Tensor::from_array(([1, 3, SIDE, SIDE], input)).map_err(|e| e.to_string())?;
        let outputs = self
            .session
            .run(ort::inputs![tensor])
            .map_err(|e| e.to_string())?;
        let (shape, values) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        if shape.as_ref() != [1, 3549, 85] {
            return Err(format!("Unexpected detector output: {shape:?}"));
        }
        let mut candidates = Vec::new();
        let mut row = 0;
        for stride in [8, 16, 32] {
            let grid = SIDE / stride;
            for y in 0..grid {
                for x in 0..grid {
                    let prediction = &values[row * 85..(row + 1) * 85];
                    row += 1;
                    let score = prediction[4] * prediction[5];
                    if score < settings.confidence {
                        continue;
                    }
                    let cx = (prediction[0] + x as f32) * stride as f32 / ratio;
                    let cy = (prediction[1] + y as f32) * stride as f32 / ratio;
                    let w = prediction[2].exp() * stride as f32 / ratio;
                    let h = prediction[3].exp() * stride as f32 / ratio;
                    let left = ((cx - w / 2.0) / image.width() as f32).clamp(0.0, 1.0);
                    let top = ((cy - h / 2.0) / image.height() as f32).clamp(0.0, 1.0);
                    let right = ((cx + w / 2.0) / image.width() as f32).clamp(0.0, 1.0);
                    let bottom = ((cy + h / 2.0) / image.height() as f32).clamp(0.0, 1.0);
                    let person = Person {
                        x: left,
                        y: top,
                        width: right - left,
                        height: bottom - top,
                        score,
                    };
                    if person.width > 0.0 && person.height > 0.0 && settings.includes(&person) {
                        candidates.push(person);
                    }
                }
            }
        }
        candidates.sort_by(|a, b| b.score.total_cmp(&a.score));
        let mut people: Vec<Person> = Vec::new();
        for person in candidates {
            if people.iter().all(|other| overlap(&person, other) < 0.45) {
                people.push(person);
            }
            if people.len() >= 10 {
                break;
            }
        }
        Ok(people)
    }
}
fn overlap(a: &Person, b: &Person) -> f32 {
    let w = ((a.x + a.width).min(b.x + b.width) - a.x.max(b.x)).max(0.0);
    let h = ((a.y + a.height).min(b.y + b.height) - a.y.max(b.y)).max(0.0);
    let intersection = w * h;
    intersection / (a.width * a.height + b.width * b.height - intersection).max(f32::EPSILON)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn low_frequency_confirmation_and_hold() {
        let settings = Settings {
            detection_interval_ms: 2000,
            ..Settings::default()
        };
        let now = Instant::now();
        let mut gate = AlertGate::default();
        assert!(!gate.update(true, now, &settings));
        assert!(gate.update(true, now + Duration::from_secs(2), &settings));
        assert!(gate.update(false, now + Duration::from_secs(4), &settings));
        assert!(!gate.active(now + Duration::from_secs(5)));
    }
    #[test]
    fn absence_does_not_extend_either_hold_and_event_uses_longest_hold() {
        let settings = Settings { edge_hold_seconds: Some(2.0), popup: crate::reminders::PopupOptions { hold_seconds: Some(8.0), ..Default::default() }, ..Settings::default() };
        let now = Instant::now();
        let mut gate = AlertGate::default();
        assert!(!gate.update(true, now, &settings));
        assert!(gate.update(true, now + Duration::from_millis(500), &settings));
        let confirmed = gate.confirmed_at();
        assert!(gate.update(false, now + Duration::from_secs(4), &settings));
        assert_eq!(gate.confirmed_at(), confirmed);
        assert!(!gate.active(now + Duration::from_secs(9)));
    }
    #[test]
    fn real_model_detects_people_and_rejects_empty_image() {
        let mut detector = Detector::new().unwrap();
        let image = image::open("../test-results/person-fixture.jpg")
            .unwrap()
            .to_rgb8();
        assert!(!detector
            .detect(&image, &Settings::default())
            .unwrap()
            .is_empty());
        let empty = RgbImage::from_pixel(640, 480, image::Rgb([114, 114, 114]));
        assert!(detector
            .detect(&empty, &Settings::default())
            .unwrap()
            .is_empty());
    }
}
