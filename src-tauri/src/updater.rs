#![cfg_attr(debug_assertions, allow(dead_code))]
use crate::{main_only, Runtime};
use semver::Version;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, BufReader, BufWriter, Read, Write},
    path::Path,
    sync::{atomic::AtomicBool, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const REPOSITORY: &str = "mchao123/MoyuSentinel";
const ZIP_ASSET: &str = "MoyuSentinel-windows-x64.zip";
const CHECKSUM_ASSET: &str = "MoyuSentinel-windows-x64.zip.sha256";
const EXECUTABLE: &str = "MoyuSentinel.exe";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    current_version: String,
    version: String,
    notes: String,
    published_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    downloaded: u64,
    total: u64,
}

#[derive(Clone)]
struct PendingUpdate {
    info: UpdateInfo,
    url: String,
    sha256: String,
    size: u64,
}

#[derive(Default)]
pub struct Updater {
    pending: Mutex<Option<PendingUpdate>>,
    installing: AtomicBool,
}

impl Updater {
    pub fn check(&self) -> Result<Option<UpdateInfo>, String> {
        let current = Version::parse(env!("CARGO_PKG_VERSION"))
            .map_err(|error| format!("Invalid current version: {error}"))?;
        let client = reqwest::blocking::Client::builder()
            .user_agent("MoyuSentinel-Updater")
            .timeout(Duration::from_secs(20))
            .build()
            .map_err(|error| error.to_string())?;
        let latest_url = format!("https://github.com/{REPOSITORY}/releases/latest");
        let release = client
            .get(latest_url)
            .send()
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?;
        let release_url = release.url().clone();
        let tag = release_url
            .path_segments()
            .and_then(|mut segments| segments.next_back())
            .filter(|tag| !tag.is_empty())
            .ok_or_else(|| "The latest release tag is unavailable".to_owned())?;
        let version = Version::parse(tag.trim_start_matches('v'))
            .map_err(|error| format!("Invalid release version: {error}"))?;
        if version <= current {
            *self.pending.lock().map_err(|error| error.to_string())? = None;
            return Ok(None);
        }
        let base_url = format!("https://github.com/{REPOSITORY}/releases/download/{tag}");
        let checksum = client
            .get(format!("{base_url}/{CHECKSUM_ASSET}"))
            .send()
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?
            .text()
            .map_err(|error| error.to_string())?;
        let checksum = normalize_checksum(&parse_checksum(&checksum))?;
        let info = UpdateInfo {
            current_version: current.to_string(),
            version: version.to_string(),
            notes: String::new(),
            published_at: String::new(),
        };
        *self.pending.lock().map_err(|error| error.to_string())? = Some(PendingUpdate {
            info: info.clone(),
            url: format!("{base_url}/{ZIP_ASSET}"),
            sha256: checksum,
            size: 0,
        });
        Ok(Some(info))
    }

    fn pending(&self) -> Result<PendingUpdate, String> {
        self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .clone()
            .ok_or_else(|| "No update has been prepared".to_owned())
    }
}

fn normalize_checksum(value: &str) -> Result<String, String> {
    let checksum = value.trim().to_ascii_lowercase();
    if checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid SHA-256 checksum".into());
    }
    Ok(checksum)
}

fn parse_checksum(value: &str) -> String {
    value
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_owned()
}
#[tauri::command]
pub fn app_version(window: WebviewWindow) -> Result<String, String> {
    main_only(&window)?;
    Ok(env!("CARGO_PKG_VERSION").to_owned())
}

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Option<UpdateInfo>, String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || app.state::<Runtime>().updater.check())
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(debug_assertions)]
#[tauri::command]
pub async fn install_update(_app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    Err("Updates are disabled in development builds".into())
}

#[cfg(all(not(debug_assertions), not(windows)))]
#[tauri::command]
pub async fn install_update(_app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    Err("Automatic updates are only supported on Windows".into())
}

#[cfg(all(not(debug_assertions), windows))]
#[tauri::command]
pub async fn install_update(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    let updater = &app.state::<Runtime>().updater;
    if updater
        .installing
        .swap(true, std::sync::atomic::Ordering::AcqRel)
    {
        return Err("An update is already being downloaded".into());
    }
    let pending = match updater.pending() {
        Ok(update) => update,
        Err(error) => {
            updater
                .installing
                .store(false, std::sync::atomic::Ordering::Release);
            return Err(error);
        }
    };
    let task_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || prepare_update(&task_app, pending))
        .await
        .map_err(|error| error.to_string())?;
    updater
        .installing
        .store(false, std::sync::atomic::Ordering::Release);
    result?;
    app.state::<Runtime>()
        .exiting
        .store(true, std::sync::atomic::Ordering::Relaxed);
    app.exit(0);
    Ok(())
}

#[cfg(windows)]
fn prepare_update(app: &AppHandle, update: PendingUpdate) -> Result<(), String> {
    let state = app.state::<Runtime>();
    let root = state.data_dir.join("updates").join(&update.info.version);
    let staging = root.join("staging");
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|error| error.to_string())?;
    }
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let archive = root.join(ZIP_ASSET);
    download(app, &update, &archive)?;
    extract_zip(&archive, &staging)?;
    let executable = staging.join(EXECUTABLE);
    if !executable.is_file() {
        return Err(format!("Update archive does not contain {EXECUTABLE}"));
    }
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let target = current
        .parent()
        .ok_or_else(|| "Installed application directory is unavailable".to_owned())?;
    let script = root.join("apply-update.ps1");
    fs::write(&script, APPLY_UPDATE_SCRIPT).map_err(|error| error.to_string())?;
    let mut command = std::process::Command::new("powershell.exe");
    command
        .arg("-NoProfile")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&script)
        .arg("-ParentPid")
        .arg(std::process::id().to_string())
        .arg("-Source")
        .arg(&staging)
        .arg("-Target")
        .arg(target)
        .arg("-Executable")
        .arg(EXECUTABLE)
        .arg("-UpdateRoot")
        .arg(&root);
    command.spawn().map_err(|error| error.to_string())?;
    emit_progress(app, update.size, update.size);
    Ok(())
}
#[cfg(windows)]
fn download(app: &AppHandle, update: &PendingUpdate, destination: &Path) -> Result<(), String> {
    let client = reqwest::blocking::Client::builder()
        .user_agent("MoyuSentinel-Updater")
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|error| error.to_string())?;
    let mut response = client
        .get(&update.url)
        .send()
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    let total = response.content_length().unwrap_or(update.size);
    let part = destination.with_extension("zip.part");
    let file = File::create(&part).map_err(|error| error.to_string())?;
    let mut writer = BufWriter::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut downloaded = 0_u64;
    let mut last_emit = Instant::now();
    loop {
        let count = response
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        writer
            .write_all(&buffer[..count])
            .map_err(|error| error.to_string())?;
        hasher.update(&buffer[..count]);
        downloaded += count as u64;
        if last_emit.elapsed() >= Duration::from_millis(120) {
            emit_progress(app, downloaded, total);
            last_emit = Instant::now();
        }
    }
    writer.flush().map_err(|error| error.to_string())?;
    writer
        .get_ref()
        .sync_all()
        .map_err(|error| error.to_string())?;
    let actual = format!("{:x}", hasher.finalize());
    if actual != update.sha256 {
        return Err("Downloaded update checksum does not match".into());
    }
    fs::rename(&part, destination).map_err(|error| error.to_string())?;
    emit_progress(app, downloaded, total);
    Ok(())
}

#[cfg(windows)]
fn emit_progress(app: &AppHandle, downloaded: u64, total: u64) {
    let _ = app.emit_to(
        "main",
        "update-progress",
        UpdateProgress { downloaded, total },
    );
}

#[cfg(windows)]
fn extract_zip(archive: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let mut zip = zip::ZipArchive::new(BufReader::new(file)).map_err(|error| error.to_string())?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|error| error.to_string())?;
        let relative = entry
            .enclosed_name()
            .ok_or_else(|| "Update archive contains an unsafe path".to_owned())?
            .to_owned();
        let output = destination.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output).map_err(|error| error.to_string())?;
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("Update archive contains a symbolic link".into());
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut file = File::create(&output).map_err(|error| error.to_string())?;
        io::copy(&mut entry, &mut file).map_err(|error| error.to_string())?;
    }
    Ok(())
}
#[cfg(windows)]
const APPLY_UPDATE_SCRIPT: &str = r#"
param(
  [Parameter(Mandatory=$true)][int]$ParentPid,
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$UpdateRoot
)
$ErrorActionPreference = "Stop"
$deadline = (Get-Date).AddSeconds(60)
while ((Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
  throw "Timed out waiting for Moyu Sentinel to exit"
}
$backup = Join-Path $env:TEMP ("MoyuSentinel-update-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
try {
  Get-ChildItem -LiteralPath $Source -File | ForEach-Object {
    $destination = Join-Path $Target $_.Name
    if (Test-Path -LiteralPath $destination) {
      Copy-Item -LiteralPath $destination -Destination (Join-Path $backup $_.Name) -Force
    }
    Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
  }
  Start-Process -FilePath (Join-Path $Target $Executable) -WorkingDirectory $Target
} catch {
  Set-Content -LiteralPath (Join-Path $Target "update-error.log") -Value $_ -Encoding UTF8
  Get-ChildItem -LiteralPath $backup -File -ErrorAction SilentlyContinue | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Target $_.Name) -Force
  }
  Start-Process -FilePath (Join-Path $Target $Executable) -WorkingDirectory $Target
} finally {
  Remove-Item -LiteralPath $backup -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $UpdateRoot -Recurse -Force -ErrorAction SilentlyContinue
}
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_validates_checksums() {
        let checksum = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        assert_eq!(
            parse_checksum(&format!("{checksum}  {ZIP_ASSET}")),
            checksum
        );
        assert_eq!(normalize_checksum(checksum).unwrap(), checksum);
        assert!(normalize_checksum("bad").is_err());
    }

    #[test]
    fn compares_release_versions() {
        let current = Version::parse(env!("CARGO_PKG_VERSION")).unwrap();
        let newer = Version::new(current.major, current.minor, current.patch + 1);
        assert!(newer > current);
        if current > Version::new(0, 0, 0) {
            assert!(Version::new(0, 0, 0) < current);
        }
    }
}
