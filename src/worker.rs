//! Bridge that manages a long-lived Python/Gmsh worker subprocess.
//!
//! Rust never performs meshing math itself. This module owns the child
//! process and relays JSON-line jobs to it, returning structured responses.
//! A single worker process is reused across calls to avoid Python/Gmsh
//! startup cost per request. The worker can be killed and respawned
//! (`restart`) so an unresponsive engine is recoverable from the UI instead
//! of requiring the user to close the terminal window.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use tokio::sync::oneshot;

use crate::api::{JobRequest, JobResponse};

/// A unit of work delivered to the worker thread.
struct Dispatch {
    id: u64,
    job: String,
    data: serde_json::Value,
    reply: oneshot::Sender<Result<JobResponse, String>>,
}

/// Mutable, restartable part of the worker.
struct Inner {
    tx: Option<Sender<Dispatch>>,
    child: Option<Child>,
}

/// Handle to the shared, long-lived worker. `Worker` is `Send + Sync`, so
/// it can be shared across Axum request handlers via `Arc`.
pub struct Worker {
    inner: Arc<Mutex<Inner>>,
    next_id: Arc<AtomicU64>,
    python: String,
    script: PathBuf,
}

impl Worker {
    /// Spawns the Python/Gmsh worker subprocess once and starts its I/O
    /// thread. `python` is the interpreter command; `script` is the path to
    /// `gmesh_worker.py`.
    pub fn spawn(python: &str, script: &PathBuf) -> Result<Worker, String> {
        let worker = Worker {
            inner: Arc::new(Mutex::new(Inner {
                tx: None,
                child: None,
            })),
            next_id: Arc::new(AtomicU64::new(1)),
            python: python.to_string(),
            script: script.clone(),
        };
        worker.start()?;
        Ok(worker)
    }

    /// (Re)starts the child process and its I/O thread.
    fn start(&self) -> Result<(), String> {
        let mut child = Command::new(&self.python)
            .arg(&self.script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("failed to spawn Python worker `{}`: {e}", self.python))?;

        let stdin = child.stdin.take().expect("worker stdin piped");
        let stdout = child.stdout.take().expect("worker stdout piped");
        let stderr = child.stderr.take().expect("worker stderr piped");

        // Forward the worker's stderr (Python warnings, Gmsh logs) into the
        // server's own stderr so real Gmsh activity is observable.
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(l) => eprintln!("[gmesh-python] {l}"),
                    Err(_) => break,
                }
            }
        });

        let (tx, rx) = channel::<Dispatch>();
        thread::spawn(move || worker_loop(stdin, stdout, rx));

        let mut inner = self.inner.lock().map_err(|_| "worker lock poisoned")?;
        inner.tx = Some(tx);
        inner.child = Some(child);
        Ok(())
    }

    /// Kills the current worker process and starts a fresh one. Safe to call
    /// when the worker is hung or has died.
    pub fn restart(&self) -> Result<(), String> {
        {
            let mut inner = self.inner.lock().map_err(|_| "worker lock poisoned")?;
            // Dropping the sender makes the old I/O loop exit once its child
            // goes away.
            inner.tx = None;
            if let Some(mut child) = inner.child.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        self.start()
    }

    /// True when a worker process is currently tracked.
    pub fn is_running(&self) -> bool {
        self.inner
            .lock()
            .map(|i| i.child.is_some())
            .unwrap_or(false)
    }

    /// Performs a real round-trip against the worker.
    pub async fn dispatch(
        &self,
        job: &str,
        data: serde_json::Value,
    ) -> Result<JobResponse, String> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        // Clone the sender and drop the lock before awaiting.
        let tx = {
            let inner = self.inner.lock().map_err(|_| "worker lock poisoned")?;
            inner.tx.clone()
        };
        let tx = tx.ok_or_else(|| "Python worker is not running".to_string())?;
        tx.send(Dispatch {
            id,
            job: job.to_string(),
            data,
            reply: reply_tx,
        })
        .map_err(|_| "Python worker is not running".to_string())?;
        reply_rx
            .await
            .map_err(|_| "Python worker dropped the request".to_string())?
    }

    /// Verifies the Gmsh backend is alive and reports the Gmsh version.
    pub async fn ping(&self) -> Result<JobResponse, String> {
        self.dispatch("ping", serde_json::Value::Null).await
    }
}

/// Resolves the path to the Python worker script.
pub fn worker_script_path() -> PathBuf {
    std::env::var_os("GMESH_WORKER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("python")
                .join("gmesh_worker.py")
        })
}

/// Writer/reader loop. Consumes jobs serially: writes one request line to
/// the worker, reads one response line, and forwards it to the caller.
fn worker_loop(
    mut stdin: std::process::ChildStdin,
    stdout: std::process::ChildStdout,
    rx: Receiver<Dispatch>,
) {
    let mut stdout = BufReader::new(stdout);
    while let Ok(dispatch) = rx.recv() {
        let Dispatch {
            id,
            job,
            data,
            reply,
        } = dispatch;

        let request = JobRequest { id, job, data };
        let line = match serde_json::to_string(&request) {
            Ok(l) => l,
            Err(e) => {
                let _ = reply.send(Err(format!("failed to serialize request: {e}")));
                continue;
            }
        };

        if stdin
            .write_all(line.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .and_then(|_| stdin.flush())
            .is_err()
        {
            let _ = reply.send(Err("failed to write to Python worker".to_string()));
            break;
        }

        let mut response_line = String::new();
        match stdout.read_line(&mut response_line) {
            Ok(0) | Err(_) => {
                let _ = reply.send(Err("Python worker closed stdout".to_string()));
                break;
            }
            Ok(_) => {}
        }

        match serde_json::from_str::<JobResponse>(response_line.trim()) {
            Ok(resp) if resp.id == id => {
                let _ = reply.send(Ok(resp));
            }
            Ok(resp) => {
                let _ = reply.send(Err(format!(
                    "response id mismatch: got {}, expected {id}",
                    resp.id
                )));
            }
            Err(e) => {
                let _ = reply.send(Err(format!(
                    "invalid response JSON (`{response_line}`): {e}"
                )));
            }
        }
    }
}
