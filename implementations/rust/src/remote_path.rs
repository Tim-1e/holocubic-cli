use std::path::{Path, PathBuf};

use crate::error::{CubicError, Result};

pub const REMOTE_ROOT: &str = "/sd";

pub fn normalize_remote_path(value: Option<&str>) -> Result<String> {
    let value = value.unwrap_or_default().trim();
    if value.contains('\0') {
        return Err(CubicError::usage(
            "Remote path contains an invalid NUL character.",
        ));
    }
    let unix = value.replace('\\', "/");
    let absolute = unix.starts_with('/');
    let mut parts: Vec<&str> = if absolute { Vec::new() } else { vec!["sd"] };
    for part in unix.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    let normalized = format!("/{}", parts.join("/"));
    if normalized != REMOTE_ROOT && !normalized.starts_with("/sd/") {
        return Err(CubicError::usage(format!(
            "Remote path must stay below {REMOTE_ROOT}: {value}"
        )));
    }
    Ok(normalized)
}

pub fn remote_join(parent: &str, name: &str) -> Result<String> {
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(CubicError::usage(format!(
            "Invalid remote entry name: {name}"
        )));
    }
    normalize_remote_path(Some(&format!(
        "{}/{}",
        normalize_remote_path(Some(parent))?,
        name
    )))
}

pub fn remote_basename(remote_path: &str) -> Result<String> {
    let normalized = normalize_remote_path(Some(remote_path))?;
    Ok(if normalized == REMOTE_ROOT {
        "sd".into()
    } else {
        normalized.rsplit('/').next().unwrap_or("sd").to_owned()
    })
}

pub fn assert_can_delete_remote(remote_path: &str) -> Result<()> {
    if normalize_remote_path(Some(remote_path))? == REMOTE_ROOT {
        return Err(CubicError::usage(format!(
            "Refusing to delete {REMOTE_ROOT}."
        )));
    }
    Ok(())
}

pub fn safe_local_destination(root: &Path, relative: &str) -> Result<PathBuf> {
    if relative.contains('\0') || relative.starts_with('/') || relative.starts_with('\\') {
        return Err(CubicError::usage(format!(
            "Download entry escapes destination: {relative}"
        )));
    }
    let mut output = root.to_path_buf();
    for part in relative.replace('\\', "/").split('/') {
        match part {
            "" | "." => {}
            ".." => {
                return Err(CubicError::usage(format!(
                    "Download entry escapes destination: {relative}"
                )));
            }
            _ => output.push(part),
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn confines_remote_and_local_paths() {
        assert_eq!(normalize_remote_path(None).unwrap(), "/sd");
        assert_eq!(
            normalize_remote_path(Some("apps\\demo")).unwrap(),
            "/sd/apps/demo"
        );
        assert!(normalize_remote_path(Some("../etc")).is_err());
        assert_eq!(
            remote_join("/sd/apps", "天气 app").unwrap(),
            "/sd/apps/天气 app"
        );
        assert!(remote_join("/sd", "../x").is_err());
        assert!(assert_can_delete_remote("/sd/./").is_err());
        assert!(safe_local_destination(Path::new("/tmp/root"), "../escape").is_err());
    }
}
