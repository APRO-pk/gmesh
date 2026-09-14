# GMESH — Project Instructions for OpenCode

## What this project is
A lightweight, browser-based mesh generation tool (like ANSYS Meshing / Gmsh),
built for aerospace/rocket component geometry (airframes, nozzles), optimized
for LOW MEMORY USAGE.

## Hard constraints — do not violate these
1. **Do not invent meshing algorithms or quality-metric formulas.**
   Use only algorithms and definitions documented by Gmsh, Netgen, CGAL,
   or standard FEM/CFD meshing literature. If unsure, say so and ask for
   review instead of guessing.
2. **Do not reimplement core meshing math (Delaunay, advancing-front,
   tetrahedralization) from scratch in JavaScript/Python.** Wrap an
   existing open-source kernel (Gmsh via its API, or Gmsh compiled to
   WebAssembly). This is both faster to build and far more memory-efficient
   than a hand-rolled implementation.
3. **Keep the browser client lightweight.** Heavy volume-mesh computation
   must run server-side (or in a WASM worker), so the browser only ever
   holds a surface-mesh preview, not the full volumetric mesh in memory.
4. **Units:** default to SI (meters, kg, seconds) unless told otherwise.
   Always label units explicitly in the UI.
5. **Scope: standalone mesh generation tool. No specific downstream solver
   is targeted.** The goal is a meshing tool in its own right (comparable
   to Gmsh or ANSYS Meshing as standalone products) — not an integration
   with any particular solver (not ANSYS Fluent, not OpenFOAM, not
   anything else). Do not build solver-specific import/setup features.
   - Primary meshing path: **Gmsh** (Python API, already installed and
     verified working on this machine) generates the full mesh —
     geometry cleanup/healing, surface mesh, AND volume mesh (tet, or
     hex-dominant where practical).
   - Export universal, standard formats only — see section below. Do not
     build ANSYS-specific, OpenFOAM-specific, or any other solver-specific
     export/import logic.

## Mesh quality thresholds (generic defaults — override once solver is known)
- Skewness: flag any element above 0.85 as failing
- Aspect ratio: flag above 20:1 as failing
- Orthogonal quality: flag below 0.15 as failing
- Jacobian ratio: flag below 0.3 as failing
(These are standard generic FEM/CFD thresholds — replace with your own
project-specific values once you know your solver and physics regime.)

## Build approach
Build incrementally, one capability at a time, in this order:
1. CAD import (STEP/IGES/STL) + basic surface tri-mesh with uniform sizing
2. Local/curvature-based refinement controls
3. Boundary layer / inflation layer controls
4. Quad/hex meshing support
5. Mesh quality dashboard
6. Multi-body assembly support

Each step should be a working, testable increment — do not attempt to
build all features in one pass.

## Scope boundary: MESHING ONLY, not CAD authoring
This tool imports existing CAD geometry (STEP/IGES/STL) and meshes it.
It does NOT create or edit CAD geometry — no sketching, extrusion,
boolean operations, parametric modeling, or geometry-authoring features
of any kind. If the geometry needs fixing/healing before meshing (gap
detection, defeaturing, sliver removal), that's in scope, since it
directly serves meshing quality — but general CAD editing/design tools
are explicitly out of scope. Do not add CAD-authoring features even if
they seem like natural additions; redirect such requests back to
"import a corrected file" instead.


**Rust is required for the application layer.** Confirmed hard requirement.

Honest technical reality (verified via research, not assumption):
Rust bindings to Gmsh exist (`gmsh-sys`, `rgmsh`) but are UNMAINTAINED and
EXPERIMENTAL — `rgmsh`'s own package metadata marks it "experimental,"
it only wraps a partial subset of Gmsh's API (basic geometry only — no
boundary layers, no quality metrics, no advanced sizing), and `gmsh-sys`
is pinned to an old Gmsh version (4.4.1) via manual bindgen, not the
4.15.2 already installed and verified on this machine. Attempting to
build the actual meshing computation in pure Rust today risks either (a)
silent stubbing when the incomplete bindings can't cover a needed
feature, or (b) a large, fragile bindgen/C-SDK setup task.

**Required architecture:**
- **Rust**: the application layer — web server/API, request handling,
  file I/O, UI logic. This is where Rust's speed and memory-efficiency
  genuinely help toward the low-memory goal.
- **Python + Gmsh (already installed, verified working via `pip install
  gmsh`)**: runs as a separate subprocess/microservice that the Rust
  layer calls out to for the actual meshing computation (geometry
  healing, surface mesh, volume mesh, sizing, boundary layers). Rust
  and Python communicate via local files or a local API/IPC — do not
  reimplement Gmsh's algorithms in Rust.
- Do NOT attempt to wire up `gmsh-sys`/`rgmsh` for core meshing
  computation without flagging it to the user first — these bindings are
  not production-ready for this scope.
- If a future need arises to go fully Rust-native (no Python at all),
  that requires a separate, explicitly-scoped effort to extend the
  existing incomplete bindings or write a mesher from scratch — not a
  quick task. Flag this clearly if asked to do it "quickly."

## Presentation requirement (manager-mandated)
Build features as one integrated, cohesive tool — not visually or
structurally divided into separate "sections" or modules in the UI. Use
the mesh-generation skill's content to inform correct terminology/
parameter groupings, but the app's UI/UX should feel like a single unified
tool, not a set of siloed panels bolted together.

Keep the codebase clean: no leftover AI-scaffolding cruft, no dead code,
no unused generated boilerplate. Review and remove unused code as part of
each build step, not as a final pass.

## TODAY'S TARGET SCOPE (temporary — overrides the full feature list below
## until this core is working and verified)
Build ONLY this much today, in this order, and stop once it's real and
working:
1. Rust server + Python/Gmsh subprocess bridge — verified with a trivial
   real round-trip call (e.g. Rust asks Python to report the installed
   Gmsh version, gets a real answer back).
2. CAD import (accept at least STL to start; STEP/IGES can come later) →
   real Gmsh surface mesh generation.
3. Real Gmsh volume mesh generation from that surface mesh.
4. Export the real volume mesh to a `.msh` file the user can open and
   inspect in Gmsh itself or another viewer.

Do NOT build sizing controls, boundary layers, quad/hex options, the
quality dashboard, or a polished UI yet — those come after this core
pipeline is proven working end-to-end with real (non-mocked) output.
A single basic web form (upload file, click "generate mesh", get a
download link) is sufficient for today's scope. Confirm explicitly after
each of the 4 items above whether the Gmsh call was real or stubbed
before moving to the next.

## Full feature scope (build AFTER today's core pipeline is verified)

## When uncertain
If a requirement is ambiguous, or touches on something that would affect
real hardware analysis (thermal loads, structural margins, CFD accuracy),
stop and flag it for human review rather than guessing. The user is a
qualified aerospace engineer — trust their judgment on domain thresholds,
but do not silently substitute your own assumptions for stated ones.
