# GMESH

A lightweight, browser-based **mesh generation tool** for engineering CAD
geometry (airframes, nozzles, and similar aerospace parts), built to stay
memory-light.

GMESH imports an existing triangulated model (STL), heals it, generates a
surface mesh, generates a volume mesh, and exports the result in standard
formats you can open in Gmsh or another viewer.

It is a **standalone meshing tool** — not an add-on for any particular solver.

---

## Architecture

```
browser (web/)                Rust server (src/)              Python/Gmsh worker (python/)
  UI + 3D preview   <--HTTP-->  axum web server     <--JSON-->  gmesh_worker.py
  upload / pick / sizing        file I/O, routing    lines      owns every real Gmsh call
                                job + progress
```

- **Rust (`src/`)** — the application layer: web server, request handling,
  file I/O, job/progress bookkeeping, and the interactive pick layer. It does
  **no** meshing math.
- **Python + Gmsh (`python/gmesh_worker.py`)** — a long-lived worker subprocess
  that performs *all* real meshing (geometry healing, surface mesh, volume
  mesh, sizing, boundary layers, quality metrics). Rust talks to it over a
  simple JSON-lines protocol on stdin/stdout.
- **Browser (`web/`)** — plain HTML/CSS/JS with Three.js. Holds only the
  surface-mesh preview, never the full volume mesh.

Heavy computation stays in the Python worker so the browser stays light. The
worker is supervised: a hung or runaway job is cancelled on a timeout and the
worker is restarted automatically.

---

## Requirements

- **Rust** (stable, tested with 1.98.x)
- **Python 3** with the **`gmsh`** package:

  ```sh
  pip install gmsh
  ```

No other dependencies are needed. The browser front-end uses Three.js from a
CDN.

---

## Build and run

The easiest way on Windows:

1. Build once:

   ```sh
   cargo build --release
   ```

2. Double-click **`start-gmesh.bat`**.

This opens a **watchdog** window that runs the server and **restarts it
automatically** if it ever stops, then opens the app at
<http://127.0.0.1:3000/>. Keep that window open while using GMESH; close it to
stop.

To run the server directly instead:

```sh
cargo run --release
```

The server prints the URL it bound to. If port 3000 is busy it will try the
next ports and tell you which one it used.

### Environment overrides (optional)

| Variable | Meaning | Default |
|---|---|---|
| `GMESH_ADDR` | listen address | `127.0.0.1:3000` |
| `GMESH_PYTHON` | Python interpreter | `python` |
| `GMESH_WORKER` | path to `gmesh_worker.py` | `<repo>/python/gmesh_worker.py` |
| `GMESH_WEB_DIR` | static web assets | `<repo>/web` |
| `GMESH_WORK_DIR` | scratch/job directory | system temp `gmesh` |
| `GMESH_MESH_TIMEOUT_SECS` | hard per-job time limit | `300` |

---

## Features

- **Import** STL geometry and preview it in the browser.
- **Healing** — duplicate-node removal and surface classification, so a raw
  triangulation can be re-meshed at a new size.
- **Surface mesh** — triangular or **quadrilateral** (blossom
  quad-recombination), with global / min / max sizing and local refinement
  regions.
- **Volume mesh** — tetrahedral (Delaunay), plus **Sweep** and **Revolve**
  methods that produce real hexahedra where the geometry allows.
- **Selection** — click-to-select faces/edges, Ctrl+click multi-select, box
  select, and an edge outline highlight.
- **Named selections** and independent **sizing controls** (ANSYS-style
  Geometry / Type / Element Size with Apply / Cancel).
- **Mesh quality** dashboard — skewness, aspect ratio, orthogonal quality,
  Jacobian ratio.
- **Export** — Gmsh `.msh` (with `$PhysicalNames` from named selections) and
  other standard formats (e.g. Nastran `.bdf`).

---

## Units

Gmsh is unit-agnostic: the numbers in your file are used as-is in whatever
**Unit System** you select (m, mm, cm, ft, in). Set the Unit System to match
your file before meshing. Displayed areas/lengths are converted to the
selected unit.

The default element size is derived from the geometry's **smallest
bounding-box dimension / 10**, so it is always meaningfully smaller than the
model.

---

## Known limitations

These are real, documented behaviours — not bugs to keep retrying:

- **There is no true volume hex mesher in Gmsh.** `Mesh.Algorithm3D = 10`
  ("HXT") is a **parallel Delaunay tetrahedral** algorithm, so "Hex-dominant"
  volume meshing falls back to **tetrahedra**. Gmsh offers no hexahedral
  volume algorithm. Real hexahedra in GMESH come only from the **Sweep** and
  **Revolve** methods.
- **Sweep** works for a **constant cross-section** swept from a source face to
  a target face. It is not a general swept-volume mesher, and it will not
  produce correct results for varying cross-sections (e.g. a converging
  nozzle) — use **Revolve** for those.
- **Revolve** is for **axisymmetric** shapes (a profile revolved about an
  axis). It auto-detects the axis (X/Y/Z) or you can set it; a
  non-axisymmetric part is refused rather than silently meshed wrong.
- A flat circular cap may be split into more than one face by surface
  classification; GMESH prefers the non-reparametrised classification, which
  keeps such caps whole.
- **Quad surface meshing** recombines the surface only; it does not imply a
  hex volume mesh.
- The volume mesh lives in the worker/on disk, not in the browser — the
  browser shows the surface preview.

---

## Repository layout

```
src/            Rust application layer (axum server, worker bridge, routes)
python/         Python/Gmsh worker (all meshing happens here)
web/            Browser UI (HTML/CSS/JS, Three.js)
samples/        Small example STL inputs
start-gmesh.bat Launch the server (with the watchdog)
watchdog.bat    Keeps the server running
make-dist.ps1   Build a clean source zip for handoff
AGENTS.md       Project constraints and build plan
```
