//! Wire protocol shared between the Rust application layer and the
//! Python/Gmsh worker subprocess. Both sides exchange one JSON object per
//! line over stdin/stdout.

use serde::{Deserialize, Serialize};

/// A request sent from Rust to the Python worker.
#[derive(Debug, Serialize, Deserialize)]
pub struct JobRequest {
    /// Correlates a response back to its originating request.
    pub id: u64,
    /// The operation to perform (e.g. "ping", later "surface_mesh").
    pub job: String,
    /// Operation-specific payload. Kept generic so the protocol stays
    /// stable while the meshing feature set grows.
    #[serde(default)]
    pub data: serde_json::Value,
}

/// A response emitted by the Python worker.
#[derive(Debug, Serialize, Deserialize)]
pub struct JobResponse {
    /// Echoes the request `id`.
    pub id: u64,
    /// "ok" on success, "error" on failure.
    pub status: String,
    /// Human-readable message (error detail or a short note).
    #[serde(default)]
    pub message: Option<String>,
    /// Operation-specific result payload.
    #[serde(default)]
    pub data: serde_json::Value,
}

impl JobResponse {
    pub fn is_ok(&self) -> bool {
        self.status == "ok"
    }
}
