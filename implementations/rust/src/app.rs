use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::config::absolute_path;
use crate::error::{CubicError, Result};
use crate::remote_path::remote_join;

#[derive(Debug, Clone, Serialize)]
pub struct ValidatedApp {
    pub source: String,
    pub id: String,
    pub destination: String,
    pub entry: String,
}

pub fn validate_app_id(value: &str) -> Result<String> {
    let id = value.trim();
    if id.is_empty()
        || matches!(id, "." | "..")
        || id.starts_with(".cubic-")
        || id.contains('/')
        || id.contains('\\')
        || id.chars().any(|character| character.is_control())
    {
        return Err(CubicError::usage(format!("Invalid app id: {value}")));
    }
    remote_join("/sd/apps", id)?;
    Ok(id.to_owned())
}

fn require_file(path: &Path, label: &str) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        CubicError::new(
            format!(
                "App {label} is missing or is not a regular file: {} ({error})",
                path.display()
            ),
            "INVALID_APP",
        )
    })?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(CubicError::new(
            format!(
                "App {label} is missing or is not a regular file: {}",
                path.display()
            ),
            "INVALID_APP",
        ));
    }
    Ok(())
}

pub fn validate_app_directory(
    directory: &Path,
    requested_id: Option<&str>,
) -> Result<ValidatedApp> {
    let source = absolute_path(directory)?;
    let metadata = fs::symlink_metadata(&source).map_err(|error| {
        CubicError::new(
            format!(
                "App directory does not exist: {} ({error})",
                source.display()
            ),
            "INVALID_APP",
        )
    })?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(CubicError::new(
            format!(
                "App source is not a regular directory: {}",
                source.display()
            ),
            "INVALID_APP",
        ));
    }
    let info_path = source.join("app.info");
    require_file(&info_path, "metadata")?;
    let info = fs::read_to_string(&info_path).map_err(|error| {
        CubicError::new(
            format!(
                "Unable to read app metadata {}: {error}",
                info_path.display()
            ),
            "INVALID_APP",
        )
    })?;
    let entry = info
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once('=')?;
            (key.trim() == "entry").then(|| value.trim().to_owned())
        })
        .unwrap_or_else(|| "main.lua".into());
    let entry_path = PathBuf::from(&entry);
    if entry.is_empty()
        || entry_path.is_absolute()
        || entry.contains('\\')
        || entry_path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(CubicError::new(
            format!("app.info declares an unsafe entry: {entry}"),
            "INVALID_APP",
        ));
    }
    require_file(&source.join(&entry_path), "entry")?;
    require_file(&source.join("main.lua"), "main.lua")?;
    let fallback = source
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| CubicError::new("App directory has no valid name.", "INVALID_APP"))?;
    let id = validate_app_id(requested_id.unwrap_or(fallback))?;
    Ok(ValidatedApp {
        source: source.to_string_lossy().into_owned(),
        destination: remote_join("/sd/apps", &id)?,
        id,
        entry,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_apps_and_ids() {
        assert!(validate_app_id("../bad").is_err());
        let root = std::env::temp_dir().join(format!("cubic-rs-app-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("app.info"), "entry = main.lua\n").unwrap();
        fs::write(root.join("main.lua"), "print('ok')\n").unwrap();
        let app = validate_app_directory(&root, Some("sample")).unwrap();
        assert_eq!(app.destination, "/sd/apps/sample");
        let _ = fs::remove_dir_all(root);
    }
}
