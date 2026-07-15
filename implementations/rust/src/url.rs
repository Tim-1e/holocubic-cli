use url::Url;

use crate::error::{CubicError, Result};

pub fn normalize_device_url(value: &str) -> Result<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(CubicError::usage("Device host cannot be empty."));
    }
    if trimmed.contains('\0') {
        return Err(CubicError::usage(
            "Device host contains an invalid NUL character.",
        ));
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_owned()
    } else {
        format!("http://{trimmed}")
    };
    let mut url = Url::parse(&candidate)
        .map_err(|_| CubicError::usage(format!("Invalid device host: {value}")))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(CubicError::usage(format!(
            "Unsupported device URL scheme: {}",
            url.scheme()
        )));
    }
    if url.host_str().is_none() {
        return Err(CubicError::usage(format!("Invalid device host: {value}")));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(CubicError::usage(
            "Credentials are not allowed in the device URL.",
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(CubicError::usage(
            "Device URL must not contain a query string or fragment.",
        ));
    }
    match url.path().trim_end_matches('/') {
        "" | "/devtools" | "/devtools/api" => url.set_path("/devtools"),
        _ => {
            return Err(CubicError::usage(
                "Device URL path must be /devtools or /devtools/api.",
            ));
        }
    }
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

pub fn api_url(base_url: &str, route: &str, query: &[(&str, String)]) -> Result<String> {
    let clean_route = route.trim_start_matches('/');
    let mut url = Url::parse(&format!("{base_url}/api/{clean_route}"))
        .map_err(|error| CubicError::new(format!("Invalid API URL: {error}"), "INVALID_URL"))?;
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
    }
    Ok(url.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_and_rejects_urls() {
        assert_eq!(
            normalize_device_url("192.0.2.42").unwrap(),
            "http://192.0.2.42/devtools"
        );
        assert_eq!(
            normalize_device_url("http://host/devtools/api/").unwrap(),
            "http://host/devtools"
        );
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
}
