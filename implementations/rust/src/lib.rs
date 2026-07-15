//! Rust reference-compatible implementation of the HoloCubic CLI core.

pub mod app;
pub mod client;
pub mod config;
pub mod error;
pub mod model;
pub mod remote_path;
pub mod transfer;
pub mod transport;
pub mod url;

pub use client::{CubicClient, public_info};
pub use error::{CubicError, Result};
pub use url::normalize_device_url;
