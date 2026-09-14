use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use axum::body::Body;
use axum::extract::{Multipart, Path, State};
use axum::http::{header, StatusCode};
use axum::response::Response;
use axum::Json;
use serde_json::json;

use crate::api::JobResponse;
use crate::error::AppError;
use crate::worker::Worker;

/// Shared application state handed to request handlers.
#[derive(Clone)]
pub struct AppState {
    pub worker: Arc<Worker>,
    pub next_job: Arc<AtomicU64>,
    pub work_dir: PathBuf,
    /// Path to the entity snapshot (per-face/per-edge mesh geometry) written by
    /// the worker at the end of the last successful mesh job. Interactive picks
    /// and entity listings are answered from this file in Rust, so they keep
    /// working while the single Gmsh worker is busy meshing.
    pub entity_snapshot: Arc<RwLock<Option<PathBuf>>>,
    /// True while a mesh job is in flight. The worker is single-threaded, so a
    /// health check must not queue behind a running job (that would look like
    /// "engine unreachable" during every long mesh).
    pub busy: Arc<std::sync::atomic::AtomicBool>,
    /// Last known Gmsh version, cached so health checks can answer while busy.
    pub gmsh_version: Arc<RwLock<Option<String>>>,
}

/// Clears the `busy` flag when dropped — including when the request future is
/// dropped because the browser disconnected mid-mesh, so the flag can never
/// stay stuck on.
struct BusyGuard(Arc<std::sync::atomic::AtomicBool>);
impl BusyGuard {
    fn new(flag: Arc<std::sync::atomic::AtomicBool>) -> Self {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
        BusyGuard(flag)
    }
}
impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

impl AppState {
    fn new_job_dir(&self, job_id: u64) -> PathBuf {
        self.work_dir.join(job_id.to_string())
    }
}

/// GET /api/ping — real round-trip: asks the live Python/Gmsh worker for
/// the Gmsh version. Confirms the entire Rust -> Python -> Gmsh pipeline
/// is actually running (never a stubbed response).
pub async fn ping(State(state): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    // While a mesh job is running the worker cannot answer (single-threaded),
    // so report the cached status instead of queueing behind the job. This is
    // what keeps a long mesh from looking like "engine unreachable".
    if state.busy.load(std::sync::atomic::Ordering::Relaxed) {
        let version = state
            .gmsh_version
            .read()
            .ok()
            .and_then(|v| v.clone());
        return Ok(Json(json!({
            "status": "ok",
            "busy": true,
            "gmsh_version": version,
            "message": "meshing in progress",
        })));
    }
    let resp = match tokio::time::timeout(std::time::Duration::from_secs(3), state.worker.ping()).await
    {
        Ok(r) => r.map_err(AppError::Backend)?,
        Err(_) => {
            // The worker did not answer in time. The server is clearly up (it
            // is answering us), so the engine is busy/working, not unreachable.
            let version = state.gmsh_version.read().ok().and_then(|v| v.clone());
            return Ok(Json(json!({
                "status": "ok",
                "busy": true,
                "gmsh_version": version,
                "message": "meshing in progress",
            })));
        }
    };
    if resp.is_ok() {
        if let Some(v) = resp.data.get("gmsh_version").and_then(|v| v.as_str()) {
            if let Ok(mut slot) = state.gmsh_version.write() {
                *slot = Some(v.to_string());
            }
        }
        tracing::info!(
            "gmesh round-trip ok: {}",
            resp.message.clone().unwrap_or_default()
        );
        Ok(Json(json!({
            "status": "ok",
            "busy": false,
            "gmsh_version": resp.data.get("gmsh_version"),
            "message": resp.message,
        })))
    } else {
        Err(AppError::Backend(
            resp.message.unwrap_or_else(|| "unknown Gmsh backend error".to_string()),
        ))
    }
}

/// POST /api/restart-engine — kills a hung or dead Python/Gmsh worker and
/// starts a fresh one, then verifies it with a real ping. Lets the user
/// recover the engine from the UI instead of restarting the whole server.
pub async fn restart_engine(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    let worker = state.worker.clone();
    tokio::task::spawn_blocking(move || worker.restart())
        .await
        .map_err(|e| AppError::Backend(format!("restart task failed: {e}")))?
        .map_err(AppError::Backend)?;
    let resp = state.worker.ping().await.map_err(AppError::Backend)?;
    if !resp.is_ok() {
        return Err(AppError::Backend(
            resp.message
                .unwrap_or_else(|| "restarted worker failed to answer".to_string()),
        ));
    }
    tracing::info!("mesh engine restarted");
    Ok(Json(json!({
        "status": "ok",
        "gmsh_version": resp.data.get("gmsh_version"),
        "message": "mesh engine restarted",
    })))
}

/// POST /api/mesh — upload an STL and generate a surface mesh (real Gmsh).
/// Fields: `geo` (STL bytes), `size` (global uniform size, metres).
pub async fn import_mesh(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<serde_json::Value>, AppError> {
    let mut geometry: Option<axum::body::Bytes> = None;
    let mut size: f64 = 0.1;
    let mut curvature: i64 = 0;
    let mut proximity: i64 = 0;
    let mut size_min: f64 = 0.0;
    let mut size_max: f64 = 0.0;
    let mut growth_rate: f64 = 1.2;
    let mut volume: bool = false;
    let mut regions: serde_json::Value = serde_json::Value::Array(vec![]);
    let mut edge_sizes: serde_json::Value = serde_json::Value::Array(vec![]);
    let mut face_sizes: serde_json::Value = serde_json::Value::Array(vec![]);
    let mut boundary_layer: serde_json::Value = serde_json::Value::Null;
    let mut advanced_size_function: String = "off".to_string();
    let mut smoothing: String = "none".to_string();
    let mut transition: String = "fast".to_string();
    let mut span_angle_center: String = "medium".to_string();
    let mut surface_algorithm: String = "program_controlled".to_string();
    let mut size_seed: f64 = 0.0;
    let mut mesh_method: String = "tet".to_string();
    let mut token: String = String::new();
    let mut export_format: String = "msh".to_string();
    let mut sweep_source: serde_json::Value = serde_json::Value::Array(vec![]);
    let mut sweep_target: i64 = 0;
    let mut sweep_layers: i64 = 5;
    let mut named_selections: serde_json::Value = serde_json::Value::Array(vec![]);
    let mut recombine: bool = false;
    let mut revolve_axis: String = "x".to_string();
    let mut revolve_layers: i64 = 8;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::Backend(format!("invalid multipart upload: {e}")))?
    {
        match field.name() {
            Some("geo") => {
                geometry = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| AppError::Backend(format!("failed to read STL: {e}")))?,
                );
            }
            Some("size") => {
                if let Ok(text) = field.text().await {
                    if let Ok(v) = text.trim().parse::<f64>() {
                        if v > 0.0 {
                            size = v;
                        }
                    }
                }
            }
            Some("curvature") => {
                if let Ok(text) = field.text().await {
                    curvature = text.trim().parse::<i64>().unwrap_or(0);
                }
            }
            Some("size_min") => {
                if let Ok(text) = field.text().await {
                    size_min = text.trim().parse::<f64>().unwrap_or(0.0);
                }
            }
            Some("size_max") => {
                if let Ok(text) = field.text().await {
                    size_max = text.trim().parse::<f64>().unwrap_or(0.0);
                }
            }
            Some("growth_rate") => {
                if let Ok(text) = field.text().await {
                    growth_rate = text.trim().parse::<f64>().unwrap_or(1.2);
                }
            }
            Some("proximity") => {
                if let Ok(text) = field.text().await {
                    proximity = text.trim().parse::<i64>().unwrap_or(0);
                }
            }
            Some("volume") => {
                if let Ok(text) = field.text().await {
                    volume = matches!(text.trim(), "true" | "1");
                }
            }
            Some("regions") => {
                if let Ok(text) = field.text().await {
                    regions = serde_json::from_str(text.trim())
                        .unwrap_or_else(|_| serde_json::Value::Array(vec![]));
                }
            }
            Some("edge_sizes") => {
                if let Ok(text) = field.text().await {
                    edge_sizes = serde_json::from_str(text.trim())
                        .unwrap_or_else(|_| serde_json::Value::Array(vec![]));
                }
            }
            Some("face_sizes") => {
                if let Ok(text) = field.text().await {
                    face_sizes = serde_json::from_str(text.trim())
                        .unwrap_or_else(|_| serde_json::Value::Array(vec![]));
                }
            }
            Some("boundary_layer") => {
                if let Ok(text) = field.text().await {
                    boundary_layer = serde_json::from_str(text.trim())
                        .unwrap_or(serde_json::Value::Null);
                }
            }
            Some("advanced_size_function") => {
                if let Ok(text) = field.text().await {
                    advanced_size_function = text.trim().to_string();
                }
            }
            Some("smoothing") => {
                if let Ok(text) = field.text().await {
                    smoothing = text.trim().to_string();
                }
            }
            Some("transition") => {
                if let Ok(text) = field.text().await {
                    transition = text.trim().to_string();
                }
            }
            Some("span_angle_center") => {
                if let Ok(text) = field.text().await {
                    span_angle_center = text.trim().to_string();
                }
            }
            Some("surface_algorithm") => {
                if let Ok(text) = field.text().await {
                    surface_algorithm = text.trim().to_string();
                }
            }
            Some("size_seed") => {
                if let Ok(text) = field.text().await {
                    size_seed = text.trim().parse::<f64>().unwrap_or(0.0);
                }
            }
            Some("mesh_method") => {
                if let Ok(text) = field.text().await {
                    mesh_method = text.trim().to_string();
                }
            }
            Some("token") => {
                if let Ok(text) = field.text().await {
                    token = text.trim().to_string();
                }
            }
            Some("export_format") => {
                if let Ok(text) = field.text().await {
                    export_format = text.trim().to_string();
                }
            }
            Some("sweep_source") => {
                if let Ok(text) = field.text().await {
                    sweep_source = serde_json::from_str(text.trim())
                        .unwrap_or_else(|_| serde_json::Value::Array(vec![]));
                }
            }
            Some("sweep_target") => {
                if let Ok(text) = field.text().await {
                    sweep_target = text.trim().parse::<i64>().unwrap_or(0);
                }
            }
            Some("sweep_layers") => {
                if let Ok(text) = field.text().await {
                    sweep_layers = text.trim().parse::<i64>().unwrap_or(5);
                }
            }
            Some("named_selections") => {
                if let Ok(text) = field.text().await {
                    named_selections = serde_json::from_str(text.trim())
                        .unwrap_or_else(|_| serde_json::Value::Array(vec![]));
                }
            }
            Some("recombine") => {
                if let Ok(text) = field.text().await {
                    recombine = matches!(text.trim(), "true" | "1");
                }
            }
            Some("revolve_axis") => {
                if let Ok(text) = field.text().await {
                    revolve_axis = text.trim().to_string();
                }
            }
            Some("revolve_layers") => {
                if let Ok(text) = field.text().await {
                    revolve_layers = text.trim().parse::<i64>().unwrap_or(8);
                }
            }
            _ => {}
        }
    }

    let geometry = geometry.ok_or_else(|| AppError::Backend("no 'geo' STL file uploaded".into()))?;

    let job_id = state.next_job.fetch_add(1, Ordering::Relaxed);
    let job_dir = state.new_job_dir(job_id);
    let input_path = job_dir.join("input.stl");
    let msh_path = job_dir.join("mesh.msh");
    let stl_path = job_dir.join("mesh.stl");

    std::fs::create_dir_all(&job_dir)
        .map_err(|e| AppError::Backend(format!("failed to create work dir: {e}")))?;
    std::fs::write(&input_path, &geometry)
        .map_err(|e| AppError::Backend(format!("failed to write uploaded STL: {e}")))?;

    tracing::info!(
        "meshing job {job_id}: STL {} bytes, size {size} m, curvature {curvature}, proximity {proximity}, volume {volume}, {} regions, {} edge sizes, {} face sizes, boundary layer {}",
        geometry.len(),
        regions.as_array().map_or(0, Vec::len),
        edge_sizes.as_array().map_or(0, Vec::len),
        face_sizes.as_array().map_or(0, Vec::len),
        !boundary_layer.is_null()
    );
    let start = std::time::Instant::now();
    let safe_token: String = token
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    let progress_file = state.work_dir.join(format!("progress_{safe_token}.json"));
    let export_ext = export_format.clone();
    let export_path = job_dir.join(format!("export.{export_ext}"));
    let job = state
        .worker
        .dispatch(
            "surface_mesh",
            json!({
                "input": input_path,
                "msh": msh_path,
                "stl": stl_path,
                "size": size,
                "size_min": size_min,
                "size_max": size_max,
                "growth_rate": growth_rate,
                "curvature": curvature,
                "proximity": proximity,
                "volume": volume,
                "regions": regions,
                "edge_sizes": edge_sizes,
                "face_sizes": face_sizes,
                "boundary_layer": boundary_layer,
                "advanced_size_function": advanced_size_function,
                "smoothing": smoothing,
                "transition": transition,
                "span_angle_center": span_angle_center,
                "surface_algorithm": surface_algorithm,
                "size_seed": size_seed,
                "mesh_method": mesh_method,
                "progress_file": progress_file.display().to_string(),
                "export_path": export_path.display().to_string(),
                "sweep_source": sweep_source,
                "sweep_target": if sweep_target > 0 { serde_json::json!(sweep_target) } else { serde_json::Value::Null },
                "sweep_layers": sweep_layers,
                "named_selections": named_selections,
                "recombine": recombine,
                "revolve_axis": revolve_axis,
                "revolve_layers": revolve_layers,
            }),
        );
    // Hard limit on any single mesh job. A pathological element size can make
    // Gmsh run for a very long time; without this the worker stays busy and
    // every later request queues behind it (the "engine unreachable" symptom).
    // On timeout the worker is killed and restarted automatically.
    let timeout_secs: u64 = std::env::var("GMESH_MESH_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(300);
    let _busy_guard = BusyGuard::new(state.busy.clone());
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), job).await;
    let resp = match outcome {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err(AppError::Backend(e)),
        Err(_) => {
            tracing::warn!(
                "meshing job {job_id} exceeded {timeout_secs}s — cancelling and restarting the worker"
            );
            let worker = state.worker.clone();
            let _ = tokio::task::spawn_blocking(move || worker.restart()).await;
            return Err(AppError::Backend(format!(
                "Mesh job exceeded the {timeout_secs}s time limit and was cancelled; the mesh \
                 engine was restarted automatically and is ready for the next request. Check the \
                 element size — a size far smaller than the model can take a very long time."
            )));
        }
    };
    let generation_seconds = start.elapsed().as_secs_f64();

    if !resp.is_ok() {
        let msg = resp
            .message
            .unwrap_or_else(|| "Gmsh surface meshing failed".to_string());
        tracing::warn!("meshing job {job_id} failed: {msg}");
        return Err(AppError::Backend(msg));
    }

    tracing::info!(
        "meshing job {job_id} complete in {generation_seconds:.2}s"
    );
    // Point interactive picking at this job's entity snapshot.
    *state
        .entity_snapshot
        .write()
        .expect("entity snapshot lock") = Some(job_dir.join("entities.json"));
    Ok(Json(surface_mesh_response(
        job_id,
        resp,
        generation_seconds,
        &export_ext,
    )))
}

/// POST /api/pick — given a 3D point, returns the nearest face/edge tags for
/// click-to-select in the viewport. Answered from the cached entity snapshot
/// when one exists, so picking never queues behind a running mesh job; falls
/// back to the Python worker only if no snapshot has been produced yet.
pub async fn pick(
    State(state): State<AppState>,
    Json(point): Json<serde_json::Value>,
) -> Result<Json<serde_json::Value>, AppError> {
    if let Some(snapshot) = load_snapshot(&state) {
        let x = point.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let y = point.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let z = point.get("z").and_then(|v| v.as_f64()).unwrap_or(0.0);
        return Ok(Json(json!({
            "status": "ok",
            "data": pick_from_snapshot(&snapshot, x, y, z),
        })));
    }
    let resp = state
        .worker
        .dispatch("pick", point)
        .await
        .map_err(AppError::Backend)?;
    if resp.is_ok() {
        Ok(Json(json!({ "status": "ok", "data": resp.data })))
    } else {
        Err(AppError::Backend(
            resp.message.unwrap_or_else(|| "pick failed".to_string()),
        ))
    }
}

/// Reads and parses the cached entity snapshot. Falls back to the newest
/// `entities.json` on disk so picking keeps working after a server restart
/// (the in-memory cache is lost, but the snapshot files are not).
fn load_snapshot(state: &AppState) -> Option<serde_json::Value> {
    let cached = state
        .entity_snapshot
        .read()
        .ok()
        .and_then(|p| p.clone());
    let path = match cached {
        Some(p) if p.exists() => p,
        _ => newest_snapshot(&state.work_dir)?,
    };
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    let non_empty = ["faces", "edges"].iter().any(|k| {
        value
            .get(*k)
            .and_then(|v| v.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false)
    });
    if non_empty {
        Some(value)
    } else {
        None
    }
}

/// Newest `entities.json` under the work directory, if any.
fn newest_snapshot(work_dir: &std::path::Path) -> Option<PathBuf> {
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(work_dir).ok()?.flatten() {
        let path = entry.path().join("entities.json");
        if let Ok(meta) = std::fs::metadata(&path) {
            if let Ok(modified) = meta.modified() {
                if best.as_ref().map_or(true, |(t, _)| modified > *t) {
                    best = Some((modified, path));
                }
            }
        }
    }
    best.map(|(_, p)| p)
}

fn point3(value: &serde_json::Value) -> Option<[f64; 3]> {
    let a = value.as_array()?;
    Some([
        a.first()?.as_f64()?,
        a.get(1)?.as_f64()?,
        a.get(2)?.as_f64()?,
    ])
}

fn dist2(p: &[f64; 3], x: f64, y: f64, z: f64) -> f64 {
    let dx = p[0] - x;
    let dy = p[1] - y;
    let dz = p[2] - z;
    dx * dx + dy * dy + dz * dz
}

/// Nearest face/edge lookup over the snapshot geometry — the same query the
/// Python worker performs, done here so it does not depend on the worker.
fn pick_from_snapshot(snapshot: &serde_json::Value, x: f64, y: f64, z: f64) -> serde_json::Value {
    let mut best_face: Option<(u64, f64)> = None;
    let mut face_tris: Vec<serde_json::Value> = Vec::new();
    if let Some(faces) = snapshot.get("faces").and_then(|v| v.as_array()) {
        for face in faces {
            let (Some(tag), Some(tris)) = (
                face.get("tag").and_then(|v| v.as_u64()),
                face.get("tris").and_then(|v| v.as_array()),
            ) else {
                continue;
            };
            let mut mind = f64::INFINITY;
            for tri in tris {
                let Some(pts) = tri.as_array() else { continue };
                for p in pts {
                    if let Some(p) = point3(p) {
                        mind = mind.min(dist2(&p, x, y, z));
                    }
                }
            }
            if mind.is_finite() && best_face.map_or(true, |(_, d)| mind < d) {
                best_face = Some((tag, mind));
                face_tris = tris.clone();
            }
        }
    }

    let mut best_edge: Option<(u64, f64)> = None;
    let mut edge_segs: Vec<serde_json::Value> = Vec::new();
    let mut edge_len = 0.0_f64;
    if let Some(edges) = snapshot.get("edges").and_then(|v| v.as_array()) {
        for edge in edges {
            let (Some(tag), Some(segs)) = (
                edge.get("tag").and_then(|v| v.as_u64()),
                edge.get("segs").and_then(|v| v.as_array()),
            ) else {
                continue;
            };
            let mut mind = f64::INFINITY;
            for seg in segs {
                let Some(ends) = seg.as_array() else { continue };
                for p in ends {
                    if let Some(p) = point3(p) {
                        mind = mind.min(dist2(&p, x, y, z));
                    }
                }
            }
            if mind.is_finite() && best_edge.map_or(true, |(_, d)| mind < d) {
                best_edge = Some((tag, mind));
                edge_segs = segs.clone();
                edge_len = edge.get("length").and_then(|v| v.as_f64()).unwrap_or(0.0);
            }
        }
    }

    // Face centroid + area from the selected face's triangles.
    let mut sum = [0.0_f64; 3];
    let mut count = 0_u64;
    let mut area = 0.0_f64;
    for tri in &face_tris {
        let Some(pts) = tri.as_array() else { continue };
        let v: Vec<[f64; 3]> = pts.iter().filter_map(point3).collect();
        if v.len() != 3 {
            continue;
        }
        for p in &v {
            sum[0] += p[0];
            sum[1] += p[1];
            sum[2] += p[2];
            count += 1;
        }
        let ux = v[1][0] - v[0][0];
        let uy = v[1][1] - v[0][1];
        let uz = v[1][2] - v[0][2];
        let wx = v[2][0] - v[0][0];
        let wy = v[2][1] - v[0][1];
        let wz = v[2][2] - v[0][2];
        let cx = uy * wz - uz * wy;
        let cy = uz * wx - ux * wz;
        let cz = ux * wy - uy * wx;
        area += 0.5 * (cx * cx + cy * cy + cz * cz).sqrt();
    }
    let face_point = if count > 0 {
        Some(json!([sum[0] / count as f64, sum[1] / count as f64, sum[2] / count as f64]))
    } else {
        None
    };

    // Edge points: unique segment endpoints (matches the worker's node list).
    let mut edge_points: Vec<[f64; 3]> = Vec::new();
    for seg in &edge_segs {
        let Some(ends) = seg.as_array() else { continue };
        for p in ends {
            if let Some(p) = point3(p) {
                if !edge_points.iter().any(|q| q == &p) {
                    edge_points.push(p);
                }
            }
        }
    }

    let round6 = |v: f64| (v * 1e6).round() / 1e6;
    json!({
        "face": best_face.map(|(t, _)| t),
        "face_distance": best_face.map(|(_, d)| round6(d.sqrt())),
        "edge": best_edge.map(|(t, _)| t),
        "edge_distance": best_edge.map(|(_, d)| round6(d.sqrt())),
        "edge_points": edge_points,
        "edge_segments": edge_segs,
        "edge_length": round6(edge_len),
        "face_triangles": face_tris,
        "face_area": round6(area),
        "face_point": face_point,
    })
}

/// GET /api/entities — returns all surface faces/edges with centroid points
/// (used for box/window selection in the browser). Served from the cached
/// entity snapshot when available, else from the worker.
pub async fn entities(
    State(state): State<AppState>,
) -> Result<Json<serde_json::Value>, AppError> {
    if let Some(snapshot) = load_snapshot(&state) {
        return Ok(Json(json!({
            "status": "ok",
            "data": entities_from_snapshot(&snapshot),
        })));
    }
    let resp = state
        .worker
        .dispatch("entities", serde_json::Value::Null)
        .await
        .map_err(AppError::Backend)?;
    if resp.is_ok() {
        Ok(Json(json!({ "status": "ok", "data": resp.data })))
    } else {
        Err(AppError::Backend(
            resp.message.unwrap_or_else(|| "entities failed".to_string()),
        ))
    }
}

fn centroid(points: &[serde_json::Value]) -> Option<serde_json::Value> {
    let mut sum = [0.0_f64; 3];
    let mut count = 0_u64;
    for p in points {
        if let Some(p) = point3(p) {
            sum[0] += p[0];
            sum[1] += p[1];
            sum[2] += p[2];
            count += 1;
        }
    }
    if count == 0 {
        return None;
    }
    Some(json!([sum[0] / count as f64, sum[1] / count as f64, sum[2] / count as f64]))
}

fn entities_from_snapshot(snapshot: &serde_json::Value) -> serde_json::Value {
    let mut faces = Vec::new();
    if let Some(list) = snapshot.get("faces").and_then(|v| v.as_array()) {
        for face in list {
            let (Some(tag), Some(tris)) = (
                face.get("tag").and_then(|v| v.as_u64()),
                face.get("tris").and_then(|v| v.as_array()),
            ) else {
                continue;
            };
            let verts: Vec<serde_json::Value> = tris
                .iter()
                .filter_map(|t| t.as_array())
                .flatten()
                .cloned()
                .collect();
            if let Some(c) = centroid(&verts) {
                // `points` lets box-select test any part of the entity (not just
                // its centroid); `tris` lets a saved sizing record re-highlight.
                faces.push(json!({
                    "tag": tag,
                    "centroid": c,
                    "points": verts,
                    "tris": tris,
                }));
            }
        }
    }
    let mut edges = Vec::new();
    if let Some(list) = snapshot.get("edges").and_then(|v| v.as_array()) {
        for edge in list {
            let (Some(tag), Some(segs)) = (
                edge.get("tag").and_then(|v| v.as_u64()),
                edge.get("segs").and_then(|v| v.as_array()),
            ) else {
                continue;
            };
            let verts: Vec<serde_json::Value> = segs
                .iter()
                .filter_map(|s| s.as_array())
                .flatten()
                .cloned()
                .collect();
            if let Some(c) = centroid(&verts) {
                edges.push(json!({
                    "tag": tag,
                    "point": c,
                    "points": verts,
                    "segs": segs,
                    "length": edge.get("length"),
                }));
            }
        }
    }
    json!({ "faces": faces, "edges": edges })
}

/// GET /api/progress/:token — returns the live meshing progress written by
/// the worker ({percent, stage}) so the browser can show a percentage while
/// a job runs.
pub async fn progress(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Json<serde_json::Value>, AppError> {
    let safe: String = token
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    let path = state.work_dir.join(format!("progress_{safe}.json"));
    let content = std::fs::read_to_string(&path)
        .map_err(|_| AppError::NotFound("no progress for this job".into()))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|_| AppError::Backend("invalid progress data".into()))?;
    Ok(Json(value))
}

/// GET /preview/:job_id/:file — serves a generated mesh file (surface STL
/// preview or .msh) with a memory-light payload to the browser.
pub async fn preview(
    State(state): State<AppState>,
    Path((job_id, file)): Path<(u64, String)>,
) -> Result<Response, AppError> {
    if file != "mesh.stl"
        && file != "mesh.msh"
        && file != "quads.json"
        && !file.starts_with("export.")
    {
        return Err(AppError::NotFound("unknown asset".into()));
    }
    let path = state.new_job_dir(job_id).join(&file);
    let bytes = std::fs::read(&path)
        .map_err(|_| AppError::NotFound("asset not found".into()))?;
    // Serving a job's mesh preview also selects that job's entity snapshot, so
    // click-to-select works for whatever mesh is currently displayed.
    if file == "mesh.stl" {
        let snapshot = state.new_job_dir(job_id).join("entities.json");
        if snapshot.exists() {
            if let Ok(mut slot) = state.entity_snapshot.write() {
                *slot = Some(snapshot);
            }
        }
    }
    let media_type = if file == "mesh.stl" {
        "model/stl"
    } else if file == "quads.json" {
        "application/json"
    } else {
        "application/octet-stream"
    };
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, media_type)
        .body(Body::from(bytes))
        .expect("valid response"))
}

fn surface_mesh_response(
    job_id: u64,
    resp: JobResponse,
    generation_seconds: f64,
    export_ext: &str,
) -> serde_json::Value {
    let mut stats = resp.data;
    if let serde_json::Value::Object(ref mut map) = stats {
        map.insert(
            "generation_seconds".to_string(),
            serde_json::Value::from(generation_seconds),
        );
    }
    json!({
        "status": "ok",
        "job_id": job_id,
        "preview_url": format!("/preview/{job_id}/mesh.stl"),
        "msh_url": format!("/preview/{job_id}/mesh.msh"),
        "export_url": format!("/preview/{job_id}/export.{export_ext}"),
        "export_format": export_ext,
        "message": resp.message,
        "stats": stats,
    })
}
