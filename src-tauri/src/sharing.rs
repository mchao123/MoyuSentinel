use crate::{create_overlays, main_only, reminders, Runtime};
use reqwest::{blocking::Client, Url};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, WebviewWindow};
use tiny_http::{Header, Method, Response, Server};
use uuid::Uuid;

const LEASE: Duration = Duration::from_secs(3);
pub fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub address: String,
    pub access_code: String,
    pub enabled: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub enabled: bool,
    pub receive_enabled: bool,
    pub port: u16,
    pub device_name: String,
    pub source_id: String,
    pub access_code: String,
    pub peers: Vec<Peer>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            enabled: false,
            receive_enabled: true,
            port: 18420,
            device_name: std::env::var("COMPUTERNAME").unwrap_or_else(|_| "本机".into()),
            source_id: Uuid::new_v4().to_string(),
            access_code: Uuid::new_v4().simple().to_string(),
            peers: Vec::new(),
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Detection {
    pub protocol_version: u8,
    pub source_id: String,
    pub session_id: String,
    pub device_name: String,
    pub phase: String,
    pub people: usize,
    pub alert_event: u64,
    pub updated_at: u64,
}
#[derive(Clone, Default)]
struct LivePeer {
    detection: Option<Detection>,
    received: Option<Instant>,
    last_seen: u64,
    latency: u64,
    error: Option<String>,
    last_event: Option<(String, u64)>,
}
impl LivePeer {
    fn active(&self, now: Instant) -> bool {
        self.error.is_none()
            && self
                .received
                .is_some_and(|at| now.duration_since(at) < LEASE)
            && self
                .detection
                .as_ref()
                .is_some_and(|detection| detection.phase == "alert")
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerState {
    pub id: String,
    pub name: String,
    pub phase: String,
    pub people: usize,
    pub last_seen: u64,
    pub latency: u64,
    pub error: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub config: Config,
    pub addresses: Vec<String>,
    pub listening: bool,
    pub error: Option<String>,
    pub peers: Vec<PeerState>,
    pub active_sources: Vec<String>,
}
struct ServerWorker {
    stop: Arc<AtomicBool>,
    handle: JoinHandle<()>,
}
pub struct Sharing {
    directory: PathBuf,
    config: Mutex<Config>,
    live: Mutex<HashMap<String, LivePeer>>,
    server: Mutex<Option<ServerWorker>>,
    error: Mutex<Option<String>>,
    configuration: Mutex<()>,
    pub event_count: AtomicU64,
    session_id: String,
}
impl Sharing {
    pub fn load(directory: &Path) -> Result<Self, String> {
        let path = directory.join("sharing.json");
        let config = if path.exists() {
            serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
                .map_err(|e| format!("共享设置读取失败：{e}"))?
        } else {
            Config::default()
        };
        Ok(Self {
            directory: directory.to_path_buf(),
            config: Mutex::new(config),
            live: Mutex::new(HashMap::new()),
            server: Mutex::new(None),
            error: Mutex::new(None),
            configuration: Mutex::new(()),
            event_count: AtomicU64::new(0),
            session_id: Uuid::new_v4().to_string(),
        })
    }
    pub fn config(&self) -> Config {
        self.config.lock().unwrap().clone()
    }
    pub fn active(&self) -> bool {
        self.config.lock().unwrap().receive_enabled
            && self
                .live
                .lock()
                .unwrap()
                .values()
                .any(|peer| peer.active(Instant::now()))
    }
    pub fn snapshot(&self) -> Snapshot {
        let config = self.config();
        let live = self.live.lock().unwrap();
        let now = Instant::now();
        let peers: Vec<_> = config
            .peers
            .iter()
            .map(|peer| {
                let value = live.get(&peer.id);
                let detection = value.and_then(|value| value.detection.as_ref());
                let online = value.is_some_and(|value| {
                    value.error.is_none()
                        && value
                            .received
                            .is_some_and(|at| now.duration_since(at) < LEASE)
                });
                PeerState {
                    id: peer.id.clone(),
                    name: if peer.name.is_empty() {
                        detection
                            .map_or_else(|| peer.address.clone(), |value| value.device_name.clone())
                    } else {
                        peer.name.clone()
                    },
                    phase: if !config.receive_enabled || !peer.enabled {
                        "disabled".into()
                    } else if online {
                        detection.unwrap().phase.clone()
                    } else if value.is_none() {
                        "connecting".into()
                    } else {
                        "offline".into()
                    },
                    people: if online { detection.unwrap().people } else { 0 },
                    last_seen: value.map_or(0, |value| value.last_seen),
                    latency: value.map_or(0, |value| value.latency),
                    error: value.and_then(|value| value.error.clone()),
                }
            })
            .collect();
        let active_sources = peers
            .iter()
            .filter(|peer| peer.phase == "alert")
            .map(|peer| peer.name.clone())
            .collect();
        drop(live);
        let mut addresses: Vec<_> = if_addrs::get_if_addrs()
            .unwrap_or_default()
            .into_iter()
            .filter(|interface| !interface.is_loopback() && interface.ip().is_ipv4())
            .map(|interface| format!("http://{}:{}", interface.ip(), config.port))
            .collect();
        addresses.sort();
        addresses.dedup();
        Snapshot {
            config,
            addresses,
            listening: self.server.lock().unwrap().is_some(),
            error: self.error.lock().unwrap().clone(),
            peers,
            active_sources,
        }
    }
    pub fn configure(&self, app: tauri::AppHandle, mut next: Config) -> Result<(), String> {
        let _guard = self.configuration.lock().unwrap();
        let previous = self.config();
        next.source_id = previous.source_id.clone();
        validate(&mut next)?;
        let mut worker = self.server.lock().unwrap();
        let needs_server = next.enabled && (worker.is_none() || previous.port != next.port);
        let mut server = if needs_server {
            Some(
                Server::http(("0.0.0.0", next.port))
                    .map_err(|e| format!("共享端口 {} 无法启动：{e}", next.port))?,
            )
        } else {
            None
        };
        let persisted = (|| {
            let temporary = self.directory.join("sharing.json.tmp");
            fs::write(&temporary, serde_json::to_vec_pretty(&next).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            fs::rename(temporary, self.directory.join("sharing.json")).map_err(|e| e.to_string())
        })();
        if let Err(error) = persisted {
            if let Some(server) = server.take() { close_server(server); }
            return Err(error);
        }
        *self.config.lock().unwrap() = next.clone();
        self.live.lock().unwrap().retain(|id, _| {
            next.receive_enabled
                && next
                    .peers
                    .iter()
                    .any(|peer| &peer.id == id && peer.enabled && previous.peers.contains(peer))
        });
        if !next.enabled || needs_server {
            if let Some(previous) = worker.take() {
                previous.stop.store(true, Ordering::Relaxed);
                let _ = previous.handle.join();
            }
        }
        if let Some(server) = server {
            let stop = Arc::new(AtomicBool::new(false));
            let signal = stop.clone();
            let handle = thread::spawn(move || serve(app, server, signal));
            *worker = Some(ServerWorker { stop, handle });
        }
        *self.error.lock().unwrap() = None;
        Ok(())
    }
    fn accept(
        &self,
        peer: &Peer,
        result: Result<Detection, String>,
        elapsed: Duration,
    ) -> Option<SharedEvent> {
        let config = self.config.lock().unwrap();
        if !config.receive_enabled || !config.peers.contains(peer) || !peer.enabled {
            return None;
        }
        let mut live = self.live.lock().unwrap();
        let value = live.entry(peer.id.clone()).or_default();
        match result {
            Ok(detection) => {
                let signature = (detection.session_id.clone(), detection.alert_event);
                let event = if detection.phase == "alert"
                    && value.last_event.as_ref() != Some(&signature)
                {
                    value.last_event = Some(signature);
                    self.event_count.fetch_add(1, Ordering::Relaxed);
                    Some(SharedEvent {
                        id: format!(
                            "{}:{}:{}",
                            peer.id, detection.session_id, detection.alert_event
                        ),
                        source: if peer.name.is_empty() {
                            detection.device_name.clone()
                        } else {
                            peer.name.clone()
                        },
                        people: detection.people,
                        at: timestamp(),
                    })
                } else {
                    None
                };
                value.detection = Some(detection);
                value.received = Some(Instant::now());
                value.last_seen = timestamp();
                value.latency = elapsed.as_millis() as u64;
                value.error = None;
                event
            }
            Err(error) => {
                value.received = None;
                value.error = Some(error);
                None
            }
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedEvent {
    id: String,
    source: String,
    people: usize,
    at: u64,
}

fn normalize_address(address: &str) -> Result<String, String> {
    let address = address.trim();
    let address = if address.contains("://") {
        address.to_owned()
    } else {
        format!("http://{address}")
    };
    let mut url = Url::parse(&address).map_err(|_| "设备地址无效".to_string())?;
    if url.scheme() != "http"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !["/", "", "/v1/detection"].contains(&url.path())
    {
        return Err("请输入局域网设备的 HTTP 地址和端口".into());
    }
    if url.port().is_none() {
        url.set_port(Some(18420)).map_err(|_| "端口无效")?;
    }
    url.set_path("");
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
fn validate(config: &mut Config) -> Result<(), String> {
    if config.port < 1024 {
        return Err("共享端口需在 1024 到 65535 之间".into());
    }
    config.device_name = config.device_name.trim().to_owned();
    if config.device_name.is_empty() || config.device_name.chars().count() > 80 {
        return Err("设备名称需为 1 到 80 个字符".into());
    }
    if config.access_code.len() < 8
        || config.access_code.len() > 128
        || !config
            .access_code
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("访问码需为 8 到 128 位字母或数字".into());
    }
    if config.peers.len() > 16 {
        return Err("最多连接 16 台共享设备".into());
    }
    let mut ids = HashSet::new();
    let mut addresses = HashSet::new();
    for peer in &mut config.peers {
        if peer.id.is_empty() || !ids.insert(peer.id.clone()) {
            return Err("设备标识重复".into());
        }
        peer.address = normalize_address(&peer.address)?;
        peer.name = peer.name.trim().chars().take(80).collect();
        if !addresses.insert(peer.address.clone()) {
            return Err("该设备地址已添加".into());
        }
        if peer.access_code.is_empty() || peer.access_code.len() > 128 {
            return Err("请输入对方的访问码".into());
        }
    }
    Ok(())
}
fn serve(app: tauri::AppHandle, server: Server, stop: Arc<AtomicBool>) {
    while !stop.load(Ordering::Relaxed) && !app.state::<Runtime>().exiting.load(Ordering::Relaxed) {
        let Ok(Some(request)) = server.recv_timeout(Duration::from_millis(100)) else {
            continue;
        };
        let state = app.state::<Runtime>();
        let config = state.sharing.config();
        let authorized = request.headers().iter().any(|header| {
            header.field.equiv("Authorization")
                && header.value.as_str() == format!("Bearer {}", config.access_code)
        });
        let (status, body) = if !config.enabled {
            (503, "{}".into())
        } else if request.method() != &Method::Get {
            (405, "{}".into())
        } else if request.url() != "/v1/detection" {
            (404, "{}".into())
        } else if !authorized {
            (401, "{}".into())
        } else {
            // Publish only this camera's result; received alerts never propagate again.
            let local = state.monitor.snapshot();
            let detection = Detection {
                protocol_version: 1,
                source_id: config.source_id,
                session_id: state.sharing.session_id.clone(),
                device_name: config.device_name,
                phase: local.phase,
                people: local.people.len(),
                alert_event: local.alert_event,
                updated_at: timestamp(),
            };
            (200, serde_json::to_string(&detection).unwrap())
        };
        let response = Response::from_string(body)
            .with_status_code(status)
            .with_header(Header::from_bytes("Content-Type", "application/json").unwrap())
            .with_header(Header::from_bytes("Cache-Control", "no-store").unwrap());
        let _ = request.respond(response);
    }
    close_server(server);
}

fn close_server(server: Server) {
    let port = server.server_addr().to_ip().unwrap().port();
    drop(server);
    // tiny_http wakes accept() by connecting to its bound address. Windows rejects
    // 0.0.0.0 as a destination, so wake it through loopback and await socket release.
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    for _ in 0..50 {
        match std::net::TcpStream::connect_timeout(&address, Duration::from_millis(20)) {
            Ok(stream) => { let _ = stream.shutdown(std::net::Shutdown::Both); }
            Err(_) => break,
        }
        thread::sleep(Duration::from_millis(10));
    }
}
fn poll(client: &Client, peer: &Peer, local_id: &str) -> Result<Detection, String> {
    let response = client
        .get(format!("{}/v1/detection", peer.address))
        .bearer_auth(&peer.access_code)
        .send()
        .map_err(|_| "连接失败，请检查地址、共享开关和防火墙".to_owned())?;
    if response.status().as_u16() == 401 {
        return Err("访问码不正确".into());
    }
    if !response.status().is_success() {
        return Err(format!("对方服务返回 {}", response.status().as_u16()));
    }
    let mut bytes = Vec::new();
    response
        .take(8193)
        .read_to_end(&mut bytes)
        .map_err(|_| "读取共享结果失败")?;
    if bytes.len() > 8192 {
        return Err("共享结果过大".into());
    }
    let detection: Detection =
        serde_json::from_slice(&bytes).map_err(|_| "对方不是兼容的共享设备")?;
    if detection.protocol_version != 1
        || !["idle", "loading", "watching", "alert"].contains(&detection.phase.as_str())
        || detection.source_id.is_empty()
        || detection.session_id.is_empty()
        || detection.people > 100
        || detection.device_name.chars().count() > 80
    {
        return Err("共享结果格式无效".into());
    }
    if detection.source_id == local_id {
        return Err("不能接收本机自己的共享结果".into());
    }
    Ok(detection)
}
pub fn start(app: tauri::AppHandle) {
    thread::spawn(move || {
        let state = app.state::<Runtime>();
        if let Err(error) = state.sharing.configure(app.clone(), state.sharing.config()) {
            *state.sharing.error.lock().unwrap() = Some(error);
        }
        drop(state);
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_millis(700))
            .timeout(Duration::from_millis(900))
            .build()
            .unwrap();
        while !app.state::<Runtime>().exiting.load(Ordering::Relaxed) {
            let started = Instant::now();
            let config = app.state::<Runtime>().sharing.config();
            if config.receive_enabled {
                thread::scope(|scope| {
                    for peer in config.peers.iter().filter(|peer| peer.enabled) {
                        let client = &client;
                        let app = &app;
                        let source_id = &config.source_id;
                        scope.spawn(move || {
                            let started = Instant::now();
                            let result = poll(client, peer, source_id);
                            if let Some(event) = app.state::<Runtime>().sharing.accept(
                                peer,
                                result,
                                started.elapsed(),
                            ) {
                                let _ = app.emit_to("main", "shared-detection", event);
                            }
                        });
                    }
                });
            }
            thread::sleep(Duration::from_secs(1).saturating_sub(started.elapsed()));
        }
    });
}
#[tauri::command]
pub fn sharing_state(
    window: WebviewWindow,
    state: tauri::State<Runtime>,
) -> Result<Snapshot, String> {
    main_only(&window)?;
    Ok(state.sharing.snapshot())
}
#[tauri::command]
pub async fn save_sharing(
    app: tauri::AppHandle,
    window: WebviewWindow,
    config: Config,
) -> Result<Snapshot, String> {
    main_only(&window)?;
    if config.receive_enabled && !config.peers.is_empty() {
        create_overlays(&app)?;
        if app.state::<Runtime>().monitor.settings().alert_mode == "popup" {
            reminders::ensure_popup(&app)?;
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Runtime>();
        state.sharing.configure(app.clone(), config)?;
        Ok(state.sharing.snapshot())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabling_sharing_releases_the_windows_wildcard_listener() {
        let server = Server::http(("0.0.0.0", 0)).unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        close_server(server);
        let listener = std::net::TcpListener::bind(("0.0.0.0", port)).unwrap();
        drop(listener);
    }
    #[test]
    fn addresses_and_duplicate_peers_are_validated() {
        assert_eq!(
            normalize_address("192.168.1.9").unwrap(),
            "http://192.168.1.9:18420"
        );
        assert_eq!(
            normalize_address("http://192.168.1.9:18000/v1/detection").unwrap(),
            "http://192.168.1.9:18000"
        );
        assert!(normalize_address("file:///etc/passwd").is_err());
        assert!(normalize_address("http://user:password@host").is_err());
        let peer = Peer {
            id: "one".into(),
            name: "".into(),
            address: "192.168.1.9".into(),
            access_code: "12345678".into(),
            enabled: true,
        };
        let mut config = Config {
            peers: vec![
                peer.clone(),
                Peer {
                    id: "two".into(),
                    ..peer
                },
            ],
            ..Config::default()
        };
        assert!(validate(&mut config).is_err());
    }
    #[test]
    fn remote_alerts_expire_and_do_not_repeat_after_reconnection() {
        let sharing = Sharing::load(Path::new("missing-sharing-test-directory")).unwrap();
        let peer = Peer {
            id: "peer".into(),
            name: "door".into(),
            address: "http://127.0.0.1:18421".into(),
            access_code: "12345678".into(),
            enabled: true,
        };
        sharing.config.lock().unwrap().peers.push(peer.clone());
        let detection = Detection {
            protocol_version: 1,
            source_id: "remote".into(),
            session_id: "session".into(),
            device_name: "door".into(),
            phase: "alert".into(),
            people: 1,
            alert_event: 1,
            updated_at: timestamp(),
        };
        assert!(sharing
            .accept(&peer, Ok(detection.clone()), Duration::ZERO)
            .is_some());
        assert!(sharing.active());
        assert!(sharing
            .accept(&peer, Ok(detection.clone()), Duration::ZERO)
            .is_none());
        let value = sharing.live.lock().unwrap().get(&peer.id).unwrap().clone();
        assert!(!value.active(Instant::now() + LEASE));
        sharing.accept(&peer, Err("offline".into()), Duration::ZERO);
        assert!(!sharing.active());
        assert!(sharing
            .accept(&peer, Ok(detection), Duration::ZERO)
            .is_none());
        assert!(sharing.active());
        sharing.config.lock().unwrap().receive_enabled = false;
        assert!(!sharing.active());
    }
}
