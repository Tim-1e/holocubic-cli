use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::client::CubicClient;
use crate::config::absolute_path;
use crate::error::{CubicError, Result};
use crate::model::{RemoteStat, TransferLimits, TransferSummary};
use crate::remote_path::{
    normalize_remote_path, remote_basename, remote_join, safe_local_destination,
};

#[derive(Debug, Clone)]
pub struct TransferProgress {
    pub phase: &'static str,
    pub path: String,
    pub transferred_bytes: u64,
    pub total_bytes: u64,
    pub completed_entries: usize,
    pub total_entries: usize,
}

pub type ProgressCallback<'a> = Option<&'a dyn Fn(&TransferProgress)>;

#[derive(Debug)]
struct LocalFile {
    absolute: PathBuf,
    relative: String,
    size: u64,
}

#[derive(Debug)]
struct RemoteFile {
    remote: String,
    relative: String,
    size: u64,
}

fn suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{}-{nanos:x}", std::process::id())
}

fn transient(error: &CubicError) -> bool {
    error.status.is_some_and(|status| status >= 500)
        || matches!(error.code, "TIMEOUT" | "CONNECTION_ERROR")
}

fn with_retry<T>(mut operation: impl FnMut() -> Result<T>, retries: usize) -> Result<T> {
    for attempt in 0..=retries {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if transient(&error) && attempt < retries => {
                thread::sleep(Duration::from_millis(100 * 2_u64.pow(attempt as u32)));
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("retry loop always returns")
}

pub fn ensure_remote_directory(client: &CubicClient, remote_directory: &str) -> Result<()> {
    let normalized = normalize_remote_path(Some(remote_directory))?;
    if normalized == "/sd" {
        return Ok(());
    }
    let mut current = "/sd".to_owned();
    for segment in normalized[4..].split('/') {
        current = remote_join(&current, segment)?;
        match client.stat_or_none(&current)? {
            None => client.mkdir(&current)?,
            Some(stat) if stat.is_dir => {}
            Some(_) => {
                return Err(CubicError::new(
                    format!("Remote parent is a file: {current}"),
                    "PATH_CONFLICT",
                ));
            }
        }
    }
    Ok(())
}

fn remove_remote_path(client: &CubicClient, remote_path: &str) -> Result<()> {
    if let Some(target) = client.stat_or_none(remote_path)? {
        if target.is_dir {
            client.rmdir(remote_path, true)?;
        } else {
            client.remove(remote_path)?;
        }
    }
    Ok(())
}

fn commit_remote(
    client: &CubicClient,
    temporary: &str,
    target: &str,
    current_target: Option<&RemoteStat>,
    force: bool,
) -> Result<()> {
    if current_target.is_some() && !force {
        return Err(CubicError::new(
            format!("Remote target already exists: {target}. Use --force to replace it."),
            "TARGET_EXISTS",
        ));
    }
    let backup = format!("{target}.cubic-backup-{}", suffix());
    let backed_up = current_target.is_some();
    if backed_up {
        client.rename(target, &backup)?;
    }
    if let Err(error) = client.rename(temporary, target) {
        if backed_up {
            let _ = client.rename(&backup, target);
        }
        return Err(CubicError::new(
            format!("Unable to commit remote target {target}: {error}"),
            "COMMIT_FAILED",
        ));
    }
    if backed_up {
        remove_remote_path(client, &backup)?;
    }
    Ok(())
}

fn relative_join(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_owned()
    } else {
        format!("{parent}/{name}")
    }
}

fn scan_local_tree(
    root: &Path,
    limits: TransferLimits,
) -> Result<(Vec<String>, Vec<LocalFile>, u64)> {
    struct LocalScan {
        limits: TransferLimits,
        entries: usize,
        directories: Vec<String>,
        files: Vec<LocalFile>,
        total_bytes: u64,
    }

    impl LocalScan {
        fn visit(&mut self, absolute: &Path, relative: &str, depth: usize) -> Result<()> {
            if depth > self.limits.max_depth {
                return Err(CubicError::new(
                    format!(
                        "Local directory exceeds maximum depth {}: {}",
                        self.limits.max_depth,
                        absolute.display()
                    ),
                    "TREE_LIMIT",
                ));
            }
            let mut children = fs::read_dir(absolute)
                .map_err(|error| {
                    CubicError::new(
                        format!(
                            "Unable to read local directory {}: {error}",
                            absolute.display()
                        ),
                        "LOCAL_READ_ERROR",
                    )
                })?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|error| {
                    CubicError::new(
                        format!("Unable to read local directory: {error}"),
                        "LOCAL_READ_ERROR",
                    )
                })?;
            children.sort_by_key(|entry| entry.file_name());
            for child in children {
                self.entries += 1;
                if self.entries > self.limits.max_entries {
                    return Err(CubicError::new(
                        format!(
                            "Local directory exceeds maximum entries {}.",
                            self.limits.max_entries
                        ),
                        "TREE_LIMIT",
                    ));
                }
                let name = child.file_name().to_string_lossy().into_owned();
                let child_relative = relative_join(relative, &name);
                let metadata = fs::symlink_metadata(child.path()).map_err(|error| {
                    CubicError::new(
                        format!("Unable to inspect local entry: {error}"),
                        "LOCAL_READ_ERROR",
                    )
                })?;
                if metadata.file_type().is_symlink() {
                    return Err(CubicError::new(
                        format!(
                            "Symbolic links are not followed: {}",
                            child.path().display()
                        ),
                        "SYMLINK_REJECTED",
                    ));
                }
                if metadata.is_dir() {
                    self.directories.push(child_relative.clone());
                    self.visit(&child.path(), &child_relative, depth + 1)?;
                } else if metadata.is_file() {
                    self.files.push(LocalFile {
                        absolute: child.path(),
                        relative: child_relative,
                        size: metadata.len(),
                    });
                    self.total_bytes += metadata.len();
                } else {
                    return Err(CubicError::new(
                        format!(
                            "Unsupported local filesystem entry: {}",
                            child.path().display()
                        ),
                        "UNSUPPORTED_ENTRY",
                    ));
                }
            }
            Ok(())
        }
    }

    let mut scan = LocalScan {
        limits,
        entries: 0,
        directories: Vec::new(),
        files: Vec::new(),
        total_bytes: 0,
    };
    scan.visit(root, "", 0)?;
    Ok((scan.directories, scan.files, scan.total_bytes))
}

fn scan_remote_tree(
    client: &CubicClient,
    root: &str,
    limits: TransferLimits,
) -> Result<(Vec<String>, Vec<RemoteFile>, u64)> {
    struct Scanner<'a> {
        client: &'a CubicClient,
        limits: TransferLimits,
        entries: usize,
        total_bytes: u64,
        seen: HashSet<String>,
        directories: Vec<String>,
        files: Vec<RemoteFile>,
    }

    impl Scanner<'_> {
        fn visit(&mut self, current: &str, relative: &str, depth: usize) -> Result<()> {
            if depth > self.limits.max_depth {
                return Err(CubicError::new(
                    format!(
                        "Remote directory exceeds maximum depth {}: {current}",
                        self.limits.max_depth
                    ),
                    "TREE_LIMIT",
                ));
            }
            for item in self.client.list(current)?.items {
                self.entries += 1;
                if self.entries > self.limits.max_entries {
                    return Err(CubicError::new(
                        format!(
                            "Remote directory exceeds maximum entries {}.",
                            self.limits.max_entries
                        ),
                        "TREE_LIMIT",
                    ));
                }
                let expected = remote_join(current, &item.name)?;
                if item.path != expected {
                    return Err(CubicError::new(
                        format!(
                            "Unsafe directory entry path returned by device: {}",
                            item.path
                        ),
                        "UNSAFE_REMOTE_ENTRY",
                    ));
                }
                let item_relative = relative_join(relative, &item.name);
                if !self.seen.insert(item_relative.clone()) {
                    return Err(CubicError::new(
                        format!("Duplicate remote directory entry: {item_relative}"),
                        "INVALID_RESPONSE",
                    ));
                }
                if item.is_dir {
                    self.directories.push(item_relative.clone());
                    self.visit(&item.path, &item_relative, depth + 1)?;
                } else {
                    self.total_bytes += item.size;
                    if self.total_bytes > self.limits.max_download_bytes {
                        return Err(CubicError::new(
                            format!(
                                "Remote directory exceeds download limit {} bytes.",
                                self.limits.max_download_bytes
                            ),
                            "TREE_LIMIT",
                        ));
                    }
                    self.files.push(RemoteFile {
                        remote: item.path,
                        relative: item_relative,
                        size: item.size,
                    });
                }
            }
            Ok(())
        }
    }

    let mut scanner = Scanner {
        client,
        limits,
        entries: 0,
        total_bytes: 0,
        seen: HashSet::new(),
        directories: Vec::new(),
        files: Vec::new(),
    };
    scanner.visit(root, "", 0)?;
    Ok((scanner.directories, scanner.files, scanner.total_bytes))
}

pub fn upload_file(
    client: &CubicClient,
    local_file: &Path,
    remote_file: &str,
    force: bool,
    retries: usize,
    progress: ProgressCallback<'_>,
) -> Result<TransferSummary> {
    let source = absolute_path(local_file)?;
    let metadata = fs::symlink_metadata(&source).map_err(|error| {
        CubicError::new(
            format!("Unable to inspect {}: {error}", source.display()),
            "LOCAL_READ_ERROR",
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(CubicError::new(
            format!("Symbolic links are not followed: {}", source.display()),
            "SYMLINK_REJECTED",
        ));
    }
    if !metadata.is_file() {
        return Err(CubicError::new(
            format!("Local source is not a file: {}", source.display()),
            "NOT_A_FILE",
        ));
    }
    let target = normalize_remote_path(Some(remote_file))?;
    let info = client.info(false)?;
    if metadata.len() > info.max_file_size {
        return Err(CubicError::new(
            format!(
                "Local file is {} bytes; device limit is {} bytes.",
                metadata.len(),
                info.max_file_size
            ),
            "FILE_TOO_LARGE",
        ));
    }
    let current_target = client.stat_or_none(&target)?;
    if current_target.as_ref().is_some_and(|value| value.is_dir) {
        return Err(CubicError::new(
            format!("Remote target is a directory: {target}"),
            "PATH_CONFLICT",
        ));
    }
    if current_target.is_some() && !force {
        return Err(CubicError::new(
            format!("Remote target already exists: {target}. Use --force to replace it."),
            "TARGET_EXISTS",
        ));
    }
    let parent = target
        .rsplit_once('/')
        .map(|value| value.0)
        .unwrap_or("/sd");
    ensure_remote_directory(client, parent)?;
    let temporary = format!("{target}.cubic-upload-{}", suffix());
    let result = (|| {
        let mut offset = 0_u64;
        if metadata.len() == 0 {
            let uploaded = with_retry(|| client.upload(&temporary, &[], 0, 0), retries)?;
            if !uploaded.done || uploaded.next_offset != 0 {
                return Err(CubicError::new(
                    "Device did not complete the empty upload.",
                    "INVALID_RESPONSE",
                ));
            }
        } else {
            let mut file = File::open(&source).map_err(|error| {
                CubicError::new(
                    format!("Unable to open {}: {error}", source.display()),
                    "LOCAL_READ_ERROR",
                )
            })?;
            while offset < metadata.len() {
                let length = (info.chunk_size.min(metadata.len() - offset)) as usize;
                let mut buffer = vec![0_u8; length];
                file.read_exact(&mut buffer).map_err(|error| {
                    CubicError::new(
                        format!("Unexpected end of local file {}: {error}", source.display()),
                        "LOCAL_READ_ERROR",
                    )
                })?;
                let uploaded = with_retry(
                    || client.upload(&temporary, &buffer, offset, metadata.len()),
                    retries,
                )?;
                if uploaded.next_offset != offset + length as u64
                    || uploaded.total != metadata.len()
                {
                    return Err(CubicError::new(
                        format!("Device returned an invalid upload offset for {target}."),
                        "INVALID_RESPONSE",
                    ));
                }
                offset = uploaded.next_offset;
                if let Some(callback) = progress {
                    callback(&TransferProgress {
                        phase: "upload",
                        path: target.clone(),
                        transferred_bytes: offset,
                        total_bytes: metadata.len(),
                        completed_entries: usize::from(offset == metadata.len()),
                        total_entries: 1,
                    });
                }
            }
        }
        let uploaded = client.stat(&temporary)?;
        if uploaded.is_dir || uploaded.size != metadata.len() {
            return Err(CubicError::new(
                format!("Remote upload verification failed for {target}."),
                "VERIFY_FAILED",
            ));
        }
        if let Some(callback) = progress {
            callback(&TransferProgress {
                phase: "commit",
                path: target.clone(),
                transferred_bytes: metadata.len(),
                total_bytes: metadata.len(),
                completed_entries: 1,
                total_entries: 1,
            });
        }
        commit_remote(client, &temporary, &target, current_target.as_ref(), force)?;
        Ok(TransferSummary {
            source: source.to_string_lossy().into_owned(),
            destination: target,
            files: 1,
            directories: 0,
            bytes: metadata.len(),
        })
    })();
    if result.is_err() {
        let _ = remove_remote_path(client, &temporary);
    }
    result
}

pub fn upload_path(
    client: &CubicClient,
    local_source: &Path,
    remote_destination: Option<&str>,
    force: bool,
    retries: usize,
    limits: TransferLimits,
    progress: ProgressCallback<'_>,
) -> Result<TransferSummary> {
    let source = absolute_path(local_source)?;
    let metadata = fs::symlink_metadata(&source).map_err(|error| {
        CubicError::new(
            format!("Unable to inspect {}: {error}", source.display()),
            "LOCAL_READ_ERROR",
        )
    })?;
    if metadata.file_type().is_symlink() {
        return Err(CubicError::new(
            format!("Symbolic links are not followed: {}", source.display()),
            "SYMLINK_REJECTED",
        ));
    }
    let basename = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| CubicError::new("Local source has no valid name.", "PATH_ERROR"))?;
    let default_target = remote_join("/sd", basename)?;
    let target = normalize_remote_path(Some(remote_destination.unwrap_or(&default_target)))?;
    if metadata.is_file() {
        return upload_file(client, &source, &target, force, retries, progress);
    }
    if !metadata.is_dir() {
        return Err(CubicError::new(
            format!("Unsupported local source: {}", source.display()),
            "UNSUPPORTED_ENTRY",
        ));
    }
    if let Some(callback) = progress {
        callback(&TransferProgress {
            phase: "scan",
            path: source.to_string_lossy().into_owned(),
            transferred_bytes: 0,
            total_bytes: 0,
            completed_entries: 0,
            total_entries: 0,
        });
    }
    let (directories, files, total_bytes) = scan_local_tree(&source, limits)?;
    let info = client.info(false)?;
    if let Some(file) = files.iter().find(|file| file.size > info.max_file_size) {
        return Err(CubicError::new(
            format!(
                "Local file is {} bytes; device limit is {}: {}",
                file.size,
                info.max_file_size,
                file.absolute.display()
            ),
            "FILE_TOO_LARGE",
        ));
    }
    let current_target = client.stat_or_none(&target)?;
    if current_target.is_some() && !force {
        return Err(CubicError::new(
            format!("Remote target already exists: {target}. Use --force to replace it."),
            "TARGET_EXISTS",
        ));
    }
    let parent = target
        .rsplit_once('/')
        .map(|value| value.0)
        .unwrap_or("/sd");
    ensure_remote_directory(client, parent)?;
    let temporary = format!("{target}.cubic-upload-{}", suffix());
    let result = (|| {
        client.mkdir(&temporary)?;
        let mut completed = 0;
        for directory in &directories {
            ensure_remote_directory(client, &format!("{temporary}/{directory}"))?;
            completed += 1;
        }
        let mut transferred = 0;
        for file in &files {
            let before = transferred;
            let child = |event: &TransferProgress| {
                if let Some(callback) = progress {
                    callback(&TransferProgress {
                        phase: event.phase,
                        path: file.relative.clone(),
                        transferred_bytes: before + event.transferred_bytes,
                        total_bytes,
                        completed_entries: completed,
                        total_entries: directories.len() + files.len(),
                    });
                }
            };
            upload_file(
                client,
                &file.absolute,
                &format!("{temporary}/{}", file.relative),
                false,
                retries,
                Some(&child),
            )?;
            transferred += file.size;
            completed += 1;
        }
        if let Some(callback) = progress {
            callback(&TransferProgress {
                phase: "commit",
                path: target.clone(),
                transferred_bytes: total_bytes,
                total_bytes,
                completed_entries: completed,
                total_entries: directories.len() + files.len(),
            });
        }
        commit_remote(client, &temporary, &target, current_target.as_ref(), force)?;
        Ok(TransferSummary {
            source: source.to_string_lossy().into_owned(),
            destination: target,
            files: files.len(),
            directories: directories.len() + 1,
            bytes: total_bytes,
        })
    })();
    if result.is_err() {
        let _ = remove_remote_path(client, &temporary);
    }
    result
}

fn remove_local(path: &Path) -> std::io::Result<()> {
    if fs::symlink_metadata(path)?.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn commit_local(temporary: &Path, target: &Path, current: bool, force: bool) -> Result<()> {
    if current && !force {
        return Err(CubicError::new(
            format!(
                "Local target already exists: {}. Use --force to replace it.",
                target.display()
            ),
            "TARGET_EXISTS",
        ));
    }
    let backup = target.with_extension(format!("cubic-backup-{}", suffix()));
    if current {
        fs::rename(target, &backup).map_err(|error| {
            CubicError::new(
                format!("Unable to back up local target: {error}"),
                "COMMIT_FAILED",
            )
        })?;
    }
    if let Err(error) = fs::rename(temporary, target) {
        if current {
            let _ = fs::rename(&backup, target);
        }
        return Err(CubicError::new(
            format!(
                "Unable to commit local target {}: {error}",
                target.display()
            ),
            "COMMIT_FAILED",
        ));
    }
    if current {
        let _ = remove_local(&backup);
    }
    Ok(())
}

pub fn download_file(
    client: &CubicClient,
    remote_file: &str,
    local_file: &Path,
    force: bool,
    retries: usize,
    limits: TransferLimits,
    progress: ProgressCallback<'_>,
) -> Result<TransferSummary> {
    let source = normalize_remote_path(Some(remote_file))?;
    let source_stat = client.stat(&source)?;
    if source_stat.is_dir {
        return Err(CubicError::new(
            format!("Remote source is a directory: {source}"),
            "NOT_A_FILE",
        ));
    }
    if source_stat.size > limits.max_download_bytes {
        return Err(CubicError::new(
            format!(
                "Remote file exceeds download limit {} bytes: {source}",
                limits.max_download_bytes
            ),
            "TREE_LIMIT",
        ));
    }
    let target = absolute_path(local_file)?;
    let current = fs::symlink_metadata(&target).is_ok();
    if current && target.is_dir() {
        return Err(CubicError::new(
            format!("Local target is a directory: {}", target.display()),
            "PATH_CONFLICT",
        ));
    }
    if current && !force {
        return Err(CubicError::new(
            format!(
                "Local target already exists: {}. Use --force to replace it.",
                target.display()
            ),
            "TARGET_EXISTS",
        ));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            CubicError::new(
                format!("Unable to create local directory: {error}"),
                "LOCAL_WRITE_ERROR",
            )
        })?;
    }
    let temporary = target.with_extension(format!("cubic-download-{}", suffix()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| {
                CubicError::new(
                    format!("Unable to create download: {error}"),
                    "LOCAL_WRITE_ERROR",
                )
            })?;
        let info = client.info(false)?;
        let mut offset = 0_u64;
        while offset < source_stat.size {
            let chunk = with_retry(
                || {
                    client.read(
                        &source,
                        offset,
                        info.chunk_size.min(source_stat.size - offset),
                    )
                },
                retries,
            )?;
            if chunk.size != source_stat.size
                || chunk.next_offset != offset + chunk.bytes.len() as u64
                || chunk.bytes.is_empty()
            {
                return Err(CubicError::new(
                    format!("Device returned an invalid read offset for {source}."),
                    "INVALID_RESPONSE",
                ));
            }
            file.write_all(&chunk.bytes).map_err(|error| {
                CubicError::new(
                    format!("Unable to write local download: {error}"),
                    "LOCAL_WRITE_ERROR",
                )
            })?;
            offset = chunk.next_offset;
            if chunk.eof && offset != source_stat.size {
                return Err(CubicError::new(
                    format!("Device ended the download early for {source}."),
                    "INVALID_RESPONSE",
                ));
            }
            if let Some(callback) = progress {
                callback(&TransferProgress {
                    phase: "download",
                    path: source.clone(),
                    transferred_bytes: offset,
                    total_bytes: source_stat.size,
                    completed_entries: usize::from(offset == source_stat.size),
                    total_entries: 1,
                });
            }
        }
        drop(file);
        if fs::metadata(&temporary)
            .map(|value| value.len())
            .unwrap_or_default()
            != source_stat.size
        {
            return Err(CubicError::new(
                format!("Local download verification failed for {source}."),
                "VERIFY_FAILED",
            ));
        }
        if let Some(callback) = progress {
            callback(&TransferProgress {
                phase: "commit",
                path: target.to_string_lossy().into_owned(),
                transferred_bytes: source_stat.size,
                total_bytes: source_stat.size,
                completed_entries: 1,
                total_entries: 1,
            });
        }
        commit_local(&temporary, &target, current, force)?;
        Ok(TransferSummary {
            source,
            destination: target.to_string_lossy().into_owned(),
            files: 1,
            directories: 0,
            bytes: source_stat.size,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

pub fn download_path(
    client: &CubicClient,
    remote_source: &str,
    local_destination: Option<&Path>,
    force: bool,
    retries: usize,
    limits: TransferLimits,
    progress: ProgressCallback<'_>,
) -> Result<TransferSummary> {
    let source = normalize_remote_path(Some(remote_source))?;
    let source_stat = client.stat(&source)?;
    let default_target = PathBuf::from(remote_basename(&source)?);
    let target = absolute_path(local_destination.unwrap_or(&default_target))?;
    if !source_stat.is_dir {
        return download_file(client, &source, &target, force, retries, limits, progress);
    }
    if let Some(callback) = progress {
        callback(&TransferProgress {
            phase: "scan",
            path: source.clone(),
            transferred_bytes: 0,
            total_bytes: 0,
            completed_entries: 0,
            total_entries: 0,
        });
    }
    let (directories, files, total_bytes) = scan_remote_tree(client, &source, limits)?;
    let current = fs::symlink_metadata(&target).is_ok();
    if current && !force {
        return Err(CubicError::new(
            format!(
                "Local target already exists: {}. Use --force to replace it.",
                target.display()
            ),
            "TARGET_EXISTS",
        ));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            CubicError::new(
                format!("Unable to create local directory: {error}"),
                "LOCAL_WRITE_ERROR",
            )
        })?;
    }
    let temporary = target.with_extension(format!("cubic-download-{}", suffix()));
    let result = (|| {
        fs::create_dir(&temporary).map_err(|error| {
            CubicError::new(
                format!("Unable to create download directory: {error}"),
                "LOCAL_WRITE_ERROR",
            )
        })?;
        let mut completed = 0;
        for directory in &directories {
            fs::create_dir_all(safe_local_destination(&temporary, directory)?).map_err(
                |error| {
                    CubicError::new(
                        format!("Unable to create local directory: {error}"),
                        "LOCAL_WRITE_ERROR",
                    )
                },
            )?;
            completed += 1;
        }
        let mut transferred = 0;
        for remote in &files {
            let destination = safe_local_destination(&temporary, &remote.relative)?;
            let before = transferred;
            let child = |event: &TransferProgress| {
                if let Some(callback) = progress {
                    callback(&TransferProgress {
                        phase: event.phase,
                        path: remote.relative.clone(),
                        transferred_bytes: before + event.transferred_bytes,
                        total_bytes,
                        completed_entries: completed,
                        total_entries: directories.len() + files.len(),
                    });
                }
            };
            download_file(
                client,
                &remote.remote,
                &destination,
                false,
                retries,
                TransferLimits {
                    max_download_bytes: remote.size,
                    ..limits
                },
                Some(&child),
            )?;
            transferred += remote.size;
            completed += 1;
        }
        if let Some(callback) = progress {
            callback(&TransferProgress {
                phase: "commit",
                path: target.to_string_lossy().into_owned(),
                transferred_bytes: total_bytes,
                total_bytes,
                completed_entries: completed,
                total_entries: directories.len() + files.len(),
            });
        }
        commit_local(&temporary, &target, current, force)?;
        Ok(TransferSummary {
            source,
            destination: target.to_string_lossy().into_owned(),
            files: files.len(),
            directories: directories.len() + 1,
            bytes: total_bytes,
        })
    })();
    if result.is_err() && temporary.exists() {
        let _ = fs::remove_dir_all(&temporary);
    }
    result
}
