# MD-HISTORY.md — How GMESH was built

A running log of the real prompts/requests and what was actually implemented,
kept so this project can be rebuilt / understood / handed off. Each entry
records the build step, the request, and the concrete result. Update this file
as features are added.

---

## 0. Environment setup
**Prompt:** "Read AGENTS.md and the mesh-generation skill; follow the
Rust-app-layer + Python-Gmsh-subprocess architecture exactly."

- Rust was **not installed**; installed the **GNU** toolchain per user request
  (`rustup toolchain install stable-x86_64-pc-windows-gnu`), not MSVC.
- The GNU target needs MinGW binutils; added a portable **w64devkit**
  (`dlltool`, `gcc`, `ar`). `libgcc_eh.a` is absent in it, so a stub was
  created to satisfy Rust's `-lgcc_eh` link (GNU stack, no Visual Studio).
- Python 3.14.7 + **gmsh 4.15.2** confirmed installed.

---

## 1. Rust server + Python/Gmsh bridge
**Prompt:** "Start with step 1 only: Rust server + Python subprocess bridge,
verified with a trivial round-trip call first; confirm whether the Gmsh call
was real or stubbed."

- `Cargo.toml` (axum 0.7, tokio, serde, tower-http, tracing).
- `src/worker.rs` — spawns one **long-lived** Python worker and relays
  newline-delimited JSON over stdin/stdout (per the skill's recommended
  pattern); errors surfaced, never treated as success.
- `src/api.rs` — `{id, job, data}` request / `{id, status, message, data}`
  response protocol.
- `src/routes.rs` — `GET /api/ping`; `src/error.rs`; `src/main.rs`.
- `python/gmesh_worker.py` — imports + initialises real Gmsh, reports version.
- `web/` — unified shell with a live engine-status pill.
- **Real (not stubbed):** `/api/ping` returned `gmsh_version 4.15.2`.

---

## 2. CAD import (STL) + real surface mesh
**Prompt:** "Proceed to step 2: CAD import (STL to start) + real Gmsh surface
mesh generation."

- `POST /api/mesh` (multipart: `geo` STL + `size`), `GET /preview/:id/:file`.
- Worker job `surface_mesh`: `gmsh.merge` → `removeDuplicateNodes` →
  `classifySurfaces` → `createGeometry` → `generate(2)`; writes `.msh` + `.stl`.
- **Finding:** `gmsh.model.occ.importShapes` does **not** accept STL; the
  discrete `merge` + `classifySurfaces` + `createGeometry` route is used.
- Gmsh `Info:` logs go to stdout and would corrupt the JSON bridge; set
  `General.Terminal=0`, milestones logged to stderr.
- Viewport: lightweight surface STL preview only (Three.js), black wireframe
  edges over a shaded solid; auto-fit camera; grid/axes scaled to the model.
- **Real:** sphere/cylinder surface meshes with real node/triangle counts.

---

## 3. Refinement controls (curvature / proximity / local regions)
**Prompt:** "Add local/curvature-based refinement and proximity-based
refinement controls."

- Curvature → Gmsh `Mesh.MeshSizeFromCurvature` (elements per 2π).
- Proximity → Gmsh `Mesh.MeshSizeFromPoints`.
- Local regions → Gmsh **Box** size fields (combined via a `Min` field).
- **Finding:** the `BoundaryLayer` field rejected `In`; the Threshold input
  parameter is **`InField`**. Curvature(20) → sphere 1184 nodes.

---

## 4. Volume meshing + export .msh
**Prompt:** "Volume meshing (tet) + export the real volume mesh to a .msh."

- Worker builds a closed volume (`addSurfaceLoop` + `addVolume`) from the
  healed surface loop, then `generate(3)` (Delaunay tets), writes `.msh`.
- UI: **Volume mesh (tet)** checkbox, **Download .msh** link.
- **Real:** cylinder volume → 49,532 tets.

---

## 5. Boundary layer / inflation + edge & face sizing
**Prompt:** "Add face sizing, edge sizing, and inflation layer controls
(same as boundary layer)."

- **Finding:** the `BoundaryLayer` **field** is 2D-only in Gmsh 4.15.2; true
  3D inflation uses **`gmsh.model.geo.extrudeBoundaryLayer`** (prisms + tet
  core). `gmsh.model.mesh.setSize` only handles points (dim 0).
- Edge sizing: `Distance` + `Threshold` size field on a chosen edge.
- Face sizing: `Distance` + `Threshold` from the face's boundary curves.
- Boundary layer: `extrudeBoundaryLayer` on chosen wall faces (layers /
  first thickness / growth ratio → per-layer heights).
- Entity inventory (`faces`, `edges`) returned so the UI can offer sizing.
- **Real:** edge 7 → 3,673 nodes; face 2 → 10,083 nodes; BL → 2,700 prisms.

---

## 6. Mesh quality dashboard
**Prompt:** "Build the mesh quality dashboard — skewness, aspect ratio,
orthogonal quality, Jacobian ratio, using the AGENTS.md thresholds."

- Per AGENTS.md (no invented formulas): Jacobian = Gmsh **`minSJ`** (scaled
  Jacobian); aspect ratio = max/min edge; skewness & orthogonal quality =
  documented standard FEM/CFD definitions computed from node coordinates.
- Thresholds: skewness >0.85, aspect >20, orthogonal <0.15, Jacobian <0.3.
- UI quality panel with min/max/mean + color-coded fail count.
- **Real:** sphere all-pass; cylinder 48 skew / 5 orthogonal fails at the
  wall/transition (expected for sharp features).

---

## 7. Performance / scalability reporting
**Prompt:** "Add real memory usage (MB) and generation time (seconds) in the
UI after each mesh generation; confirm the browser only holds a lightweight
surface preview."

- Worker reports **real working-set MB** via WinAPI `GetProcessMemoryInfo`
  (psutil unavailable). Rust measures `generation_seconds` around the call.
- UI footer shows `… s · … MB` after every generate.
- Browser only fetches the surface `/preview/:id/mesh.stl`; the `.msh` is
  exposed only as a download link (never loaded client-side).

---

## 8. Viewport polish (ANSYS style)
**Prompt:** "Shaded solid + visible black wireframe of every element edge;
curvature-based refinement so it densifies around curves."

- Solid grey mesh + black `wireframe: true` overlay (polygon-offset to avoid
  z-fighting); curvature enabled by default.
- Auto-fit bounding-sphere camera; grid/axes scaled to the model so small
  parts are not dwarfed.

---

## 9. Click-to-select picking, zoom + axis gizmo, Sizing panel
**Prompt:** "Click-to-select picking in the viewport; zoom buttons + XYZ axis
gizmo; Relevance Center preset + grouped Sizing panel matching ANSYS."

- `POST /api/pick` + worker `pick` job: nearest face/edge to a point via
  entity mesh nodes (discrete surfaces have no parametric geometry, so
  `getClosestPoint` is unavailable). Pick buttons raycast the model and
  auto-fill the tag field + yellow marker.
- Zoom in/out buttons; corner XYZ axis gizmo (second mini-renderer) that
  rotates with the camera; click to reset to iso.
- Grouped **Sizing** fieldset: Relevance Center (Coarse/Medium/Fine) scaling
  the Max Size; Max/Min Size → `Mesh.MeshSizeMax/Min`; Curvature Normal Angle
  → `Mesh.MeshSizeFromCurvature`; Growth Rate → size-field transition;
  Proximity → `Mesh.MeshSizeFromPoints`.
- **Bug fixed:** Import STL broke after refresh — `initViewer()` (and a second
  WebGL context) ran before the file listeners; now listeners attach first and
  viewport init is wrapped in try/catch (WebGL context exhaustion on reload).

---

## 10. Save / load project
**Prompt:** "Add save/load project: export a JSON config capturing settings
plus a reference to the imported geometry, so I can reload and continue."

- **Save project** → `.gmesh.json` with sizing, refinement, boundary layer,
  relevance, volume flag, plus the geometry filename and its **base64 STL**
  content (self-contained).
- **Load project** → re-applies every setting and reconstructs the STL file
  from base64 so generation can continue without re-importing.

---

## 11. Build documentation + distribution
**Prompt:** "Create MD-HISTORY.md (this file); prepare the project for
distribution/handoff (include/exclude list or a script producing a clean
zip-ready copy)."

- `MD-HISTORY.md` — this log.
- `make-dist.ps1` — copies the source (src, python, web, samples, Cargo.*,
  AGENTS.md, MD-HISTORY.md) into a clean folder, excluding `target/`,
  `.git/`, `.opencode/`, `dist/`, caches, and zips it.

---

## 12. ANSYS-style Details panel + console + Qt-look chrome
**Prompt:** "Expand the meshing UI to match ANSYS Meshing's full Details
panel; show errors in a console under the mesh window; make mesh-file view
options icon-only (open on click); add a global element size; add an Update
button; tell me the Gmsh mapping for each new field."

- Browser UI restyled as a Qt-Fusion-look desktop app (title bar with
  min/max/close, menu bar, light-grey chrome, dark CAD viewport) — visual
  only, no architecture change.
- Left panel reorganized into collapsible ANSYS groups (native `<details>`):
  DEFAULTS, SIZING, INFLATION, PATCH CONFORMING, STATISTICS, REFINEMENT.
- Console panel under the mesh window shows meshing progress and errors
  (real `body.message` / network errors surfaced, never swallowed).
- `.msh` / STL-view now icon-only buttons in the status bar, acting on click.
- New worker params (all mapped to real Gmsh): `advanced_size_function`
  (Mesh.MeshSizeFromCurvature / Mesh.MeshSizeFromPoints), `smoothing`
  (Mesh.Smoothing iterations), `transition` (Threshold DistMax gradation),
  `surface_algorithm` (Mesh.Algorithm), `size_seed` (base size),
  `minimum_edge_length` (computed), inflation `auto/option/layers/first/
  growth/total/max_layers` (gmsh.model.geo.extrudeBoundaryLayer).
- `POST /api/mesh` forwards the new fields (routes.rs).
- **Real (verified):** sphere volume mesh → 236 nodes / 90 tets / 360 prisms
  with a 4-layer boundary layer; curvature+frontal-delaunay+medium smoothing
  surface mesh → real node/triangle counts and `minimum_edge_length`.
