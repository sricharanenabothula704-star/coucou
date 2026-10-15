// Mic and camera in use — which apps are using them right now.
//
// Windows keeps, for every app that asked for the microphone or the camera, when
// it started and when it stopped; "stopped" stays 0 while it is still using it.
// That is what the "in use" dot in Windows' own taskbar reads. It is only read
// when the dashboard asks, and it never touches the audio or the video itself.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InUse {
    /// "microphone" or "webcam".
    pub kind: String,
    pub app: String,
}

// ── Pure rules ────────────────────────────────────────────────────────────────

/// Windows' record: started, and not stopped yet.
pub fn in_use(last_start: u64, last_stop: u64) -> bool {
    last_start > 0 && last_stop == 0
}

/// "C:#Program Files#Google#Chrome#chrome.exe" → "chrome.exe";
/// "Microsoft.WindowsCamera_8wekyb3d8bbwe" → "Microsoft.WindowsCamera".
pub fn app_label(key: &str) -> String {
    if key.contains('#') {
        return key.rsplit('#').next().unwrap_or(key).to_string();
    }
    key.split('_').next().unwrap_or(key).to_string()
}

#[tauri::command]
pub fn privacy_in_use() -> Vec<InUse> {
    let mut out = Vec::new();
    for kind in ["microphone", "webcam"] {
        for key in imp::apps_in_use(kind) {
            let app = app_label(&key);
            if !out.iter().any(|i: &InUse| i.kind == kind && i.app == app) {
                out.push(InUse { kind: kind.into(), app });
            }
        }
    }
    out
}

#[cfg(windows)]
mod imp {
    use super::in_use;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, KEY_READ,
    };

    const ROOT: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn open(parent: HKEY, path: &str) -> Option<HKEY> {
        let mut key = HKEY::default();
        let p = wide(path);
        (RegOpenKeyExW(parent, PCWSTR(p.as_ptr()), Some(0), KEY_READ, &mut key) == ERROR_SUCCESS).then_some(key)
    }

    unsafe fn subkeys(key: HKEY) -> Vec<String> {
        let mut names = Vec::new();
        for i in 0.. {
            let mut buf = [0u16; 512];
            let mut len = buf.len() as u32;
            if RegEnumKeyExW(key, i, Some(PWSTR(buf.as_mut_ptr())), &mut len, None, None, None, None) != ERROR_SUCCESS {
                break;
            }
            names.push(String::from_utf16_lossy(&buf[..len as usize]));
        }
        names
    }

    unsafe fn qword(key: HKEY, name: &str) -> u64 {
        let n = wide(name);
        let mut value = 0u64;
        let mut size = 8u32;
        let status = RegQueryValueExW(key, PCWSTR(n.as_ptr()), None, None, Some(&mut value as *mut u64 as *mut u8), Some(&mut size));
        if status == ERROR_SUCCESS { value } else { 0 }
    }

    unsafe fn using(key: HKEY, name: &str) -> bool {
        match open(key, name) {
            Some(app) => {
                let busy = in_use(qword(app, "LastUsedTimeStart"), qword(app, "LastUsedTimeStop"));
                let _ = RegCloseKey(app);
                busy
            }
            None => false,
        }
    }

    pub fn apps_in_use(kind: &str) -> Vec<String> {
        let mut out = Vec::new();
        unsafe {
            let Some(root) = open(HKEY_CURRENT_USER, &format!(r"{ROOT}\{kind}")) else { return out };
            for name in subkeys(root) {
                if name == "NonPackaged" {
                    if let Some(np) = open(root, &name) {
                        for app in subkeys(np) {
                            if using(np, &app) {
                                out.push(app);
                            }
                        }
                        let _ = RegCloseKey(np);
                    }
                } else if using(root, &name) {
                    out.push(name);
                }
            }
            let _ = RegCloseKey(root);
        }
        out
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn apps_in_use(_kind: &str) -> Vec<String> {
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn in_use_means_started_and_not_stopped() {
        assert!(in_use(133_000_000_000_000_000, 0));
        assert!(!in_use(133_000_000_000_000_000, 133_000_000_100_000_000));
        assert!(!in_use(0, 0));
    }

    #[test]
    fn apps_are_named_by_their_program() {
        assert_eq!(app_label(r"C:#Program Files#Google#Chrome#Application#chrome.exe"), "chrome.exe");
        assert_eq!(app_label("Microsoft.WindowsCamera_8wekyb3d8bbwe"), "Microsoft.WindowsCamera");
        assert_eq!(app_label("zoom.exe"), "zoom.exe");
    }
}
