use std::fmt::{Display, Formatter};

#[derive(Debug)]
pub struct CubicError {
    pub message: String,
    pub code: &'static str,
    pub exit_code: u8,
    pub status: Option<u16>,
}

impl CubicError {
    pub fn new(message: impl Into<String>, code: &'static str) -> Self {
        Self {
            message: message.into(),
            code,
            exit_code: 1,
            status: None,
        }
    }

    pub fn usage(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            code: "USAGE_ERROR",
            exit_code: 2,
            status: None,
        }
    }

    pub fn http(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            code: if status == 404 {
                "NOT_FOUND"
            } else {
                "HTTP_ERROR"
            },
            exit_code: 1,
            status: Some(status),
        }
    }

    pub fn is_not_found(&self) -> bool {
        self.status == Some(404)
    }
}

impl Display for CubicError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CubicError {}

pub type Result<T> = std::result::Result<T, CubicError>;
