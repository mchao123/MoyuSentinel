use crate::{main_only, Runtime};
use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewWindow};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Actions {
    pub enabled: Option<bool>,
    pub open_url: bool,
    pub url: String,
    pub focus_window: bool,
    pub window_process: String,
    pub window_title: String,
}
impl Actions {
    fn validate_window(&self) -> Result<(), String> {
        if self.window_process.is_empty()
            || self.window_process.contains('\0')
            || self.window_title.contains('\0')
        {
            return Err("请选择目标应用窗口".into());
        }
        Ok(())
    }
}
fn web_url(value: &str) -> Result<reqwest::Url, String> {
    let url = reqwest::Url::parse(value).map_err(|_| "请输入完整的 HTTP 或 HTTPS 网页地址")?;
    if value.len() > 2048
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
        || !["http", "https"].contains(&url.scheme())
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("请输入不含账号密码的 HTTP 或 HTTPS 网页地址".into());
    }
    Ok(url)
}

#[derive(Default)]
pub struct ActionGate {
    event: (u64, u64),
}
impl ActionGate {
    pub fn update(&mut self, active: bool, event: (u64, u64), suppressed: bool) -> bool {
        if !active {
            return false;
        }
        let trigger = self.event != event;
        self.event = event;
        trigger && !suppressed
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowTarget {
    pub title: String,
    pub process: String,
    #[serde(skip)]
    handle: usize,
}
fn choose_window<'a>(
    windows: &'a [WindowTarget],
    actions: &Actions,
) -> Result<&'a WindowTarget, String> {
    let matches: Vec<_> = windows
        .iter()
        .filter(|window| {
            window.process.eq_ignore_ascii_case(&actions.window_process)
                && (actions.window_title.is_empty()
                    || window
                        .title
                        .to_lowercase()
                        .contains(&actions.window_title.to_lowercase()))
        })
        .collect();
    match matches.as_slice() {
        [window] => Ok(window),
        [] => Err("未找到目标窗口，请确认应用已打开且窗口标题匹配".into()),
        _ => Err("多个窗口符合条件，请填写更具体的窗口标题".into()),
    }
}

pub fn execute(actions: &Actions) -> Result<(), String> {
    if !actions.enabled.unwrap_or(actions.open_url || actions.focus_window) { return Ok(()); }
    let mut errors = Vec::new();
    if actions.open_url {
        if let Err(error) = web_url(&actions.url).and_then(|url| platform::open_url(url.as_str())) {
            errors.push(error);
        }
    }
    if actions.focus_window {
        if let Err(error) = actions
            .validate_window()
            .and_then(|_| platform::windows())
            .and_then(|windows| platform::focus(choose_window(&windows, actions)?))
        {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}
#[tauri::command]
pub async fn list_target_windows(window: WebviewWindow) -> Result<Vec<WindowTarget>, String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(platform::windows)
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn test_actions(
    app: tauri::AppHandle,
    window: WebviewWindow,
    actions: Actions,
) -> Result<(), String> {
    main_only(&window)?;
    if app
        .state::<Runtime>()
        .snooze
        .lock()
        .map_err(|e| e.to_string())?
        .active(std::time::Instant::now())
    {
        return Err("提醒已暂停，请先恢复提醒".into());
    }
    tauri::async_runtime::spawn_blocking(move || execute(&actions))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(windows)]
mod platform {
    use super::WindowTarget;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HWND, LPARAM},
        System::{
            Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{Shell::ShellExecuteW, WindowsAndMessaging::*},
    };

    unsafe extern "system" fn collect(handle: HWND, data: LPARAM) -> i32 {
        if IsWindowVisible(handle) == 0 || GetWindow(handle, GW_OWNER) != null_mut() {
            return 1;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(handle, &mut pid);
        if pid == std::process::id() {
            return 1;
        }
        let mut title = vec![0u16; (GetWindowTextLengthW(handle).max(0) + 1) as usize];
        let len = GetWindowTextW(handle, title.as_mut_ptr(), title.len() as i32);
        if len <= 0 {
            return 1;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return 1;
        }
        let mut path = vec![0u16; 32768];
        let mut size = path.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut size);
        CloseHandle(process);
        if ok != 0 {
            let windows = &mut *(data as *mut Vec<WindowTarget>);
            windows.push(WindowTarget {
                title: String::from_utf16_lossy(&title[..len as usize]),
                process: String::from_utf16_lossy(&path[..size as usize]),
                handle: handle as usize,
            });
        }
        1
    }
    pub fn windows() -> Result<Vec<WindowTarget>, String> {
        let mut result = Vec::new();
        if unsafe {
            EnumWindows(
                Some(collect),
                &mut result as *mut Vec<WindowTarget> as LPARAM,
            )
        } == 0
        {
            return Err("无法读取应用窗口列表".into());
        }
        Ok(result)
    }
    pub fn focus(window: &WindowTarget) -> Result<(), String> {
        unsafe {
            let handle = window.handle as HWND;
            if IsWindow(handle) == 0 {
                return Err("目标窗口已关闭".into());
            }
            if IsIconic(handle) != 0 {
                ShowWindowAsync(handle, SW_RESTORE);
            }
            if SetForegroundWindow(handle) == 0 {
                let mut flash = FLASHWINFO {
                    cbSize: std::mem::size_of::<FLASHWINFO>() as u32,
                    hwnd: handle,
                    dwFlags: FLASHW_TRAY,
                    uCount: 3,
                    dwTimeout: 0,
                };
                FlashWindowEx(&mut flash);
                return Err("Windows 阻止了窗口前置，已闪烁目标应用的任务栏图标".into());
            }
        }
        Ok(())
    }
    pub fn open_url(url: &str) -> Result<(), String> {
        let url: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        let verb: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let result = unsafe {
            let initialized = CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) >= 0;
            let result = ShellExecuteW(
                null_mut(),
                verb.as_ptr(),
                url.as_ptr(),
                null(),
                null(),
                SW_SHOWNORMAL,
            ) as isize;
            if initialized {
                CoUninitialize();
            }
            result
        };
        if result > 32 {
            Ok(())
        } else {
            Err(format!("无法打开网页（Windows 错误 {result}）"))
        }
    }
}
#[cfg(not(windows))]
mod platform {
    use super::WindowTarget;
    pub fn windows() -> Result<Vec<WindowTarget>, String> {
        Err("自动操作仅支持 Windows 桌面程序".into())
    }
    pub fn focus(_: &WindowTarget) -> Result<(), String> {
        Err("自动操作仅支持 Windows 桌面程序".into())
    }
    pub fn open_url(_: &str) -> Result<(), String> {
        Err("自动操作仅支持 Windows 桌面程序".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn triggers_once_per_event_without_replaying_snoozed_events() {
        let mut gate = ActionGate::default();
        assert!(gate.update(true, (1, 0), false));
        assert!(!gate.update(true, (1, 0), false));
        assert!(!gate.update(true, (2, 0), true));
        assert!(!gate.update(true, (2, 0), false));
        assert!(gate.update(true, (2, 1), false));
        assert!(!gate.update(false, (2, 1), false));
        assert!(!gate.update(true, (2, 1), false));
        assert!(gate.update(true, (3, 1), false));
        assert!(!gate.update(true, (3, 2), true));
        assert!(!gate.update(false, (3, 2), false));
        assert!(!gate.update(true, (3, 2), false));
    }
    #[test]
    fn accepts_only_web_addresses() {
        assert!(web_url("https://example.com/path?q=a&b=2").is_ok());
        for value in [
            "",
            "file:///C:/test.exe",
            "javascript:alert(1)",
            "https://user:pass@example.com",
            "https://example.com/\0",
            "example.com",
            "https://example.com/a b",
        ] {
            assert!(web_url(value).is_err(), "{value:?}");
        }
    }
    #[test]
    fn invalid_actions_report_each_failure_independently() {
        let error = execute(&Actions {
            open_url: true,
            url: "file:///test".into(),
            focus_window: true,
            ..Actions::default()
        })
        .unwrap_err();
        assert!(error.contains("HTTP"));
        assert!(error.contains("目标应用窗口"));
    }
    #[test]
    fn master_switch_suppresses_configured_actions() {
        assert!(execute(&Actions { enabled: Some(false), open_url: true, url: "invalid".into(), focus_window: true, ..Actions::default() }).is_ok());
    }
    #[test]
    fn never_selects_an_ambiguous_or_unrelated_window() {
        let windows = vec![
            WindowTarget {
                title: "Report - Editor".into(),
                process: "C:\\Editor.exe".into(),
                handle: 1,
            },
            WindowTarget {
                title: "Notes - Editor".into(),
                process: "C:\\Editor.exe".into(),
                handle: 2,
            },
        ];
        let mut actions = Actions {
            window_process: "c:\\editor.exe".into(),
            ..Actions::default()
        };
        assert!(choose_window(&windows, &actions).is_err());
        actions.window_title = "report".into();
        assert_eq!(choose_window(&windows, &actions).unwrap().handle, 1);
        actions.window_process = "C:\\Other.exe".into();
        assert!(choose_window(&windows, &actions).is_err());
    }
}
