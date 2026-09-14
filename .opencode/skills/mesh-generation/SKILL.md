---
name: rust-python-bridge
description: Reference pattern for calling the Python/Gmsh meshing subprocess from the Rust application layer in the GMESH project. Use whenever writing or modifying code that connects the Rust server to the Python meshing backend.
---

# Rust → Python Meshing Bridge

This project's architecture (see AGENTS.md) is: Rust handles the web
server/application layer; Python (with Gmsh) handles all actual meshing
computation. This skill defines how that connection should work.

## Why this split exists
Gmsh's official, fully-featured API is Python/C++/Julia — not Rust. The
available Rust bindings (`gmsh-sys`, `rgmsh`) are unmaintained/incomplete
(see AGENTS.md for details). Rather than fight that gap, Rust calls out
to a Python process that uses the real, fully-featured Gmsh Python API.

## Recommended pattern
1. **Process boundary**: Rust spawns a Python subprocess (`std::process::
   Command`) or, for repeated calls, keeps a long-lived Python worker
   process running and communicates over stdin/stdout or a local socket
   — prefer a long-lived worker over spawning a fresh process per mesh
   request, to avoid Python/Gmsh startup overhead on every call.
2. **Data exchange**: pass structured data (mesh parameters in, file
   paths or mesh metadata out) via JSON over stdin/stdout, or via a
   minimal local HTTP API (e.g. Python side runs a small FastAPI/Flask
   service on localhost that Rust calls with reqwest). Either is
   acceptable; pick one and stay consistent across the codebase.
3. **File handoff for large data**: don't pass full mesh data (potentially
   large point/element arrays) through JSON strings — write mesh files to
   a shared temp directory and pass file paths between the two sides.
   This keeps memory overhead low, which matters for this project's goal.
4. **Error handling**: Python-side errors (Gmsh failures, bad geometry,
   etc.) must be surfaced back to Rust as structured error responses, not
   swallowed. Rust should never treat a missing/failed Python response as
   a "success with empty mesh" — that's a stub-in-disguise pattern.
5. **Real-call verification**: every meshing endpoint should be
   verifiable — i.e., there must be a way to confirm the Python process
   was actually invoked and Gmsh actually ran (e.g. log output showing
   the Gmsh version or a mesh element count), not just a code path that
   returns a plausible-looking response. Per AGENTS.md, always state
   explicitly whether a given code path is calling the real Gmsh process
   or is a placeholder.

## What NOT to do
- Do not reimplement any meshing algorithm in Rust "to avoid the bridge."
- Do not attempt `gmsh-sys`/`rgmsh` FFI bindings for core computation
  without flagging it — they don't cover this project's required feature
  set (boundary layers, quality metrics, advanced sizing).
- Do not silently mock the Python call and return fake mesh statistics if
  the subprocess fails to start (e.g. Python not found in PATH) — surface
  a clear, real error instead.
