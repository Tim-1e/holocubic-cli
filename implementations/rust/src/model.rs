use serde::Serialize;
use serde_json::{Map, Value};

pub const LEGACY_V1_CAPABILITIES: [&str; 12] = [
    "fs.list",
    "fs.stat",
    "fs.read",
    "fs.write",
    "fs.mkdir",
    "fs.rename",
    "fs.remove",
    "fs.rmdir",
    "apps.list",
    "devrun.read",
    "devrun.save",
    "devrun.run",
];

#[derive(Debug, Clone)]
pub struct DeviceInfo {
    pub api_version: u64,
    pub version: Option<String>,
    pub route_base: String,
    pub root_path: String,
    pub chunk_size: u64,
    pub max_file_size: u64,
    pub max_code_bytes: u64,
    pub run_app_id: String,
    pub run_app_main: String,
    pub capabilities: Vec<String>,
    pub raw: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub is_dir: bool,
    pub ext: String,
    pub mime: String,
    pub category: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListResult {
    pub path: String,
    pub parent: String,
    pub dir_count: u64,
    pub file_count: u64,
    pub total_bytes: u64,
    pub items: Vec<RemoteEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteStat {
    pub path: String,
    pub name: String,
    pub parent: String,
    pub size: u64,
    pub is_dir: bool,
    pub ext: String,
    pub mime: String,
    pub category: String,
}

#[derive(Debug, Clone)]
pub struct ReadChunk {
    pub bytes: Vec<u8>,
    pub size: u64,
    pub next_offset: u64,
    pub eof: bool,
    pub name: String,
    pub mime: String,
}

#[derive(Debug, Clone)]
pub struct UploadResult {
    pub path: String,
    pub next_offset: u64,
    pub total: u64,
    pub done: bool,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppsResult {
    pub apps: Vec<Map<String, Value>>,
    pub current_app_id: Option<String>,
    pub run_app_id: String,
    pub run_app_main: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevRunResult {
    pub id: String,
    pub entry: String,
    pub bytes: u64,
    pub launched: bool,
    pub rescan_requested: bool,
}

#[derive(Debug, Clone, Copy)]
pub struct TransferLimits {
    pub max_depth: usize,
    pub max_entries: usize,
    pub max_download_bytes: u64,
}

impl Default for TransferLimits {
    fn default() -> Self {
        Self {
            max_depth: 32,
            max_entries: 4096,
            max_download_bytes: 128 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TransferSummary {
    pub source: String,
    pub destination: String,
    pub files: usize,
    pub directories: usize,
    pub bytes: u64,
}
