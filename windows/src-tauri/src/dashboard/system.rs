// The System pill and the dashboard's PC tiles: CPU, temperature, memory, the
// system drive, uptime, network rates, battery and the apps using memory.
//
// Nothing runs on its own. The page asks (`system_stats`) every couple of
// seconds while a card or the dashboard is on screen, and stops when it is
// not, so a hidden island costs nothing. CPU, temperature and network are
// Windows' own performance counters (PDH), the ones Task Manager reads; the
// network rates come from the adapters' byte counters between two asks.
//
// Temperature: most PCs only expose ACPI thermal zones to Windows, which are
// close to — not exactly — the CPU package. When there is none, the card says so.

use serde::Serialize;

/// The apps listed, biggest first.
const TOP_APPS: usize = 12;
/// Never offered "End task": Windows itself, and what the desktop needs to run.
const PROTECTED: &[&str] = &[
    "system", "idle", "registry", "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe",
    "services.exe", "lsass.exe", "svchost.exe", "dwm.exe", "explorer.exe", "fontdrvhost.exe",
    "memory compression", "secure system", "lsaiso.exe", "sihost.exe", "ctfmon.exe",
    "coucou.exe", "coucou-hook.exe", "msmpeng.exe", "audiodg.exe", "spoolsv.exe",
];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Battery {
    pub percent: u8,
    pub charging: bool,
    /// Seconds left on battery, when Windows knows.
    pub secs_left: Option<u32>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct App {
    /// The executable's name, e.g. "chrome.exe".
    pub name: String,
    /// Working set of all its processes, bytes.
    pub mem: u64,
    pub processes: u32,
    /// It has a window on screen; otherwise it runs in the background.
    pub windowed: bool,
    /// "End task" is offered.
    pub can_end: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    /// 0…100; None on the first ask (a rate needs two).
    pub cpu: Option<f64>,
    /// Hottest thermal zone, °C.
    pub temp_c: Option<f64>,
    pub mem_used: u64,
    pub mem_total: u64,
    /// "C:" — the drive Windows runs from.
    pub disk: String,
    pub disk_free: u64,
    pub disk_total: u64,
    pub uptime_secs: u64,
    /// Bytes per second over every network adapter.
    pub net_down: Option<f64>,
    pub net_up: Option<f64>,
    pub battery: Option<Battery>,
    /// Only when asked with `detail`: the scan of every process costs more.
    pub apps: Option<Vec<App>>,
    pub cores: u32,
}

// ── Pure rules (tested anywhere) ──────────────────────────────────────────────

/// ACPI reports tenths of a kelvin through WMI, kelvin through PDH.
pub fn kelvin_to_c(k: f64) -> Option<f64> {
    let c = k - 273.15;
    // A zone that reads 0 K or something absurd is a zone that isn't wired.
    (c > -30.0 && c < 150.0).then(|| (c * 10.0).round() / 10.0)
}

pub fn is_protected(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    PROTECTED.contains(&lower.as_str())
}

/// One row per executable, the processes of an app added together, biggest first.
pub fn group_apps(processes: impl IntoIterator<Item = (String, u64, bool)>) -> Vec<App> {
    let mut by_name: Vec<App> = Vec::new();
    for (name, mem, windowed) in processes {
        if name.is_empty() {
            continue;
        }
        match by_name.iter_mut().find(|a| a.name.eq_ignore_ascii_case(&name)) {
            Some(app) => {
                app.mem += mem;
                app.processes += 1;
                app.windowed |= windowed;
            }
            None => by_name.push(App {
                can_end: !is_protected(&name),
                name,
                mem,
                processes: 1,
                windowed,
            }),
        }
    }
    by_name.sort_by(|a, b| b.mem.cmp(&a.mem).then_with(|| a.name.cmp(&b.name)));
    by_name.truncate(TOP_APPS * 2);
    by_name
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn system_stats(detail: bool) -> Option<SystemStats> {
    tauri::async_runtime::spawn_blocking(move || imp::sample(detail)).await.ok().flatten()
}

/// "End task" on every process of an app; never a protected one.
#[tauri::command]
pub async fn system_end_app(name: String) -> Result<u32, String> {
    if is_protected(&name) {
        return Err("protected".into());
    }
    tauri::async_runtime::spawn_blocking(move || imp::end_app(&name))
        .await
        .map_err(|e| e.to_string())?
}

// ── Windows ───────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Mutex;
    use windows::core::{BOOL, PCWSTR};
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::Performance::*;
    use windows::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    use windows::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows::Win32::System::SystemInformation::{
        GetSystemInfo, GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX, SYSTEM_INFO,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible, GW_OWNER,
    };

    /// The PDH query, kept between asks so the rates have a previous sample.
    struct Counters {
        query: PDH_HQUERY,
        cpu: Option<PDH_HCOUNTER>,
        temp: Option<PDH_HCOUNTER>,
        primed: bool,
    }
    // PDH handles may be used from any thread; the mutex keeps it to one at a time.
    unsafe impl Send for Counters {}

    static COUNTERS: Mutex<Option<Counters>> = Mutex::new(None);

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn add(query: PDH_HQUERY, path: &str) -> Option<PDH_HCOUNTER> {
        let mut counter = PDH_HCOUNTER::default();
        let path = wide(path);
        let status = unsafe { PdhAddEnglishCounterW(query, PCWSTR(path.as_ptr()), 0, &mut counter) };
        (status == 0).then_some(counter)
    }

    fn open() -> Option<Counters> {
        let mut query = PDH_HQUERY::default();
        if unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) } != 0 {
            return None;
        }
        Some(Counters {
            query,
            // What Task Manager's CPU graph shows (turbo included); the older
            // "% Processor Time" where Utility isn't there.
            cpu: add(query, r"\Processor Information(_Total)\% Processor Utility")
                .or_else(|| add(query, r"\Processor(_Total)\% Processor Time")),
            temp: add(query, r"\Thermal Zone Information(*)\Temperature"),
            primed: false,
        })
    }

    fn single(counter: Option<PDH_HCOUNTER>) -> Option<f64> {
        let counter = counter?;
        let mut value = PDH_FMT_COUNTERVALUE::default();
        let status = unsafe { PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, None, &mut value) };
        (status == 0 && value.CStatus == 0).then_some(unsafe { value.Anonymous.doubleValue })
    }

    /// Every instance of a wildcard counter.
    fn array(counter: Option<PDH_HCOUNTER>) -> Option<Vec<f64>> {
        let counter = counter?;
        let (mut size, mut count) = (0u32, 0u32);
        let status = unsafe { PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None) };
        if status != PDH_MORE_DATA || size == 0 {
            return None;
        }
        // The buffer holds the items followed by their names: allocate in items, sized in bytes.
        let item = std::mem::size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>();
        let mut buf: Vec<PDH_FMT_COUNTERVALUE_ITEM_W> = vec![Default::default(); (size as usize).div_ceil(item)];
        let status = unsafe {
            PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(buf.as_mut_ptr()))
        };
        if status != 0 {
            return None;
        }
        Some(
            buf.iter()
                .take(count as usize)
                .filter(|i| i.FmtValue.CStatus == 0)
                .map(|i| unsafe { i.FmtValue.Anonymous.doubleValue })
                .collect(),
        )
    }

    pub fn sample(detail: bool) -> Option<SystemStats> {
        let mut stats = SystemStats::default();

        {
            let mut guard = COUNTERS.lock().ok()?;
            if guard.is_none() {
                *guard = open();
            }
            if let Some(c) = guard.as_mut() {
                let collected = unsafe { PdhCollectQueryData(c.query) } == 0;
                // A rate needs two samples: the very first ask has none to show.
                if collected && c.primed {
                    stats.cpu = single(c.cpu).map(|v| v.clamp(0.0, 100.0));
                }
                if collected {
                    stats.temp_c = array(c.temp)
                        .and_then(|zones| zones.into_iter().filter_map(kelvin_to_c).reduce(f64::max));
                }
                c.primed |= collected;
            }
        }

        if let Some((down, up)) = net_rates() {
            stats.net_down = Some(down);
            stats.net_up = Some(up);
        }

        let mut mem = MEMORYSTATUSEX { dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
        if unsafe { GlobalMemoryStatusEx(&mut mem) }.is_ok() {
            stats.mem_total = mem.ullTotalPhys;
            stats.mem_used = mem.ullTotalPhys.saturating_sub(mem.ullAvailPhys);
        }

        let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into());
        let root = wide(&format!("{drive}\\"));
        let (mut free, mut total) = (0u64, 0u64);
        if unsafe { GetDiskFreeSpaceExW(PCWSTR(root.as_ptr()), Some(&mut free), Some(&mut total), None) }.is_ok() {
            stats.disk_free = free;
            stats.disk_total = total;
        }
        stats.disk = drive;

        stats.uptime_secs = unsafe { GetTickCount64() } / 1000;

        let mut info = SYSTEM_INFO::default();
        unsafe { GetSystemInfo(&mut info) };
        stats.cores = info.dwNumberOfProcessors;

        let mut power = SYSTEM_POWER_STATUS::default();
        if unsafe { GetSystemPowerStatus(&mut power) }.is_ok() {
            // 128 = no system battery, 255 = unknown: a desktop PC.
            if power.BatteryFlag & 128 == 0 && power.BatteryLifePercent <= 100 {
                stats.battery = Some(Battery {
                    percent: power.BatteryLifePercent,
                    charging: power.ACLineStatus == 1,
                    secs_left: (power.BatteryLifeTime != u32::MAX).then_some(power.BatteryLifeTime),
                });
            }
        }

        if detail {
            stats.apps = Some(group_apps(processes()));
        }
        Some(stats)
    }

    /// The previous byte counts, for the rates.
    static NET_PREV: Mutex<Option<(u64, u64, std::time::Instant)>> = Mutex::new(None);

    /// Bytes per second down and up over the physical adapters that are up,
    /// from their octet counters (the network performance counters are not on
    /// every PC). None on the first ask.
    fn net_rates() -> Option<(f64, f64)> {
        use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
        use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
        let (mut rx, mut tx) = (0u64, 0u64);
        unsafe {
            let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
            if GetIfTable2(&mut table).is_err() || table.is_null() {
                return None;
            }
            let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
            for row in rows {
                // Bit 0: a hardware interface (not a filter, a tunnel or the loopback).
                let hardware = row.InterfaceAndOperStatusFlags._bitfield & 1 == 1;
                if hardware && row.OperStatus == IfOperStatusUp && row.Type != 24 {
                    rx += row.InOctets;
                    tx += row.OutOctets;
                }
            }
            FreeMibTable(table as *const _);
        }
        let now = std::time::Instant::now();
        let mut prev = NET_PREV.lock().ok()?;
        let out = prev.and_then(|(prx, ptx, at)| {
            let secs = now.duration_since(at).as_secs_f64();
            (secs > 0.2).then(|| (rx.saturating_sub(prx) as f64 / secs, tx.saturating_sub(ptx) as f64 / secs))
        });
        *prev = Some((rx, tx, now));
        out
    }

    /// Processes that own a visible, titled, top-level window: the "apps" of Task Manager.
    fn windowed_pids() -> HashSet<u32> {
        unsafe extern "system" fn each(hwnd: HWND, data: LPARAM) -> BOOL {
            let pids = &mut *(data.0 as *mut HashSet<u32>);
            let owned = GetWindow(hwnd, GW_OWNER).is_ok_and(|o| !o.is_invalid());
            if IsWindowVisible(hwnd).as_bool() && !owned && GetWindowTextLengthW(hwnd) > 0 {
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                pids.insert(pid);
            }
            BOOL(1)
        }
        let mut pids = HashSet::new();
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut pids as *mut _ as isize));
        }
        pids
    }

    /// (executable name, working set, has a window) for every process we may read.
    fn processes() -> Vec<(String, u64, bool)> {
        let windowed = windowed_pids();
        let mut out = Vec::new();
        for (pid, name) in snapshot() {
            let mem = unsafe {
                match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                    Ok(handle) => {
                        let mut counters = PROCESS_MEMORY_COUNTERS::default();
                        let size = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
                        let ok = K32GetProcessMemoryInfo(handle, &mut counters, size).as_bool();
                        let _ = CloseHandle(handle);
                        if ok { counters.WorkingSetSize as u64 } else { 0 }
                    }
                    Err(_) => 0,
                }
            };
            if mem > 0 {
                out.push((name, mem, windowed.contains(&pid)));
            }
        }
        out
    }

    fn snapshot() -> Vec<(u32, String)> {
        let mut out = Vec::new();
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
            let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut more = Process32FirstW(snap, &mut entry).is_ok();
            while more {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                out.push((entry.th32ProcessID, String::from_utf16_lossy(&entry.szExeFile[..len])));
                more = Process32NextW(snap, &mut entry).is_ok();
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    pub fn end_app(name: &str) -> Result<u32, String> {
        let me = std::process::id();
        let mut ended = 0;
        for (pid, exe) in snapshot() {
            if pid == me || pid <= 4 || !exe.eq_ignore_ascii_case(name) {
                continue;
            }
            unsafe {
                if let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) {
                    if TerminateProcess(handle, 1).is_ok() {
                        ended += 1;
                    }
                    let _ = CloseHandle(handle);
                }
            }
        }
        if ended == 0 {
            Err("not allowed".into())
        } else {
            Ok(ended)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn sample(_detail: bool) -> Option<SystemStats> {
        None
    }
    pub fn end_app(_name: &str) -> Result<u32, String> {
        Err("unsupported".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thermal_zones_read_in_celsius_and_unwired_ones_are_dropped() {
        assert_eq!(kelvin_to_c(301.0), Some(27.9));
        assert_eq!(kelvin_to_c(0.0), None);
        assert_eq!(kelvin_to_c(600.0), None);
    }

    #[test]
    fn processes_of_one_app_add_up_and_the_biggest_comes_first() {
        let apps = group_apps(vec![
            ("chrome.exe".to_string(), 100, false),
            ("Code.exe".to_string(), 300, true),
            ("chrome.exe".to_string(), 250, true),
            (String::new(), 999, true),
        ]);
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].name, "chrome.exe");
        assert_eq!(apps[0].mem, 350);
        assert_eq!(apps[0].processes, 2);
        assert!(apps[0].windowed);
        assert!(apps[0].can_end);
    }

    #[test]
    fn windows_own_processes_are_never_offered_end_task() {
        for name in ["svchost.exe", "CSRSS.EXE", "explorer.exe", "coucou.exe", "System"] {
            assert!(is_protected(name), "{name}");
        }
        assert!(!is_protected("chrome.exe"));
        let apps = group_apps(vec![("dwm.exe".to_string(), 10, false)]);
        assert!(!apps[0].can_end);
    }
}


