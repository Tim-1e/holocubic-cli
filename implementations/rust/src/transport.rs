use std::collections::BTreeMap;
use std::time::Duration;

use serde_json::Value;
use ureq::Agent;

use crate::error::{CubicError, Result};
use crate::url::{api_url, normalize_device_url};

#[derive(Debug, Clone, Copy)]
pub enum Method {
    Get,
    Post,
    Put,
    Delete,
}

impl Method {
    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Delete => "DELETE",
        }
    }
}

pub struct HttpResponse {
    pub body: Vec<u8>,
    pub headers: BTreeMap<String, String>,
}

pub struct HttpTransport {
    pub base_url: String,
    pub timeout_ms: u64,
    agent: Agent,
}

impl HttpTransport {
    pub fn new(base_url: &str, timeout_ms: u64) -> Result<Self> {
        if timeout_ms == 0 {
            return Err(CubicError::new(
                "Timeout must be greater than zero.",
                "INVALID_TIMEOUT",
            ));
        }
        let config = Agent::config_builder()
            .timeout_global(Some(Duration::from_millis(timeout_ms)))
            .http_status_as_error(false)
            .build();
        Ok(Self {
            base_url: normalize_device_url(base_url)?,
            timeout_ms,
            agent: Agent::new_with_config(config),
        })
    }

    pub fn request(
        &self,
        route: &str,
        method: Method,
        query: &[(&str, String)],
        body: Option<&[u8]>,
        content_type: Option<&str>,
        accept: &str,
    ) -> Result<HttpResponse> {
        let url = api_url(&self.base_url, route, query)?;
        let response = match method {
            Method::Get => self.agent.get(&url).header("Accept", accept).call(),
            Method::Delete => self.agent.delete(&url).header("Accept", accept).call(),
            Method::Post => {
                let request = self.agent.post(&url).header("Accept", accept);
                let request = if let Some(value) = content_type {
                    request.header("Content-Type", value)
                } else {
                    request
                };
                request.send(body.unwrap_or_default())
            }
            Method::Put => {
                let request = self.agent.put(&url).header("Accept", accept);
                let request = if let Some(value) = content_type {
                    request.header("Content-Type", value)
                } else {
                    request
                };
                request.send(body.unwrap_or_default())
            }
        };
        let mut response = response.map_err(|error| match error {
            ureq::Error::Timeout(_) => CubicError::new(
                format!("Request timed out after {} ms.", self.timeout_ms),
                "TIMEOUT",
            ),
            other => CubicError::new(
                format!("Unable to connect to {}: {other}", self.base_url),
                "CONNECTION_ERROR",
            ),
        })?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|value| (name.as_str().to_ascii_lowercase(), value.to_owned()))
            })
            .collect();
        let bytes = response.body_mut().read_to_vec().map_err(|error| {
            CubicError::new(
                format!("Unable to read device response: {error}"),
                "INVALID_RESPONSE",
            )
        })?;
        if status >= 400 {
            let request_path = url.strip_prefix(&self.base_url).unwrap_or(&url);
            let mut message = format!(
                "{} {request_path} failed with HTTP {status}.",
                method.as_str()
            );
            if let Ok(Value::Object(object)) = serde_json::from_slice::<Value>(&bytes) {
                if let Some(detail) = object
                    .get("error")
                    .and_then(Value::as_str)
                    .or_else(|| object.get("message").and_then(Value::as_str))
                {
                    message.push(' ');
                    message.push_str(detail);
                }
            }
            return Err(CubicError::http(message, status));
        }
        Ok(HttpResponse {
            body: bytes,
            headers,
        })
    }

    pub fn json(
        &self,
        route: &str,
        method: Method,
        query: &[(&str, String)],
        body: Option<&[u8]>,
        content_type: Option<&str>,
    ) -> Result<Value> {
        let response =
            self.request(route, method, query, body, content_type, "application/json")?;
        serde_json::from_slice(&response.body).map_err(|error| {
            CubicError::new(
                format!("Device returned malformed JSON for /api/{route}: {error}"),
                "INVALID_RESPONSE",
            )
        })
    }
}
