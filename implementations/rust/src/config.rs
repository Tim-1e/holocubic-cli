use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{CubicError, Result};
use crate::url::normalize_device_url;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceProfile {
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CubicConfig {
    pub version: u8,
    pub current: Option<String>,
    pub devices: BTreeMap<String, DeviceProfile>,
}

impl Default for CubicConfig {
    fn default() -> Self {
        Self {
            version: 1,
            current: None,
            devices: BTreeMap::new(),
        }
    }
}

pub fn absolute_path(path: impl AsRef<Path>) -> Result<PathBuf> {
    let path = path.as_ref();
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        env::current_dir()
            .map(|current| current.join(path))
            .map_err(|error| {
                CubicError::new(format!("Unable to resolve path: {error}"), "PATH_ERROR")
            })
    }
}

pub fn default_config_path() -> Result<PathBuf> {
    if let Ok(value) = env::var("CUBIC_CONFIG") {
        if !value.is_empty() {
            return absolute_path(value);
        }
    }
    #[cfg(windows)]
    let base = env::var_os("APPDATA").map(PathBuf::from).or_else(|| {
        env::var_os("USERPROFILE").map(|home| PathBuf::from(home).join("AppData/Roaming"))
    });
    #[cfg(not(windows))]
    let base = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")));
    base.map(|path| path.join("cubic/config.json"))
        .ok_or_else(|| {
            CubicError::new(
                "Unable to determine the configuration directory.",
                "CONFIG_ERROR",
            )
        })
}

pub fn validate_device_name(name: &str) -> Result<String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || matches!(trimmed, "." | "..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.chars().any(|character| character.is_control())
    {
        return Err(CubicError::usage(format!("Invalid device name: {name}")));
    }
    Ok(trimmed.to_owned())
}

pub struct ConfigStore {
    pub file_path: PathBuf,
}

impl ConfigStore {
    pub fn new(file_path: Option<PathBuf>) -> Result<Self> {
        Ok(Self {
            file_path: match file_path {
                Some(path) => absolute_path(path)?,
                None => default_config_path()?,
            },
        })
    }

    pub fn read(&self) -> Result<CubicConfig> {
        let bytes = match fs::read(&self.file_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(CubicConfig::default());
            }
            Err(error) => {
                return Err(CubicError::new(
                    format!(
                        "Unable to read config {}: {error}",
                        self.file_path.display()
                    ),
                    "CONFIG_ERROR",
                ));
            }
        };
        let mut config: CubicConfig = serde_json::from_slice(&bytes).map_err(|error| {
            CubicError::new(
                format!(
                    "Config {} has an unsupported format: {error}",
                    self.file_path.display()
                ),
                "CONFIG_ERROR",
            )
        })?;
        if config.version != 1 {
            return Err(CubicError::new(
                format!(
                    "Config {} has an unsupported format.",
                    self.file_path.display()
                ),
                "CONFIG_ERROR",
            ));
        }
        config.devices.retain(|_, profile| {
            if let Ok(url) = normalize_device_url(&profile.url) {
                profile.url = url;
                true
            } else {
                false
            }
        });
        if config
            .current
            .as_ref()
            .is_some_and(|name| !config.devices.contains_key(name))
        {
            config.current = None;
        }
        Ok(config)
    }

    pub fn write(&self, config: &CubicConfig) -> Result<()> {
        let parent = self.file_path.parent().ok_or_else(|| {
            CubicError::new(
                "Configuration path has no parent directory.",
                "CONFIG_ERROR",
            )
        })?;
        fs::create_dir_all(parent).map_err(|error| {
            CubicError::new(
                format!(
                    "Unable to create config directory {}: {error}",
                    parent.display()
                ),
                "CONFIG_ERROR",
            )
        })?;
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let temporary =
            self.file_path
                .with_extension(format!("{}.{}.tmp", std::process::id(), suffix));
        let data = serde_json::to_vec_pretty(config).map_err(|error| {
            CubicError::new(
                format!("Unable to serialize config: {error}"),
                "CONFIG_ERROR",
            )
        })?;
        fs::write(&temporary, [data.as_slice(), b"\n"].concat()).map_err(|error| {
            CubicError::new(format!("Unable to write config: {error}"), "CONFIG_ERROR")
        })?;
        let backup = self.file_path.with_extension(format!("backup-{suffix}"));
        let had_current = self.file_path.exists();
        if had_current {
            fs::rename(&self.file_path, &backup).map_err(|error| {
                CubicError::new(format!("Unable to replace config: {error}"), "CONFIG_ERROR")
            })?;
        }
        if let Err(error) = fs::rename(&temporary, &self.file_path) {
            if had_current {
                let _ = fs::rename(&backup, &self.file_path);
            }
            let _ = fs::remove_file(&temporary);
            return Err(CubicError::new(
                format!("Unable to replace config: {error}"),
                "CONFIG_ERROR",
            ));
        }
        if had_current {
            let _ = fs::remove_file(backup);
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedDevice {
    pub url: String,
    pub name: Option<String>,
}

pub fn resolve_device(store: &ConfigStore, option_host: Option<&str>) -> Result<ResolvedDevice> {
    if let Some(host) = option_host {
        return Ok(ResolvedDevice {
            url: normalize_device_url(host)?,
            name: None,
        });
    }
    if let Ok(host) = env::var("CUBIC_HOST") {
        if !host.is_empty() {
            return Ok(ResolvedDevice {
                url: normalize_device_url(&host)?,
                name: None,
            });
        }
    }
    let config = store.read()?;
    let current = config.current.ok_or_else(|| {
        CubicError::new(
            "No device selected. Run `cubic-rs device add <name> <host>` or pass --host.",
            "NO_DEVICE",
        )
    })?;
    let profile = config.devices.get(&current).ok_or_else(|| {
        CubicError::new(
            "No device selected. Run `cubic-rs device add <name> <host>` or pass --host.",
            "NO_DEVICE",
        )
    })?;
    Ok(ResolvedDevice {
        url: profile.url.clone(),
        name: Some(current),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_names_and_roundtrips_unicode_config() {
        assert_eq!(validate_device_name(" 桌面 ").unwrap(), "桌面");
        assert!(validate_device_name("a/b").is_err());
        let root = env::temp_dir().join(format!("cubic-rs-config-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let store = ConfigStore::new(Some(root.join("nested/config.json"))).unwrap();
        let mut config = CubicConfig {
            current: Some("桌面".into()),
            ..CubicConfig::default()
        };
        config.devices.insert(
            "桌面".into(),
            DeviceProfile {
                url: "192.0.2.42".into(),
                version: None,
            },
        );
        store.write(&config).unwrap();
        assert_eq!(
            store.read().unwrap().devices["桌面"].url,
            "http://192.0.2.42/devtools"
        );
        let _ = fs::remove_dir_all(root);
    }
}
