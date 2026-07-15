use std::cell::RefCell;

use serde_json::{Map, Value, json};

use crate::error::{CubicError, Result};
use crate::model::{
    AppsResult, DevRunResult, DeviceInfo, LEGACY_V1_CAPABILITIES, ListResult, ReadChunk,
    RemoteEntry, RemoteStat, UploadResult,
};
use crate::remote_path::normalize_remote_path;
use crate::transport::{HttpTransport, Method};

const DEFAULT_MAX_CODE_BYTES: u64 = 192 * 1024;

fn object(value: Value, label: &str) -> Result<Map<String, Value>> {
    value.as_object().cloned().ok_or_else(|| {
        CubicError::new(
            format!("Device returned an invalid {label} response."),
            "INVALID_RESPONSE",
        )
    })
}

fn string(value: Option<&Value>, label: &str) -> Result<String> {
    value
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| {
            CubicError::new(
                format!("Device response is missing {label}."),
                "INVALID_RESPONSE",
            )
        })
}

fn integer(value: Option<&Value>, label: &str, minimum: u64) -> Result<u64> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value >= minimum)
        .ok_or_else(|| {
            CubicError::new(
                format!("Device response has an invalid {label}."),
                "INVALID_RESPONSE",
            )
        })
}

fn boolean(value: Option<&Value>, label: &str) -> Result<bool> {
    value.and_then(Value::as_bool).ok_or_else(|| {
        CubicError::new(
            format!("Device response has an invalid {label}."),
            "INVALID_RESPONSE",
        )
    })
}

fn lua_array(value: Option<&Value>, label: &str) -> Result<Vec<Value>> {
    match value {
        Some(Value::Array(values)) => Ok(values.clone()),
        Some(Value::Object(object)) if object.is_empty() => Ok(Vec::new()),
        _ => Err(CubicError::new(
            format!("Device {label} response is missing a valid array."),
            "INVALID_RESPONSE",
        )),
    }
}

fn parse_entry(value: Value) -> Result<RemoteEntry> {
    let item = object(value, "directory entry")?;
    Ok(RemoteEntry {
        name: string(item.get("name"), "entry.name")?,
        path: normalize_remote_path(Some(&string(item.get("path"), "entry.path")?))?,
        size: integer(item.get("size"), "entry.size", 0)?,
        is_dir: boolean(item.get("is_dir"), "entry.is_dir")?,
        ext: item.get("ext").and_then(Value::as_str).unwrap_or("").into(),
        mime: item
            .get("mime")
            .and_then(Value::as_str)
            .unwrap_or("application/octet-stream")
            .into(),
        category: item
            .get("category")
            .and_then(Value::as_str)
            .unwrap_or("other")
            .into(),
    })
}

pub struct CubicClient {
    pub transport: HttpTransport,
    cached_info: RefCell<Option<DeviceInfo>>,
}

impl CubicClient {
    pub fn new(base_url: &str, timeout_ms: u64) -> Result<Self> {
        Ok(Self {
            transport: HttpTransport::new(base_url, timeout_ms)?,
            cached_info: RefCell::new(None),
        })
    }

    pub fn info(&self, force: bool) -> Result<DeviceInfo> {
        if !force {
            if let Some(info) = self.cached_info.borrow().clone() {
                return Ok(info);
            }
        }
        let raw = object(
            self.transport.json("info", Method::Get, &[], None, None)?,
            "info",
        )?;
        if raw.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(CubicError::new(
                "Device handshake did not return ok=true.",
                "INVALID_RESPONSE",
            ));
        }
        let api_version = match raw.get("api_version") {
            Some(value) => integer(Some(value), "api_version", 1)?,
            None => 1,
        };
        if api_version > 1 {
            return Err(CubicError::new(
                format!("Unsupported DevTools API version: {api_version}."),
                "UNSUPPORTED_API",
            ));
        }
        let root_path = string(raw.get("root_path"), "root_path")?;
        if normalize_remote_path(Some(&root_path))? != "/sd" {
            return Err(CubicError::new(
                format!("Unsupported device root path: {root_path}."),
                "INVALID_RESPONSE",
            ));
        }
        let capabilities = match raw.get("capabilities") {
            Some(Value::Array(values)) => values
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
            _ => LEGACY_V1_CAPABILITIES
                .iter()
                .map(|value| (*value).into())
                .collect(),
        };
        let info = DeviceInfo {
            api_version,
            version: raw
                .get("version")
                .and_then(Value::as_str)
                .map(str::to_owned),
            route_base: raw
                .get("route_base")
                .and_then(Value::as_str)
                .unwrap_or("/devtools")
                .into(),
            root_path,
            chunk_size: integer(raw.get("chunk_size"), "chunk_size", 1)?,
            max_file_size: integer(raw.get("max_file_size"), "max_file_size", 1)?,
            max_code_bytes: match raw.get("max_code_bytes") {
                Some(value) => integer(Some(value), "max_code_bytes", 1)?,
                None => DEFAULT_MAX_CODE_BYTES,
            },
            run_app_id: string(raw.get("run_app_id"), "run_app_id")?,
            run_app_main: normalize_remote_path(Some(&string(
                raw.get("run_app_main"),
                "run_app_main",
            )?))?,
            capabilities,
            raw,
        };
        self.cached_info.replace(Some(info.clone()));
        Ok(info)
    }

    pub fn require_capability(&self, capability: &str) -> Result<()> {
        if !self
            .info(false)?
            .capabilities
            .iter()
            .any(|value| value == capability)
        {
            return Err(CubicError::new(
                format!("Device does not support capability {capability}."),
                "UNSUPPORTED_CAPABILITY",
            ));
        }
        Ok(())
    }

    pub fn list(&self, remote_path: &str) -> Result<ListResult> {
        self.require_capability("fs.list")?;
        let path = normalize_remote_path(Some(remote_path))?;
        let raw = object(
            self.transport
                .json("list", Method::Get, &[("path", path)], None, None)?,
            "list",
        )?;
        Ok(ListResult {
            path: normalize_remote_path(Some(&string(raw.get("path"), "list.path")?))?,
            parent: normalize_remote_path(Some(&string(raw.get("parent"), "list.parent")?))?,
            dir_count: integer(raw.get("dir_count"), "list.dir_count", 0)?,
            file_count: integer(raw.get("file_count"), "list.file_count", 0)?,
            total_bytes: integer(raw.get("total_bytes"), "list.total_bytes", 0)?,
            items: lua_array(raw.get("items"), "list.items")?
                .into_iter()
                .map(parse_entry)
                .collect::<Result<Vec<_>>>()?,
        })
    }

    pub fn stat(&self, remote_path: &str) -> Result<RemoteStat> {
        self.require_capability("fs.stat")?;
        let path = normalize_remote_path(Some(remote_path))?;
        let raw = object(
            self.transport
                .json("stat", Method::Get, &[("path", path)], None, None)?,
            "stat",
        )?;
        Ok(RemoteStat {
            path: normalize_remote_path(Some(&string(raw.get("path"), "stat.path")?))?,
            name: string(raw.get("name"), "stat.name")?,
            parent: normalize_remote_path(Some(&string(raw.get("parent"), "stat.parent")?))?,
            size: integer(raw.get("size"), "stat.size", 0)?,
            is_dir: boolean(raw.get("is_dir"), "stat.is_dir")?,
            ext: raw.get("ext").and_then(Value::as_str).unwrap_or("").into(),
            mime: raw
                .get("mime")
                .and_then(Value::as_str)
                .unwrap_or("application/octet-stream")
                .into(),
            category: raw
                .get("category")
                .and_then(Value::as_str)
                .unwrap_or("other")
                .into(),
        })
    }

    pub fn stat_or_none(&self, remote_path: &str) -> Result<Option<RemoteStat>> {
        match self.stat(remote_path) {
            Ok(value) => Ok(Some(value)),
            Err(error) if error.is_not_found() => Ok(None),
            Err(error) => Err(error),
        }
    }

    pub fn read(&self, remote_path: &str, offset: u64, size: u64) -> Result<ReadChunk> {
        self.require_capability("fs.read")?;
        let response = self.transport.request(
            "read",
            Method::Get,
            &[
                ("path", normalize_remote_path(Some(remote_path))?),
                ("offset", offset.to_string()),
                ("size", size.to_string()),
            ],
            None,
            None,
            "application/octet-stream",
        )?;
        let parse_header = |name: &str| -> Result<u64> {
            response
                .headers
                .get(name)
                .and_then(|value| value.parse().ok())
                .ok_or_else(|| {
                    CubicError::new(
                        format!("Device response has an invalid {name}."),
                        "INVALID_RESPONSE",
                    )
                })
        };
        Ok(ReadChunk {
            size: parse_header("x-file-size")?,
            next_offset: parse_header("x-next-offset")?,
            eof: response
                .headers
                .get("x-eof")
                .is_some_and(|value| value == "1"),
            name: response
                .headers
                .get("x-file-name")
                .cloned()
                .unwrap_or_default(),
            mime: response
                .headers
                .get("content-type")
                .cloned()
                .unwrap_or_else(|| "application/octet-stream".into()),
            bytes: response.body,
        })
    }

    pub fn mkdir(&self, remote_path: &str) -> Result<()> {
        self.require_capability("fs.mkdir")?;
        self.transport.json(
            "mkdir",
            Method::Post,
            &[("path", normalize_remote_path(Some(remote_path))?)],
            Some(&[]),
            None,
        )?;
        Ok(())
    }

    pub fn rename(&self, source: &str, target: &str) -> Result<()> {
        self.require_capability("fs.rename")?;
        self.transport.json(
            "rename",
            Method::Post,
            &[
                ("path", normalize_remote_path(Some(source))?),
                ("new_path", normalize_remote_path(Some(target))?),
            ],
            Some(&[]),
            None,
        )?;
        Ok(())
    }

    pub fn upload(
        &self,
        remote_path: &str,
        bytes: &[u8],
        offset: u64,
        total: u64,
    ) -> Result<UploadResult> {
        self.require_capability("fs.write")?;
        let raw = object(
            self.transport.json(
                "upload",
                Method::Put,
                &[
                    ("path", normalize_remote_path(Some(remote_path))?),
                    ("offset", offset.to_string()),
                    ("total", total.to_string()),
                ],
                Some(bytes),
                Some("application/octet-stream"),
            )?,
            "upload",
        )?;
        let next_offset = integer(raw.get("next_offset"), "upload.next_offset", 0)?;
        Ok(UploadResult {
            path: normalize_remote_path(Some(&string(raw.get("path"), "upload.path")?))?,
            next_offset,
            total: integer(raw.get("total"), "upload.total", 0)?,
            done: boolean(raw.get("done"), "upload.done")?,
            size: match raw.get("size") {
                Some(value) => integer(Some(value), "upload.size", 0)?,
                None => next_offset,
            },
        })
    }

    pub fn remove(&self, remote_path: &str) -> Result<()> {
        self.require_capability("fs.remove")?;
        self.transport.json(
            "remove",
            Method::Delete,
            &[("path", normalize_remote_path(Some(remote_path))?)],
            None,
            None,
        )?;
        Ok(())
    }

    pub fn rmdir(&self, remote_path: &str, recursive: bool) -> Result<()> {
        self.require_capability("fs.rmdir")?;
        self.transport.json(
            "rmdir",
            Method::Delete,
            &[
                ("path", normalize_remote_path(Some(remote_path))?),
                ("recursive", if recursive { "1" } else { "0" }.into()),
            ],
            None,
            None,
        )?;
        Ok(())
    }

    pub fn apps(&self) -> Result<AppsResult> {
        self.require_capability("apps.list")?;
        let raw = object(
            self.transport.json("apps", Method::Get, &[], None, None)?,
            "apps",
        )?;
        Ok(AppsResult {
            apps: lua_array(raw.get("apps"), "apps.apps")?
                .into_iter()
                .filter_map(|value| value.as_object().cloned())
                .collect(),
            current_app_id: raw
                .get("current_app_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            run_app_id: string(raw.get("run_app_id"), "apps.run_app_id")?,
            run_app_main: normalize_remote_path(Some(&string(
                raw.get("run_app_main"),
                "apps.run_app_main",
            )?))?,
        })
    }

    pub fn read_devrun(&self) -> Result<String> {
        self.require_capability("devrun.read")?;
        let response =
            self.transport
                .request("code/read", Method::Get, &[], None, None, "text/plain")?;
        String::from_utf8(response.body).map_err(|error| {
            CubicError::new(
                format!("Device returned invalid UTF-8 DevRun source: {error}"),
                "INVALID_RESPONSE",
            )
        })
    }

    pub fn save_devrun(&self, source: &str, run: bool) -> Result<DevRunResult> {
        self.require_capability(if run { "devrun.run" } else { "devrun.save" })?;
        let bytes = source.as_bytes();
        let info = self.info(false)?;
        if bytes.len() as u64 > info.max_code_bytes {
            return Err(CubicError::new(
                format!(
                    "DevRun source is {} bytes; device limit is {} bytes.",
                    bytes.len(),
                    info.max_code_bytes
                ),
                "FILE_TOO_LARGE",
            ));
        }
        let raw = object(
            self.transport.json(
                if run { "code/run" } else { "code/save" },
                Method::Post,
                &[],
                Some(bytes),
                Some("text/plain; charset=utf-8"),
            )?,
            "DevRun",
        )?;
        Ok(DevRunResult {
            id: string(raw.get("id"), "DevRun.id")?,
            entry: normalize_remote_path(Some(&string(raw.get("entry"), "DevRun.entry")?))?,
            bytes: integer(raw.get("bytes"), "DevRun.bytes", 0)?,
            launched: boolean(raw.get("launched"), "DevRun.launched")?,
            rescan_requested: boolean(raw.get("rescan_requested"), "DevRun.rescan_requested")?,
        })
    }
}

pub fn public_info(info: &DeviceInfo, url: &str, name: Option<&str>) -> Value {
    json!({
        "name": name,
        "url": url,
        "version": info.version,
        "api_version": info.api_version,
        "route_base": info.route_base,
        "root_path": info.root_path,
        "chunk_size": info.chunk_size,
        "max_file_size": info.max_file_size,
        "max_code_bytes": info.max_code_bytes,
        "run_app_id": info.run_app_id,
        "run_app_main": info.run_app_main,
        "capabilities": info.capabilities,
    })
}
