// PC cleanup — see what the caches take, then clear the ones you pick.
//
// The page never sends a path to delete. It sends item ids, and this file works
// out what each one is: a fixed list of caches (temporary files older than a
// day, the browsers' cache folders, npm's and pip's caches, the Recycle Bin),
// or a project's build folder — `target` next to a Cargo.toml, `node_modules`
// next to a package.json — somewhere under the user's home folder. Nothing
// else can be removed, symlinks are never followed, and a file in use is just
// left. A scan only reads.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

const TEMP_AGE: Duration = Duration::from_secs(24 * 3600);
/// Build folders smaller than this aren't worth listing.
const MIN_PROJECT_BYTES: u64 = 50 * 1024 * 1024;
const MAX_DEPTH: usize = 4;
const MAX_VISITED: usize = 120_000;
/// Folders a project scan never goes into.
const SKIP_DIRS: &[&str] = &[
    "appdata", ".git", ".cargo", ".rustup", ".npm", "node_modules", "target", "windows", "onedrive", "$recycle.bin",
    "music", "videos", "pictures", "downloads", "documents", "desktop", ".vscode", ".claude", ".gradle", ".m2",
    // Huge trees that never hold a project to clean.
    "venv", ".venv", "myenv", "env", "site-packages", "android-sdk", "android-tools", "platform-tools", "go", "virtualbox vms",
    "cache", ".cache", "nuclei-templates", "wordlists", "cve", "cwe", "shared", "logs", "data", "scoop", "vendor",
];

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    /// "temp", "chrome", "edge", "npm", "pip", "recycle" or "proj:<path>".
    pub id: String,
    /// "temp", "browser", "dev", "recycle" or "project": what the page calls it.
    pub kind: String,
    pub label: String,
    pub path: String,
    pub bytes: u64,
}

// ── Pure rules ────────────────────────────────────────────────────────────────

/// Total size of a folder, not following links.
pub fn dir_size(root: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total += meta.len();
            }
        }
    }
    total
}

/// May this be removed as a project's build folder? Only `target` beside a
/// Cargo.toml or `node_modules` beside a package.json, a real folder (not a
/// link), strictly inside `home`.
pub fn allowed_project(path: &Path, home: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return false };
    let marker = match name {
        "target" => "Cargo.toml",
        "node_modules" => "package.json",
        _ => return false,
    };
    let Some(parent) = path.parent() else { return false };
    let Ok(meta) = fs::symlink_metadata(path) else { return false };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return false;
    }
    let (Ok(real), Ok(home)) = (path.canonicalize(), home.canonicalize()) else { return false };
    real.starts_with(&home) && real != home && parent.join(marker).is_file()
}

/// Build folders under `home` (depth-limited), biggest first.
pub fn find_projects(home: &Path) -> Vec<Item> {
    let mut found = Vec::new();
    let mut visited = 0usize;
    let mut stack = vec![(home.to_path_buf(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            visited += 1;
            if visited > MAX_VISITED {
                return sorted(found);
            }
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if !meta.is_dir() || meta.file_type().is_symlink() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if allowed_project(&path, home) {
                let bytes = dir_size(&path);
                if bytes >= MIN_PROJECT_BYTES {
                    let project = path.parent().and_then(|p| p.file_name()).and_then(|n| n.to_str()).unwrap_or("");
                    found.push(Item {
                        id: format!("proj:{}", path.display()),
                        kind: "project".into(),
                        label: format!("{project} · {}", path.file_name().and_then(|n| n.to_str()).unwrap_or("")),
                        path: path.display().to_string(),
                        bytes,
                    });
                }
                continue;
            }
            if depth < MAX_DEPTH && !SKIP_DIRS.contains(&name.as_str()) {
                stack.push((path, depth + 1));
            }
        }
    }
    sorted(found)
}

fn sorted(mut items: Vec<Item>) -> Vec<Item> {
    items.sort_by(|a, b| b.bytes.cmp(&a.bytes));
    items
}

/// Bytes of files in `dir` older than `age`.
pub fn old_files_size(dir: &Path, age: Duration) -> u64 {
    let cutoff = SystemTime::now().checked_sub(age);
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.modified().ok().zip(cutoff).is_some_and(|(m, c)| m < c) {
                total += meta.len();
            }
        }
    }
    total
}

/// Removes files in `dir` older than `age` (and folders left empty); returns the bytes freed.
pub fn remove_old_files(dir: &Path, age: Duration) -> u64 {
    let cutoff = SystemTime::now().checked_sub(age);
    let mut freed = 0u64;
    let mut dirs = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(entries) = fs::read_dir(&d) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                dirs.push(path.clone());
                stack.push(path);
            } else if meta.modified().ok().zip(cutoff).is_some_and(|(m, c)| m < c) && fs::remove_file(&path).is_ok() {
                freed += meta.len();
            }
        }
    }
    // Deepest first; remove_dir only succeeds on an empty folder.
    dirs.sort_by_key(|d| std::cmp::Reverse(d.components().count()));
    for d in dirs {
        let _ = fs::remove_dir(&d);
    }
    freed
}

/// Empties a cache folder but keeps the folder; returns the bytes freed.
pub fn clear_folder(dir: &Path) -> u64 {
    remove_old_files(dir, Duration::ZERO)
}

// ── Where things are ──────────────────────────────────────────────────────────

fn env_path(var: &str) -> Option<PathBuf> {
    std::env::var_os(var).map(PathBuf::from)
}

/// The fixed caches: (id, kind, label, folder, only files older than a day).
fn fixed() -> Vec<(&'static str, &'static str, &'static str, PathBuf, bool)> {
    let mut out = Vec::new();
    if let Some(temp) = env_path("TEMP") {
        out.push(("temp", "temp", "Temporary files", temp, true));
    }
    if let Some(local) = env_path("LOCALAPPDATA") {
        out.push(("chrome", "browser", "Chrome cache", local.join(r"Google\Chrome\User Data\Default\Cache"), false));
        out.push(("edge", "browser", "Edge cache", local.join(r"Microsoft\Edge\User Data\Default\Cache"), false));
        out.push(("npm", "dev", "npm cache", local.join("npm-cache"), false));
        out.push(("pip", "dev", "pip cache", local.join(r"pip\Cache"), false));
    }
    out
}

pub fn scan_all() -> Vec<Item> {
    let mut items = Vec::new();
    for (id, kind, label, path, old_only) in fixed() {
        if !path.is_dir() {
            continue;
        }
        let bytes = if old_only { old_files_size(&path, TEMP_AGE) } else { dir_size(&path) };
        if bytes > 0 {
            items.push(Item { id: id.into(), kind: kind.into(), label: label.into(), path: path.display().to_string(), bytes });
        }
    }
    let bin = imp::recycle_bin_bytes();
    if bin > 0 {
        items.push(Item { id: "recycle".into(), kind: "recycle".into(), label: "Recycle Bin".into(), path: String::new(), bytes: bin });
    }
    if let Some(home) = env_path("USERPROFILE") {
        items.extend(find_projects(&home));
    }
    sorted(items)
}

/// Clears what `ids` name; returns the bytes freed.
pub fn clean(ids: &[String]) -> u64 {
    clean_in(ids, env_path("USERPROFILE").as_deref())
}

/// `clean`, with the home folder project folders must be inside.
pub fn clean_in(ids: &[String], home: Option<&Path>) -> u64 {
    let mut freed = 0u64;
    for id in ids {
        if let Some(path) = id.strip_prefix("proj:") {
            let path = PathBuf::from(path);
            if let Some(home) = home {
                if allowed_project(&path, home) {
                    let before = dir_size(&path);
                    if fs::remove_dir_all(&path).is_ok() {
                        freed += before;
                    } else {
                        // Partly removed (a file in use): count what went.
                        freed += before.saturating_sub(dir_size(&path));
                    }
                }
            }
        } else if id == "recycle" {
            freed += imp::empty_recycle_bin();
        } else if let Some((_, _, _, path, old_only)) = fixed().into_iter().find(|f| f.0 == id) {
            if path.is_dir() {
                freed += if old_only { remove_old_files(&path, TEMP_AGE) } else { clear_folder(&path) };
            }
        }
    }
    freed
}

// ── Commands ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn cleanup_scan() -> Vec<Item> {
    tauri::async_runtime::spawn_blocking(scan_all).await.unwrap_or_default()
}

#[tauri::command]
pub async fn cleanup_run(ids: Vec<String>) -> u64 {
    let freed = tauri::async_runtime::spawn_blocking(move || clean(&ids)).await.unwrap_or(0);
    crate::log::line(format!("cleanup freed {} MB", freed / (1024 * 1024)));
    freed
}

#[cfg(windows)]
mod imp {
    use windows::core::PCWSTR;
    use windows::Win32::UI::Shell::{
        SHEmptyRecycleBinW, SHQueryRecycleBinW, SHERB_NOCONFIRMATION, SHERB_NOPROGRESSUI, SHERB_NOSOUND, SHQUERYRBINFO,
    };

    pub fn recycle_bin_bytes() -> u64 {
        let mut info = SHQUERYRBINFO { cbSize: std::mem::size_of::<SHQUERYRBINFO>() as u32, ..Default::default() };
        match unsafe { SHQueryRecycleBinW(PCWSTR::null(), &mut info) } {
            Ok(()) => info.i64Size.max(0) as u64,
            Err(_) => 0,
        }
    }

    pub fn empty_recycle_bin() -> u64 {
        let before = recycle_bin_bytes();
        let _ = unsafe {
            SHEmptyRecycleBinW(None, PCWSTR::null(), SHERB_NOCONFIRMATION | SHERB_NOPROGRESSUI | SHERB_NOSOUND)
        };
        before.saturating_sub(recycle_bin_bytes())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn recycle_bin_bytes() -> u64 {
        0
    }
    pub fn empty_recycle_bin() -> u64 {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coucou-cleanup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn only_a_build_folder_beside_its_project_file_can_go() {
        let home = scratch("allow");
        let app = home.join("code").join("app");
        write(&app.join("Cargo.toml"), 10);
        write(&app.join("target").join("debug").join("big.bin"), 100);
        write(&app.join("src").join("main.rs"), 10);
        let web = home.join("code").join("web");
        write(&web.join("package.json"), 10);
        write(&web.join("node_modules").join("x").join("i.js"), 10);
        let lonely = home.join("code").join("loose");
        write(&lonely.join("target").join("a.bin"), 10); // no Cargo.toml beside it

        assert!(allowed_project(&app.join("target"), &home));
        assert!(allowed_project(&web.join("node_modules"), &home));
        // Not a build folder, no project file, a file, home itself, outside home.
        assert!(!allowed_project(&app.join("src"), &home));
        assert!(!allowed_project(&lonely.join("target"), &home));
        assert!(!allowed_project(&app.join("Cargo.toml"), &home));
        assert!(!allowed_project(&home, &home));
        assert!(!allowed_project(&app.join("target"), &scratch("elsewhere")));
        assert!(!allowed_project(Path::new(r"C:\Windows\target"), &home));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_scan_finds_big_build_folders_and_a_clean_removes_only_those() {
        let home = scratch("scan");
        let app = home.join("proj");
        write(&app.join("Cargo.toml"), 10);
        write(&app.join("target").join("big.bin"), (MIN_PROJECT_BYTES + 1) as usize);
        write(&app.join("src").join("keep.rs"), 10);
        let small = home.join("small");
        write(&small.join("Cargo.toml"), 10);
        write(&small.join("target").join("tiny.bin"), 100);

        let items = find_projects(&home);
        assert_eq!(items.len(), 1, "{items:?}");
        assert!(items[0].id.starts_with("proj:") && items[0].bytes > MIN_PROJECT_BYTES);

        let id = items[0].id.clone();
        let freed = clean_in(&[id, "proj:C:\\Windows".into(), "../../etc".into()], Some(&home));
        assert!(freed > MIN_PROJECT_BYTES);
        assert!(!app.join("target").exists());
        assert!(app.join("src").join("keep.rs").exists(), "source stays");
        assert!(app.join("Cargo.toml").exists());
        assert!(small.join("target").join("tiny.bin").exists(), "only what was named");
        let _ = fs::remove_dir_all(&home);
    }

    /// Reads this PC for real (never deletes): `cargo test live_scan -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_scan_times_itself() {
        let start = std::time::Instant::now();
        let items = scan_all();
        println!("scan took {:?}, {} items", start.elapsed(), items.len());
        for i in items.iter().take(12) {
            println!("  {:>8.1} MB  {:<10} {}", i.bytes as f64 / 1048576.0, i.kind, i.path);
        }
    }

    #[test]
    fn temporary_files_only_go_when_old_enough() {
        let dir = scratch("temp");
        write(&dir.join("fresh.tmp"), 100);
        write(&dir.join("sub").join("also-fresh.tmp"), 100);
        assert_eq!(old_files_size(&dir, TEMP_AGE), 0);
        assert_eq!(remove_old_files(&dir, TEMP_AGE), 0);
        assert!(dir.join("fresh.tmp").exists());
        // Age zero: everything counts, files go, folders left empty go too.
        assert_eq!(remove_old_files(&dir, Duration::ZERO), 200);
        assert!(!dir.join("sub").exists());
        assert!(dir.exists(), "the folder itself stays");
        let _ = fs::remove_dir_all(&dir);
    }
}
