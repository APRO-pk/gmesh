use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

/// Application-level errors mapped to HTTP responses.
pub enum AppError {
    /// The Python/Gmsh backend failed or returned an error.
    Backend(String),
    /// A requested resource does not exist.
    NotFound(String),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match self {
            AppError::Backend(m) => (StatusCode::BAD_GATEWAY, m),
            AppError::NotFound(m) => (StatusCode::NOT_FOUND, m),
        };
        (status, Json(json!({ "status": "error", "message": message }))).into_response()
    }
}
