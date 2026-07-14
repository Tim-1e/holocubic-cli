use serde_json::{Value, json};
use url::Url;

pub const LEGACY_CAPABILITIES: [&str; 12] = [
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

pub fn normalize_device_url(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Device host cannot be empty.".into());
    }
    if trimmed.contains('\0') {
        return Err("Device host contains an invalid NUL character.".into());
    }

    let candidate = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("http://{trimmed}")
    };
    let mut url = Url::parse(&candidate).map_err(|_| format!("Invalid device host: {value}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!("Unsupported device URL scheme: {}", url.scheme()));
    }
    if url.host_str().is_none() {
        return Err(format!("Invalid device host: {value}"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Credentials are not allowed in the device URL.".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Device URL must not contain a query string or fragment.".into());
    }

    match url.path().trim_end_matches('/') {
        "" | "/devtools" | "/devtools/api" => url.set_path("/devtools"),
        _ => return Err("Device URL path must be /devtools or /devtools/api.".into()),
    }
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

fn positive_integer(object: &serde_json::Map<String, Value>, field: &str) -> Result<u64, String> {
    object
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value > 0)
        .ok_or_else(|| format!("Device response has an invalid {field}."))
}

pub fn public_info(raw: &Value, url: &str) -> Result<Value, String> {
    let object = raw
        .as_object()
        .ok_or_else(|| "Device returned an invalid info response.".to_owned())?;
    if object.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err("Device handshake did not return ok=true.".into());
    }

    let api_version = object
        .get("api_version")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    if api_version != 1 {
        return Err(format!("Unsupported DevTools API version: {api_version}."));
    }
    if object.get("root_path").and_then(Value::as_str) != Some("/sd") {
        return Err("Device response has an invalid root_path.".into());
    }

    let chunk_size = positive_integer(object, "chunk_size")?;
    let max_file_size = positive_integer(object, "max_file_size")?;
    let max_code_bytes = match object.get("max_code_bytes") {
        Some(_) => positive_integer(object, "max_code_bytes")?,
        None => 192 * 1024,
    };
    let run_app_id = object
        .get("run_app_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "Device response is missing run_app_id.".to_owned())?;
    let run_app_main = object
        .get("run_app_main")
        .and_then(Value::as_str)
        .ok_or_else(|| "Device response is missing run_app_main.".to_owned())?;
    if !run_app_main.starts_with("/sd/") {
        return Err("Device response has an invalid run_app_main.".into());
    }

    let capabilities = object
        .get("capabilities")
        .and_then(Value::as_array)
        .filter(|items| items.iter().all(Value::is_string))
        .cloned()
        .unwrap_or_else(|| LEGACY_CAPABILITIES.iter().map(|item| json!(item)).collect());

    Ok(json!({
        "name": Value::Null,
        "url": url,
        "version": object.get("version").and_then(Value::as_str),
        "api_version": api_version,
        "route_base": "/devtools",
        "root_path": "/sd",
        "chunk_size": chunk_size,
        "max_file_size": max_file_size,
        "max_code_bytes": max_code_bytes,
        "run_app_id": run_app_id,
        "run_app_main": run_app_main,
        "capabilities": capabilities,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_urls() {
        assert_eq!(
            normalize_device_url("192.0.2.42").unwrap(),
            "http://192.0.2.42/devtools"
        );
        assert_eq!(
            normalize_device_url("http://host/devtools/api/").unwrap(),
            "http://host/devtools"
        );
    }

    #[test]
    fn rejects_unsafe_urls() {
        for input in [
            "",
            "ftp://host",
            "http://user:pass@host",
            "http://host/other",
            "http://host?x=1",
        ] {
            assert!(normalize_device_url(input).is_err(), "{input}");
        }
    }

    #[test]
    fn validates_legacy_info() {
        let raw = json!({
            "ok": true,
            "root_path": "/sd",
            "chunk_size": 262144,
            "max_file_size": 67108864,
            "run_app_id": "devrun",
            "run_app_main": "/sd/apps/devrun/main.lua"
        });
        let info = public_info(&raw, "http://host/devtools").unwrap();
        assert_eq!(info["api_version"], 1);
        assert_eq!(info["capabilities"].as_array().unwrap().len(), 12);
    }
}
