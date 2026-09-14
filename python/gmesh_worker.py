"""GMESH meshing worker.

This process owns every real Gmsh call (geometry healing, surface mesh,
volume mesh, sizing, boundary layers, quality metrics). The Rust
application layer never performs meshing math; it sends JSON-line job
requests on stdin and receives JSON-line responses on stdout.

Jobs are processed one at a time. Any backend failure is reported as a
structured `{"status": "error", ...}` response so Rust never mistakes a
failed call for success.
"""

import json
import math
import os
import sys

# Global Gmsh handle, initialised lazily on first use. Kept alive so the
# native Gmsh library and its session state persist across requests,
# avoiding per-call re-initialisation cost.
_GMSH = None
_GMSH_VERSION = None
_GMSH_INIT_ERROR = None


def log(message):
    sys.stderr.write("[gmesh-python] {}\n".format(message))
    sys.stderr.flush()


def ensure_gmsh():
    """Import and initialise Gmsh once. Returns (gmsh_module, version)."""
    global _GMSH, _GMSH_VERSION, _GMSH_INIT_ERROR
    if _GMSH_INIT_ERROR is not None:
        raise RuntimeError(_GMSH_INIT_ERROR)
    if _GMSH is not None:
        return _GMSH, _GMSH_VERSION
    try:
        import gmsh
    except Exception as exc:
        _GMSH_INIT_ERROR = "failed to import gmsh: {}".format(exc)
        raise RuntimeError(_GMSH_INIT_ERROR)
    try:
        gmsh.initialize()
        # Pipe Gmsh's own log messages away from stdout so they never
        # corrupt the JSON-line protocol. Milestones are reported via
        # log() to stderr instead.
        gmsh.option.setNumber("General.Terminal", 0)
        version = getattr(gmsh, "__version__", None) or "unknown"
        # Keep the session alive; finalise only on process shutdown.
        _GMSH = gmsh
        _GMSH_VERSION = version
    except Exception as exc:
        _GMSH_INIT_ERROR = "failed to initialise gmsh: {}".format(exc)
        raise RuntimeError(_GMSH_INIT_ERROR)
    log("Gmsh initialised, version {}".format(version))
    return _GMSH, _GMSH_VERSION


def handle_ping(_data=None):
    gmsh, version = ensure_gmsh()
    log("round-trip OK, Gmsh version {}".format(version))
    return {
        "status": "ok",
        "message": "Gmsh worker ready",
        "data": {"gmsh_version": version},
    }


def triangle_count(element_types, element_tags):
    """Number of surface triangles (element type 2)."""
    total = 0
    for etype, tags in zip(element_types, element_tags):
        if etype == 2:
            total += len(tags)
    return total


def quad_count(element_types, element_tags):
    """Number of surface quadrilaterals (element type 3)."""
    total = 0
    for etype, tags in zip(element_types, element_tags):
        if etype == 3:
            total += len(tags)
    return total


def _process_memory_mb():
    """Real working-set size (MB) of this (Python/Gmsh) process via WinAPI."""
    try:
        import ctypes

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        process = ctypes.windll.kernel32.GetCurrentProcess()
        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(counters)
        ctypes.windll.psapi.GetProcessMemoryInfo(
            ctypes.c_void_p(process), ctypes.byref(counters), counters.cb
        )
        return round(counters.WorkingSetSize / (1024.0 * 1024.0), 1)
    except Exception:
        return None


# --- Mesh quality (documented standard definitions) -------------------------
# Skewness: normalized equilateral skewness (triangle: angle based; tet: ratio
#   of actual volume to the ideal (equilateral) volume with same circumradius).
# Aspect ratio: longest edge / shortest edge.
# Orthogonal quality: min over faces of the cosine of the angle between the
#   face normal and the vector from the cell centroid to the face centroid.
# Jacobian ratio: Gmsh "minSJ" (sampled minimal scaled Jacobian), 0..1.

QUALITY_THRESHOLDS = {
    "skewness": ("max", 0.85),
    "aspect_ratio": ("max", 20.0),
    "orthogonal_quality": ("min", 0.15),
    "jacobian_ratio": ("min", 0.3),
}


def _sub(a, b):
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b):
    return (
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    )


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _norm(a):
    return math.sqrt(_dot(a, a))


def _tri_metrics(p):
    p0, p1, p2 = p
    e = [
        _norm(_sub(p1, p2)),
        _norm(_sub(p2, p0)),
        _norm(_sub(p0, p1)),
    ]
    emax, emin = max(e), min(e)
    aspect = emax / emin if emin > 1e-12 else float("inf")

    angles = []
    for i in range(3):
        a = p[i]
        b = p[(i + 1) % 3]
        c = p[(i + 2) % 3]
        v1 = _sub(b, a)
        v2 = _sub(c, a)
        denom = _norm(v1) * _norm(v2)
        if denom > 1e-12:
            cosang = max(-1.0, min(1.0, _dot(v1, v2) / denom))
            angles.append(math.degrees(math.acos(cosang)))
    skew = 0.0
    if angles:
        for ang in angles:
            if ang > 60.0:
                skew = max(skew, (ang - 60.0) / 120.0)
            else:
                skew = max(skew, (60.0 - ang) / 60.0)

    cx = (p0[0] + p1[0] + p2[0]) / 3.0
    cy = (p0[1] + p1[1] + p2[1]) / 3.0
    cz = (p0[2] + p1[2] + p2[2]) / 3.0
    centroid = (cx, cy, cz)
    plane_n = _cross(_sub(p1, p0), _sub(p2, p0))
    ortho = 1.0
    for i in range(3):
        a = p[i]
        b = p[(i + 1) % 3]
        mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2)
        d = _sub(mid, centroid)
        edge = _sub(b, a)
        # In-plane edge normal (perpendicular to the edge, in the triangle
        # plane), oriented outward from the centroid.
        n = _cross(plane_n, edge)
        if _dot(n, d) < 0.0:
            n = (-n[0], -n[1], -n[2])
        nl = _norm(n)
        dl = _norm(d)
        if nl > 1e-12 and dl > 1e-12:
            val = _dot(n, d) / (nl * dl)
            ortho = min(ortho, max(-1.0, min(1.0, val)))
    ortho = max(0.0, ortho)

    return skew, aspect, ortho


def _tet_metrics(p):
    p0, p1, p2, p3 = p
    verts = [p0, p1, p2, p3]
    edges = []
    for i in range(4):
        for j in range(i + 1, 4):
            edges.append(_norm(_sub(verts[i], verts[j])))
    emax, emin = max(edges), min(edges)
    aspect = emax / emin if emin > 1e-12 else float("inf")

    vol = abs(_dot(_sub(p1, p0), _cross(_sub(p2, p0), _sub(p3, p0)))) / 6.0

    # Circumradius via solving for the point equidistant from all 4 vertices.
    a0, a1, a2, a3 = p0, p1, p2, p3
    # Build linear system from |x - a1|^2 = |x - a0|^2 etc.
    mat = [
        [2 * (a1[k] - a0[k]) for k in range(3)],
        [2 * (a2[k] - a0[k]) for k in range(3)],
        [2 * (a3[k] - a0[k]) for k in range(3)],
    ]
    rhs = [
        _dot(a1, a1) - _dot(a0, a0),
        _dot(a2, a2) - _dot(a0, a0),
        _dot(a3, a3) - _dot(a0, a0),
    ]
    # Solve 3x3 via Cramer's rule.
    det = (
        mat[0][0] * (mat[1][1] * mat[2][2] - mat[1][2] * mat[2][1])
        - mat[0][1] * (mat[1][0] * mat[2][2] - mat[1][2] * mat[2][0])
        + mat[0][2] * (mat[1][0] * mat[2][1] - mat[1][1] * mat[2][0])
    )
    if abs(det) > 1e-12:
        # Cramer's rule for each column
        def col(colmat):
            m0 = colmat[0]
            m1 = colmat[1]
            m2 = colmat[2]
            return (
                m0[0] * (m1[1] * m2[2] - m1[2] * m2[1])
                - m0[1] * (m1[0] * m2[2] - m1[2] * m2[0])
                + m0[2] * (m1[0] * m2[1] - m1[1] * m2[0])
            )
        d0 = [[rhs[0], mat[0][1], mat[0][2]], [rhs[1], mat[1][1], mat[1][2]], [rhs[2], mat[2][1], mat[2][2]]]
        d1 = [[mat[0][0], rhs[0], mat[0][2]], [mat[1][0], rhs[1], mat[1][2]], [mat[2][0], rhs[2], mat[2][2]]]
        d2 = [[mat[0][0], mat[0][1], rhs[0]], [mat[1][0], mat[1][1], rhs[1]], [mat[2][0], mat[2][1], rhs[2]]]
        det0 = col(d0)
        det1 = col(d1)
        det2 = col(d2)
        if abs(det) > 1e-12:
            center = (det0 / det, det1 / det, det2 / det)
            circum_r = _norm(_sub(a0, center))
        else:
            circum_r = 0.0
    else:
        circum_r = 0.0

    if circum_r > 1e-12:
        vol_ideal = (8.0 / (9.0 * math.sqrt(3.0))) * (circum_r ** 3)
        skew = 1.0 - (vol / vol_ideal) if vol_ideal > 1e-12 else 1.0
    else:
        skew = 1.0
    skew = max(0.0, min(1.0, skew))

    # Orthogonal quality: min over 4 faces of cosine(normal, centroid->face centroid)
    centroid = (
        (p0[0] + p1[0] + p2[0] + p3[0]) / 4.0,
        (p0[1] + p1[1] + p2[1] + p3[1]) / 4.0,
        (p0[2] + p1[2] + p2[2] + p3[2]) / 4.0,
    )
    faces = [(0, 1, 2), (0, 1, 3), (0, 2, 3), (1, 2, 3)]
    ortho = 1.0
    for (i, j, k) in faces:
        a, b, c = verts[i], verts[j], verts[k]
        fc = (
            (a[0] + b[0] + c[0]) / 3.0,
            (a[1] + b[1] + c[1]) / 3.0,
            (a[2] + b[2] + c[2]) / 3.0,
        )
        n = _cross(_sub(b, a), _sub(c, a))
        d = _sub(fc, centroid)
        # Orient the face normal outward from the cell centroid.
        if _dot(n, d) < 0.0:
            n = (-n[0], -n[1], -n[2])
        nl = _norm(n)
        dl = _norm(d)
        if nl > 1e-12 and dl > 1e-12:
            val = _dot(n, d) / (nl * dl)
            ortho = min(ortho, max(-1.0, min(1.0, val)))
    ortho = max(0.0, ortho)

    return skew, aspect, ortho


def compute_mesh_quality(gmsh):
    """Compute skewness / aspect ratio / orthogonal quality / scaled Jacobian
    for all triangles and tetrahedra, and summarise pass/fail counts."""
    node_tags, coords, _ = gmsh.model.mesh.getNodes()
    index = {}
    for i, t in enumerate(node_tags):
        index[t] = (coords[3 * i], coords[3 * i + 1], coords[3 * i + 2])

    etypes, etags, node_conn = gmsh.model.mesh.getElements()
    per_type = {}
    for et, tags, conn in zip(etypes, etags, node_conn):
        per_type[et] = (tags, conn)

    results = {
        "skewness": [],
        "aspect_ratio": [],
        "orthogonal_quality": [],
        "jacobian_ratio": [],
    }

    def add_element(nodes):
        pts = [index[t] for t in nodes]
        if len(pts) == 3:
            skew, aspect, ortho = _tri_metrics(pts)
        elif len(pts) == 4:
            skew, aspect, ortho = _tet_metrics(pts)
        else:
            # Hexahedra (8) / prisms (6): aspect ratio (max/min edge) is a
            # standard element-agnostic definition. Skewness / orthogonal
            # quality use the triangle/tetrahedron definitions and are not
            # computed for these element types here.
            emin = emax = None
            for i in range(len(pts)):
                for j in range(i + 1, len(pts)):
                    d = _norm(_sub(pts[i], pts[j]))
                    emin = d if emin is None or d < emin else emin
                    emax = d if emax is None or d > emax else emax
            if emin and emin > 1e-12:
                results["aspect_ratio"].append(emax / emin)
            return
        results["skewness"].append(skew)
        results["aspect_ratio"].append(aspect)
        results["orthogonal_quality"].append(ortho)

    NODE_COUNT = {2: 3, 4: 4, 5: 8, 6: 6}  # triangle, tet, hex, prism
    for et in (2, 4, 5, 6):
        if et not in per_type:
            continue
        tags, conn = per_type[et]
        nnode = NODE_COUNT[et]
        for offset in range(0, len(conn), nnode):
            add_element(conn[offset:offset + nnode])

    # Jacobian via Gmsh's documented "minSJ" (scaled Jacobian), all types.
    jac_tags = []
    for et in (2, 4, 5, 6):
        if et in per_type:
            jac_tags.extend(per_type[et][0])
    if jac_tags:
        jac = gmsh.model.mesh.getElementQualities(jac_tags, "minSJ")
        results["jacobian_ratio"] = list(jac)

    summary = {}
    for name, values in results.items():
        if not values:
            continue
        mode, threshold = QUALITY_THRESHOLDS[name]
        if mode == "max":
            fails = [v for v in values if v > threshold]
        else:
            fails = [v for v in values if v < threshold]
        finite = [v for v in values if v == v and v != float("inf")]  # drop NaN/inf
        summary[name] = {
            "min": round(min(finite), 4) if finite else None,
            "max": round(max(finite), 4) if finite else None,
            "mean": round(sum(finite) / len(finite), 4) if finite else None,
            "count": len(values),
            "failed": len(fails),
            "threshold": threshold,
            "mode": mode,
        }
    return summary


def _apply_size_fields(gmsh, base, edge_sizes, face_sizes, regions, growth_rate=1.2, transition_factor=1.0):
    """Build the background mesh size field from local Box regions plus
    per-edge and per-face Distance+Threshold size fields. Returns nothing;
    sets the background field if any were requested. `growth_rate` controls
    how quickly the size transitions back to the coarse base (Threshold
    DistMax), i.e. the size-field gradation. `transition_factor` scales the
    transition distance (ANSYS Transition Fast/Slow)."""
    field_tags = []
    transition = max(base * growth_rate * 2.0, base * 3.0) * transition_factor

    # Defensive: ignore size entries whose tag doesn't exist in the current
    # model (stale tags from a previously loaded geometry would otherwise
    # raise "Unknown model face/curve with tag N").
    valid_edges = set(t for (d, t) in gmsh.model.getEntities(1))
    valid_faces = set(t for (d, t) in gmsh.model.getEntities(2))

    for region in regions:
        f = gmsh.model.mesh.field.add("Box")
        gmsh.model.mesh.field.setNumber(f, "XMin", float(region["xmin"]))
        gmsh.model.mesh.field.setNumber(f, "XMax", float(region["xmax"]))
        gmsh.model.mesh.field.setNumber(f, "YMin", float(region["ymin"]))
        gmsh.model.mesh.field.setNumber(f, "YMax", float(region["ymax"]))
        gmsh.model.mesh.field.setNumber(f, "ZMin", float(region["zmin"]))
        gmsh.model.mesh.field.setNumber(f, "ZMax", float(region["zmax"]))
        gmsh.model.mesh.field.setNumber(f, "VIn", float(region["size"]))
        gmsh.model.mesh.field.setNumber(f, "VOut", base)
        field_tags.append(f)

    # Edge sizing: refine near a curve to the requested size.
    for es in edge_sizes:
        tag = int(es["tag"])
        if tag not in valid_edges:
            log("skipping edge size: unknown curve tag {}".format(tag))
            continue
        size = float(es["size"])
        d = gmsh.model.mesh.field.add("Distance")
        gmsh.model.mesh.field.setNumbers(d, "CurvesList", [tag])
        gmsh.model.mesh.field.setNumber(d, "Sampling", 100)
        t = gmsh.model.mesh.field.add("Threshold")
        gmsh.model.mesh.field.setNumber(t, "InField", d)
        gmsh.model.mesh.field.setNumber(t, "SizeMin", size)
        gmsh.model.mesh.field.setNumber(t, "SizeMax", base)
        gmsh.model.mesh.field.setNumber(t, "DistMin", 0.0)
        gmsh.model.mesh.field.setNumber(t, "DistMax", transition)
        field_tags.append(t)

    # Face sizing: refine near a face by using its boundary curves.
    for fs in face_sizes:
        tag = int(fs["tag"])
        if tag not in valid_faces:
            log("skipping face size: unknown surface tag {}".format(tag))
            continue
        size = float(fs["size"])
        boundary = gmsh.model.getBoundary([(2, tag)], recursive=False)
        curve_tags = [t for (d, t) in boundary if d == 1]
        if not curve_tags:
            continue
        d = gmsh.model.mesh.field.add("Distance")
        gmsh.model.mesh.field.setNumbers(d, "CurvesList", curve_tags)
        gmsh.model.mesh.field.setNumber(d, "Sampling", 100)
        t = gmsh.model.mesh.field.add("Threshold")
        gmsh.model.mesh.field.setNumber(t, "InField", d)
        gmsh.model.mesh.field.setNumber(t, "SizeMin", size)
        gmsh.model.mesh.field.setNumber(t, "SizeMax", base)
        gmsh.model.mesh.field.setNumber(t, "DistMin", 0.0)
        gmsh.model.mesh.field.setNumber(t, "DistMax", transition)
        field_tags.append(t)

    if not field_tags:
        return
    if len(field_tags) == 1:
        gmsh.model.mesh.field.setAsBackgroundMesh(field_tags[0])
    else:
        combined = gmsh.model.mesh.field.add("Min")
        gmsh.model.mesh.field.setNumbers(combined, "FieldsList", field_tags)
        gmsh.model.mesh.field.setAsBackgroundMesh(combined)


def _progress(progress_file, percent, stage):
    """Write a JSON progress update to a file so the Rust server can expose it
    to the browser while the job runs. Best-effort; never fails the job."""
    if not progress_file:
        return
    try:
        with open(progress_file, "w") as f:
            json.dump({"percent": percent, "stage": stage}, f)
    except Exception:
        pass


def _min_input_edge(gmsh):
    """Smallest edge in the input (imported) surface mesh — a proxy for the
    smallest geometric feature, used for the element-size mismatch warning."""
    try:
        ntags, coords, _ = gmsh.model.mesh.getNodes()
        ets, etags, econn = gmsh.model.mesh.getElements()
    except Exception:
        return None
    idx = {t: (coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]) for i, t in enumerate(ntags)}
    mn = None
    for et, conn in zip(ets, econn):
        if et == 2:
            for off in range(0, len(conn), 3):
                p = [idx.get(conn[off]), idx.get(conn[off + 1]), idx.get(conn[off + 2])]
                if None in p:
                    continue
                for i in range(3):
                    d = math.dist(p[i], p[(i + 1) % 3])
                    if mn is None or d < mn:
                        mn = d
    return mn


def _minimum_edge_length(node_index, element_types, element_conn):
    """Smallest edge in the mesh (for the read-only Minimum Edge Length stat)."""
    min_len = None
    for et, conn in zip(element_types, element_conn):
        if et == 2:
            nnode = 3
        elif et == 4:
            nnode = 4
        else:
            continue
        for off in range(0, len(conn), nnode):
            pts = [node_index[t] for t in conn[off:off + nnode]]
            for i in range(len(pts)):
                for j in range(i + 1, len(pts)):
                    d = _norm(_sub(pts[i], pts[j]))
                    if min_len is None or d < min_len:
                        min_len = d
    return round(min_len, 6) if min_len is not None else None


def _inflation_layers(bl, faces, base):
    """Resolve the ANSYS inflation settings into Gmsh's extrudeBoundaryLayer
    parameters. Returns (num_layers, heights, wall_faces)."""
    auto = bl.get("auto") or "none"
    option = bl.get("option") or "smooth_transition"
    layers = int(bl.get("layers") or 5)
    first = float(bl.get("first") or base * 0.05)
    growth = float(bl.get("growth") or 1.2)
    max_layers = int(bl.get("max_layers") or 0)
    total = float(bl.get("total") or 0.0)
    wall_faces = [int(t) for t in bl.get("faces") or []]

    if max_layers > 0:
        layers = min(layers, max_layers)
    if auto == "none":
        return 0, [], []
    if auto in ("program_controlled", "all_faces") and not wall_faces:
        wall_faces = list(faces)
    if not wall_faces or layers <= 0:
        return 0, [], []

    if option == "total_thickness" and total > 0.0 and layers > 1:
        # Solve growth r so that first*(r^layers - 1)/(r - 1) = total.
        lo, hi = 1.0001, 20.0
        for _ in range(60):
            mid = (lo + hi) / 2.0
            s = first * (mid ** layers - 1) / (mid - 1) if abs(mid - 1.0) > 1e-9 else first * layers
            if s < total:
                lo = mid
            else:
                hi = mid
        growth = (lo + hi) / 2.0

    heights = [first * (growth ** i) for i in range(layers)]
    return layers, heights, wall_faces


def _try_hex_mesh(gmsh, faces, vol_tag, progress_file):
    """Best-effort hexahedral meshing. Tries, in order: Gmsh HXT (Algorithm3D=5),
    then quad-recombine + transfinite (structured) meshing, then falls back to
    tetrahedral. Returns (method_used, element_types, element_tags)."""
    def _hex_count():
        ets, tags, _ = gmsh.model.mesh.getElements()
        return ets, tags, sum(len(t) for et, t in zip(ets, tags) if et == 5)

    # Attempt 1: HXT hex-dominant on the triangle surface mesh.
    gmsh.option.setNumber("Mesh.Algorithm3D", 5)
    gmsh.model.mesh.generate(3)
    ets, tags, hexes = _hex_count()
    if hexes > 0:
        _progress(progress_file, 75, "Generating volume mesh (HXT hex)")
        return "hex", ets, tags

    log("HXT produced no hexahedra; trying quad-recombine + transfinite")
    # Attempt 2: quad-dominant surface + transfinite (structured) meshing.
    try:
        gmsh.option.setNumber("Mesh.RecombineAll", 1)
        for (d, t) in gmsh.model.getEntities(2):
            gmsh.model.mesh.setTransfinite(t, 8)
        gmsh.model.mesh.setTransfinite(vol_tag, 8)
        gmsh.model.mesh.generate(2)
        gmsh.option.setNumber("Mesh.Algorithm3D", 5)
        gmsh.model.mesh.generate(3)
        ets, tags, hexes = _hex_count()
        if hexes > 0:
            _progress(progress_file, 75, "Generating volume mesh (transfinite/recombine)")
            return "hex", ets, tags
    except Exception as exc:
        log("transfinite/recombine failed: {}".format(exc))

    # Fallback: tetrahedral (Delaunay) on a fresh triangle surface.
    log("Hex-dominant (HXT + transfinite/recombine) produced no hexahedra; falling back to tetrahedral")
    gmsh.option.setNumber("Mesh.RecombineAll", 0)
    gmsh.model.mesh.generate(2)
    gmsh.option.setNumber("Mesh.Algorithm3D", 1)
    gmsh.model.mesh.generate(3)
    ets, tags, _ = gmsh.model.mesh.getElements()
    _progress(progress_file, 75, "Generating volume mesh (tet fallback)")
    return "tet_fallback", ets, tags


def _sweep_mesh(gmsh, faces, source, target, layers, progress_file):
    """Manual sweep meshing: mesh the user-selected source face(s) and extrude
    them to the target face using Gmsh's Extrude + Layers mechanism. Produces
    hexahedra (quad-recombined source) or triangular prisms. Raises a clear
    error if the source/target are not sweepable (e.g. mismatched boundary
    edge counts). This is manual source/target sweep only — no automatic
    geometry decomposition / zone detection."""
    layers = int(layers or 5)
    if isinstance(source, int):
        source = [source]
    if not source:
        raise ValueError("Sweep requires a source face (select a face, mark it as source).")
    source = [int(t) for t in source]
    for t in source:
        if t not in faces:
            raise ValueError("Sweep source face {} does not exist in the model.".format(t))

    def face_centroid(t):
        bb = gmsh.model.getBoundingBox(2, t)
        return ((bb[0] + bb[3]) / 2.0, (bb[1] + bb[4]) / 2.0, (bb[2] + bb[5]) / 2.0)

    sc = [face_centroid(t) for t in source]
    scx = sum(c[0] for c in sc) / len(sc)
    scy = sum(c[1] for c in sc) / len(sc)
    scz = sum(c[2] for c in sc) / len(sc)

    if target is None:
        best, bestd = None, -1.0
        for t in faces:
            if t in source:
                continue
            c = face_centroid(t)
            d = (c[0] - scx) ** 2 + (c[1] - scy) ** 2 + (c[2] - scz) ** 2
            if d > bestd:
                bestd, best = d, t
        target = best
    target = int(target)
    tc = face_centroid(target)

    # Sweepability check: source and target must be parallel/opposite (same
    # normal axis), otherwise the extrusion direction is ill-defined.
    def normal_axis(t):
        bb = gmsh.model.getBoundingBox(2, t)
        exts = {"x": bb[3] - bb[0], "y": bb[4] - bb[1], "z": bb[5] - bb[2]}
        return min(exts, key=exts.get)

    src_axes = {normal_axis(t) for t in source}
    tgt_axis = normal_axis(target)
    if len(src_axes) != 1 or tgt_axis not in src_axes:
        raise ValueError(
            "Sweep not possible: source and target faces are not parallel/opposite "
            "(source normal axis {}, target normal axis {}). Choose two opposite "
            "faces with the same orientation.".format(sorted(src_axes), tgt_axis)
        )

    vx, vy, vz = tc[0] - scx, tc[1] - scy, tc[2] - scz
    if abs(vx) + abs(vy) + abs(vz) < 1e-12:
        raise ValueError("Sweep not possible: source and target faces coincide.")

    # Quad-recombine the source so the extrude yields hexahedra.
    gmsh.option.setNumber("Mesh.RecombineAll", 1)
    gmsh.model.mesh.generate(2)
    _progress(progress_file, 60, "Sweeping source face to target")
    gmsh.model.geo.extrude(
        [(2, t) for t in source], vx, vy, vz, numElements=[layers], recombine=True
    )
    gmsh.model.geo.synchronize()
    gmsh.option.setNumber("Mesh.Algorithm3D", 1)
    gmsh.model.mesh.generate(3)
    ets, tags, _ = gmsh.model.mesh.getElements()
    hexes = sum(len(t) for et, t in zip(ets, tags) if et == 5)
    prisms = sum(len(t) for et, t in zip(ets, tags) if et == 6)
    if hexes + prisms == 0:
        raise ValueError(
            "Sweep produced no hexahedra or prisms; the source and target faces "
            "are not sweepable with this geometry."
        )
    log("sweep: {} hexes, {} prisms (source {}, target {})".format(hexes, prisms, source, target))
    _progress(progress_file, 75, "Sweep volume mesh generated")
    return "sweep", ets, tags


def _apply_physical_groups(gmsh, named_selections):
    """Create Gmsh Physical Groups from the user's named selections so the
    names are written into the exported .msh $PhysicalNames section. Grouped
    by (dimension, name); each group gets a unique physical tag per dimension."""
    if not named_selections:
        return
    dim_for = {"face": 2, "wall": 2, "edge": 1, "vertex": 0}
    groups = {}
    for ns in named_selections:
        name = (ns.get("name") or "").strip()
        typ = ns.get("type") or "face"
        tag = ns.get("tag")
        if not name or tag is None:
            continue
        dim = dim_for.get(typ)
        if dim is None:
            continue
        groups.setdefault((dim, name), set()).add(int(tag))
    next_id = {0: 1, 1: 1, 2: 1}
    for (dim, name), tags in groups.items():
        pid = next_id[dim]
        next_id[dim] += 1
        try:
            gmsh.model.addPhysicalGroup(dim, sorted(tags), pid)
            gmsh.model.setPhysicalName(dim, pid, name)
            log("physical group: dim {} tag {} name '{}' entities {}".format(dim, pid, name, sorted(tags)))
        except Exception as exc:
            log("physical group '{}' failed: {}".format(name, exc))


def _axisymmetry_spread(pts, ai):
    """Return (max angular radius spread, max radius) for points about axis
    index `ai` (0=x,1=y,2=z). A near-zero spread means genuine rotational
    symmetry about that axis."""
    perp = [i for i in (0, 1, 2) if i != ai]
    n = len(pts)
    if n == 0:
        return None, 0.0
    c0 = sum(p[perp[0]] for p in pts) / n
    c1 = sum(p[perp[1]] for p in pts) / n
    amin = min(p[ai] for p in pts)
    amax = max(p[ai] for p in pts)
    rmax = max(math.hypot(p[perp[0]] - c0, p[perp[1]] - c1) for p in pts)
    if amax <= amin:
        return None, rmax
    nst = 80
    stations = {}
    for p in pts:
        s = int((p[ai] - amin) / (amax - amin) * nst)
        stations.setdefault(s, []).append(
            (math.hypot(p[perp[0]] - c0, p[perp[1]] - c1),
             math.atan2(p[perp[1]] - c1, p[perp[0]] - c0)))
    spreads = []
    for vals in stations.values():
        if len(vals) < 4:
            continue
        byang = {}
        for r, ang in vals:
            k = int((math.degrees(ang) + 180) // 15)
            byang[k] = max(byang.get(k, 0.0), r)
        if len(byang) >= 6:
            spreads.append(max(byang.values()) - min(byang.values()))
    return (max(spreads) if spreads else None), rmax


def _revolve_mesh(gmsh, input_path, axis, layers, base, progress_file):
    """Axisymmetric profile-revolve meshing. Extracts the radial profile of a
    solid of revolution from the imported STL, quad-meshes that 2D profile,
    and revolves it around the chosen axis to produce a structured hex mesh.
    Gmsh's built-in geometry kernel only supports rotations < pi, so a full
    turn is done as 3 x 120 deg revolutions (per the Gmsh reference manual).
    Refuses with a clear error if the geometry is not genuinely axisymmetric."""
    AXES = {"x": 0, "y": 1, "z": 2}
    if axis not in ("auto", "x", "y", "z"):
        raise ValueError("Revolve axis must be 'auto', 'x', 'y' or 'z' (got {!r}).".format(axis))

    gmsh.clear()
    gmsh.merge(input_path)
    ntags, coords, _ = gmsh.model.mesh.getNodes()
    pts = [(coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]) for i in range(len(ntags))]
    gmsh.clear()
    if not pts:
        raise ValueError("Revolve: no geometry points found.")

    # Auto-detect the axis of symmetry: test X, Y and Z and pick whichever
    # genuinely passes the axisymmetry check (smallest angular radius spread).
    if axis == "auto":
        best, best_spread = None, None
        for cand in ("x", "y", "z"):
            sp, rmax = _axisymmetry_spread(pts, AXES[cand])
            if sp is not None and sp <= 0.02 * rmax and (best_spread is None or sp < best_spread):
                best, best_spread = cand, sp
        if best is None:
            raise ValueError(
                "Revolve refused: geometry is not axisymmetric about X, Y or Z "
                "(no axis passed the check). Pick the axis manually if you know it.")
        axis = best
        log("revolve: auto-detected axis '{}'".format(best))

    ai = AXES[axis]
    perp = [i for i in (0, 1, 2) if i != ai]

    c0 = sum(p[perp[0]] for p in pts) / len(pts)
    c1 = sum(p[perp[1]] for p in pts) / len(pts)
    amin = min(p[ai] for p in pts)
    amax = max(p[ai] for p in pts)

    def radius(p):
        return math.hypot(p[perp[0]] - c0, p[perp[1]] - c1)

    # radius profile + axisymmetry check (radius must not depend on angle)
    nst = 80
    stations = {}
    for p in pts:
        s = int((p[ai] - amin) / (amax - amin) * nst) if amax > amin else 0
        stations.setdefault(s, []).append((radius(p), math.atan2(p[perp[1]] - c1, p[perp[0]] - c0)))
    prof = {}
    spreads = []
    for s, vals in stations.items():
        if len(vals) < 4:
            continue
        prof[amin + (amax - amin) * (s + 0.5) / nst] = max(v[0] for v in vals)
        byang = {}
        for r, ang in vals:
            k = int((math.degrees(ang) + 180) // 15)
            byang[k] = max(byang.get(k, 0.0), r)
        if len(byang) >= 6:
            spreads.append(max(byang.values()) - min(byang.values()))
    r_max = max(radius(p) for p in pts)
    if spreads and max(spreads) > 0.02 * r_max:
        raise ValueError(
            "Revolve refused: geometry is not axisymmetric about the '{}' axis "
            "(max angular radius spread {:.4g} mm vs max radius {:.4g} mm).".format(
                axis, max(spreads), r_max))
    if len(prof) < 3:
        raise ValueError("Revolve: could not extract a radius profile along '{}'.".format(axis))
    _progress(progress_file, 30, "Extracting axisymmetric profile")

    xs = sorted(prof.keys())
    # resample to a bounded number of profile stations
    nprof = min(60, len(xs))
    xs_s = [xs[0] + (xs[-1] - xs[0]) * i / (nprof - 1) for i in range(nprof)]
    rs_s = [prof[min(xs, key=lambda q: abs(q - x))] for x in xs_s]

    def mkpt(t, r):
        v = [0.0, 0.0, 0.0]
        v[ai] = t
        v[perp[0]] = c0 + r
        v[perp[1]] = c1
        return gmsh.model.geo.addPoint(v[0], v[1], v[2])

    p_start = mkpt(xs_s[0], 0.0)
    p_end = mkpt(xs_s[-1], 0.0)
    sp = [mkpt(xs_s[i], rs_s[i]) for i in range(nprof)]
    axis_line = gmsh.model.geo.addLine(p_start, p_end)
    cap1 = gmsh.model.geo.addLine(p_end, sp[-1])
    cap0 = gmsh.model.geo.addLine(sp[0], p_start)
    spline = gmsh.model.geo.addSpline(list(reversed(sp)))
    loop = gmsh.model.geo.addCurveLoop([axis_line, cap1, spline, cap0])
    surf = gmsh.model.geo.addPlaneSurface([loop])
    gmsh.model.geo.synchronize()

    gmsh.option.setNumber("Mesh.MeshSizeMax", base)
    gmsh.option.setNumber("Mesh.MeshSizeMin", max(base * 0.05, 1e-6))
    gmsh.option.setNumber("Mesh.RecombineAll", 1)  # quads -> hexes on revolve
    gmsh.model.mesh.generate(2)
    _progress(progress_file, 50, "Meshing 2D profile")

    ap = [0.0, 0.0, 0.0]
    ap[perp[0]] = c0
    ap[perp[1]] = c1
    adir = [0.0, 0.0, 0.0]
    adir[ai] = 1.0
    ang_layers = max(3, int(layers or 8))
    step = max(3, ang_layers // 3)
    try:
        e = surf
        for _ in range(3):
            out = gmsh.model.geo.revolve(
                [(2, e)], ap[0], ap[1], ap[2], adir[0], adir[1], adir[2],
                2.0 * math.pi / 3.0, numElements=[step], recombine=True)
            e = out[0][1]  # first returned entity is the end surface
            gmsh.model.geo.synchronize()
    except Exception as exc:
        raise ValueError("Revolve failed: {}".format(exc))
    _progress(progress_file, 75, "Revolving profile")
    gmsh.option.setNumber("Mesh.Algorithm3D", 1)
    gmsh.model.mesh.generate(3)

    element_types, element_tags, element_conn = gmsh.model.mesh.getElements()
    node_tags, coords2, _ = gmsh.model.mesh.getNodes()
    hexes = sum(len(t) for et, t in zip(element_types, element_tags) if et == 5)
    prisms = sum(len(t) for et, t in zip(element_types, element_tags) if et == 6)
    tets = sum(len(t) for et, t in zip(element_types, element_tags) if et == 4)
    if hexes + prisms == 0:
        raise ValueError("Revolve produced no hexahedra or prisms.")
    bbox = gmsh.model.getBoundingBox(-1, -1)
    return {
        "gmsh_version": _GMSH_VERSION,
        "nodes": len(node_tags),
        "elements_2d": 0,
        "triangles": 0,
        "bbox": list(bbox),
        "volume": True,
        "faces": [],
        "edges": [],
        "volume_nodes": len(node_tags),
        "volume_tets": tets,
        "volume_hexes": hexes,
        "volume_prisms": prisms,
        "mesh_method_used": "revolve",
        "revolve_axis": axis,
        "revolve_profile_stations": nprof,
        "minimum_edge_length": _minimum_edge_length(
            {t: (coords2[3 * i], coords2[3 * i + 1], coords2[3 * i + 2]) for i, t in enumerate(node_tags)},
            element_types, element_conn),
    }


def handle_surface_mesh(data):
    gmsh, version = ensure_gmsh()
    input_path = data.get("input")
    msh_path = data.get("msh")
    stl_path = data.get("stl")
    base = float(data.get("size_seed") or 0.0) or float(data.get("size") or 0.1)
    size_min = float(data.get("size_min") or 0.0)
    size_max = float(data.get("size_max") or 0.0)
    growth_rate = float(data.get("growth_rate") or 1.2)
    adv = data.get("advanced_size_function") or "off"
    curvature = int(data.get("curvature") or 0)
    proximity = int(data.get("proximity") or 0)
    smoothing = data.get("smoothing") or "none"
    transition = data.get("transition") or "fast"
    surface_algorithm = data.get("surface_algorithm") or "program_controlled"
    recombine = str(data.get("recombine") or "false").lower() in ("true", "1")
    volume = bool(data.get("volume"))
    mesh_method = data.get("mesh_method") or "tet"
    sweep_source = data.get("sweep_source")
    sweep_target = data.get("sweep_target")
    sweep_layers = data.get("sweep_layers")
    named_selections = data.get("named_selections") or []
    progress_file = data.get("progress_file")
    export_path = data.get("export_path")
    regions = data.get("regions") or []
    edge_sizes = data.get("edge_sizes") or []
    face_sizes = data.get("face_sizes") or []
    boundary_layer = data.get("boundary_layer") or None
    if not all((input_path, msh_path, stl_path)):
        raise ValueError("surface_mesh requires input, msh and stl paths")

    # Axisymmetric profile-revolve method: builds its own profile geometry
    # (does not use the classified STL surfaces), so handle it separately.
    if mesh_method == "revolve":
        out = _revolve_mesh(
            gmsh, input_path, data.get("revolve_axis") or "x",
            data.get("revolve_layers") or 8, base, progress_file)
        gmsh.write(stl_path)
        gmsh.write(msh_path)
        out["output_msh"] = msh_path
        out["output_stl"] = stl_path
        if export_path:
            try:
                gmsh.write(export_path)
                out["output_export"] = export_path
            except Exception as exc:
                log("export write failed: {}".format(exc))
        out["quality"] = compute_mesh_quality(gmsh)
        out["memory_mb"] = _process_memory_mb()
        _write_entity_snapshot(gmsh, os.path.join(os.path.dirname(msh_path), "entities.json"))
        _progress(progress_file, 100, "Done")
        return {"status": "ok", "message": "revolved hex mesh generated", "data": out}

    gmsh.clear()

    # Import the triangulated STL as a discrete surface-mesh model, then
    # heal it: drop duplicate nodes and classify into discrete surfaces /
    # curves so it can be re-parametrised and re-meshed at a new size.
    gmsh.merge(input_path)
    feature_min = _min_input_edge(gmsh)
    gmsh.model.mesh.removeDuplicateNodes()
    # Classify the STL faces into real surfaces using a 40 deg dihedral
    # threshold (separates sharp features from tessellation noise).
    #
    # Prefer the NON-reparametrised classification: it keeps a coplanar patch
    # (e.g. the flat circular cap of a cylinder) as ONE face instead of
    # splitting it into halves, so a picked cap highlights the whole cap and
    # reports its true area. Some closed/curved shapes (e.g. a sphere) cannot
    # be re-meshed that way and raise "Invalid exterior boundary mesh for
    # parametrization", so fall back to reparametrised classification.
    angle = 40.0 * math.pi / 180.0
    try:
        gmsh.model.mesh.classifySurfaces(angle, boundary=True, forReparametrization=False)
        gmsh.model.mesh.createGeometry()
    except Exception as exc:
        log("non-reparametrised classification failed ({}); retrying with reparametrization".format(exc))
        gmsh.clear()
        gmsh.merge(input_path)
        gmsh.model.mesh.removeDuplicateNodes()
        gmsh.model.mesh.classifySurfaces(angle, boundary=True, forReparametrization=True)
        gmsh.model.mesh.createGeometry()
    gmsh.model.geo.synchronize()

    # Entity inventory (reported back so the UI can offer per-face/edge sizing).
    faces = [t for (d, t) in gmsh.model.getEntities(2)]
    edges = [t for (d, t) in gmsh.model.getEntities(1)]

    # Sanity check: a requested element size larger than the model's own largest
    # dimension cannot produce a usable mesh and typically means the unit system
    # does not match the file (e.g. 1.6 "m" typed for a 150 mm part). Reject it
    # up front with a clear message instead of running a pathological mesher.
    bb = gmsh.model.getBoundingBox(-1, -1)
    max_dim = max(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2])
    if max_dim > 0 and base > max_dim:
        return {
            "status": "error",
            "message": (
                "Element size {:.4g} is larger than the model's largest dimension "
                "({:.4g}) — the requested size is probably in the wrong unit "
                "(check the Unit System setting). Reduce the element size.".format(base, max_dim)
            ),
            "data": {
                "bbox": list(bb),
                "max_dimension": round(max_dim, 6),
                "requested_size": base,
                "size_too_large": True,
            },
        }

    _progress(progress_file, 15, "Importing & healing geometry")

    # Advanced Size Function: curvature OR proximity refinement, or off.
    if adv == "curvature":
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", curvature)
        gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
        refinement_active = bool(curvature or regions or edge_sizes or face_sizes)
    elif adv == "proximity":
        gmsh.option.setNumber("Mesh.MeshSizeFromPoints", proximity)
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
        refinement_active = bool(proximity or regions or edge_sizes or face_sizes)
    else:
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
        gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
        refinement_active = bool(regions or edge_sizes or face_sizes)

    # Global size bounds. Explicit Min/Max override the automatic ones;
    # otherwise `base` is the coarsest target and refinement allows finer sizes.
    if size_max > 0.0:
        gmsh.option.setNumber("Mesh.MeshSizeMax", size_max)
    else:
        gmsh.option.setNumber("Mesh.MeshSizeMax", base)
    if size_min > 0.0:
        gmsh.option.setNumber("Mesh.MeshSizeMin", size_min)
    elif refinement_active:
        gmsh.option.setNumber("Mesh.MeshSizeMin", max(base * 0.05, 1e-6))
    else:
        gmsh.option.setNumber("Mesh.MeshSizeMin", base)

    # Smoothing: Gmsh in-mesher smoothing passes (Mesh.Smoothing iterations).
    smoothing_iter = {"none": 0, "low": 1, "medium": 3, "high": 5}.get(smoothing, 0)
    gmsh.option.setNumber("Mesh.Smoothing", smoothing_iter)

    # Transition (size-field gradation Fast/Slow): scale the transition distance.
    transition_factor = 0.6 if transition == "fast" else 1.6

    # Local regions + per-edge/per-face sizing, combined into one background
    # mesh size field.
    _apply_size_fields(gmsh, base, edge_sizes, face_sizes, regions, growth_rate, transition_factor)

    # Triangle surface mesher (Patch Conforming): Mesh.Algorithm.
    algo_map = {"program_controlled": 2, "delaunay": 5, "frontal_delaunay": 6, "meshadapt": 1}
    gmsh.option.setNumber("Mesh.Algorithm", algo_map.get(surface_algorithm, 2))

    # Surface element shape: triangular (default) or quadrilateral (recombine).
    # This is a SURFACE-only setting and is applied regardless of what the
    # volume mesher later does. Blossom recombination gives the best quads.
    if recombine:
        gmsh.option.setNumber("Mesh.RecombineAll", 1)
        gmsh.option.setNumber("Mesh.RecombinationAlgorithm", 1)  # 1 = blossom
        gmsh.option.setNumber("Mesh.RecombineOptimizeTopology", 1)
    else:
        gmsh.option.setNumber("Mesh.RecombineAll", 0)

    gmsh.model.mesh.generate(2)
    _progress(progress_file, 45, "Generating surface mesh")

    # Snapshot the per-face/per-edge mesh geometry NOW (right after the surface
    # mesh) so interactive picks can be answered by the Rust layer even while
    # this worker is busy, and so every job gets a snapshot regardless of what
    # happens during volume meshing / export.
    _write_entity_snapshot(gmsh, os.path.join(os.path.dirname(msh_path), "entities.json"))

    # Surface stats + lightweight surface STL for the browser preview.
    node_tags, coords, _ = gmsh.model.mesh.getNodes()
    element_types, element_tags, element_conn = gmsh.model.mesh.getElements()
    elements_2d = sum(len(tags) for tags in element_tags)
    triangles = triangle_count(element_types, element_tags)
    quads = quad_count(element_types, element_tags)
    bbox = gmsh.model.getBoundingBox(-1, -1)
    gmsh.write(stl_path)
    # Quad wireframe for the preview (an STL can only carry triangles, so the
    # browser would otherwise always show a triangulated surface).
    if quads:
        _write_quad_wireframe(gmsh, os.path.join(os.path.dirname(msh_path), "quads.json"))

    node_index = {}
    for i, t in enumerate(node_tags):
        node_index[t] = (coords[3 * i], coords[3 * i + 1], coords[3 * i + 2])

    want_volume = volume or bool(boundary_layer)
    data = {
        "gmsh_version": version,
        "nodes": len(node_tags),
        "elements_2d": elements_2d,
        "triangles": triangles,
        "quads": quads,
        "surface_type": "quad" if quads else "tri",
        "bbox": list(bbox),
        "output_stl": stl_path,
        "volume": want_volume,
        "faces": faces,
        "edges": edges,
        "minimum_edge_length": _minimum_edge_length(node_index, element_types, element_conn),
    }

    if want_volume:
        if mesh_method == "sweep":
            # Manual sweep: mesh the source face and extrude it to the target.
            mesh_method_used, element_types, element_tags = _sweep_mesh(
                gmsh, faces, sweep_source, sweep_target, sweep_layers, progress_file
            )
        else:
            # Build a closed volume from the surface loop.
            loop = gmsh.model.geo.addSurfaceLoop(faces)
            vol_tag = gmsh.model.geo.addVolume([loop])
            gmsh.model.geo.synchronize()

            if boundary_layer:
                # 3D inflation: extrude the wall faces inward as a prism boundary
                # layer, then mesh the remaining core with tets.
                layers, heights, wall_faces = _inflation_layers(boundary_layer, faces, base)
                if wall_faces:
                    num_elements = [1] * layers
                    gmsh.model.geo.extrudeBoundaryLayer(
                        [(2, t) for t in wall_faces],
                        numElements=num_elements,
                        heights=heights,
                        recombine=True,
                    )
                    gmsh.model.geo.synchronize()

            # Mesh method: tetrahedral (Delaunay) or hex-dominant.
            hex_dominant = mesh_method == "hex"
            if hex_dominant:
                mesh_method_used, element_types, element_tags = _try_hex_mesh(
                    gmsh, faces, vol_tag, progress_file
                )
            else:
                gmsh.option.setNumber("Mesh.Algorithm3D", 1)  # Delaunay tets
                gmsh.model.mesh.generate(3)
                _progress(progress_file, 75, "Generating volume mesh")
                element_types, element_tags, _ = gmsh.model.mesh.getElements()
                mesh_method_used = "tet"

        node_tags, _, _ = gmsh.model.mesh.getNodes()
        tets = sum(len(t) for et, t in zip(element_types, element_tags) if et == 4)
        hexes = sum(len(t) for et, t in zip(element_types, element_tags) if et == 5)
        prisms = sum(len(t) for et, t in zip(element_types, element_tags) if et == 6)
        _apply_physical_groups(gmsh, named_selections)
        gmsh.write(msh_path)
        data["volume_nodes"] = len(node_tags)
        data["volume_tets"] = tets
        data["volume_hexes"] = hexes
        data["volume_prisms"] = prisms
        data["mesh_method_used"] = mesh_method_used
        data["output_msh"] = msh_path
        log(
            "volume mesh ({method}): {n} nodes, {t} tets, {h} hexes, {p} prisms".format(
                method=mesh_method_used, n=len(node_tags), t=tets, h=hexes, p=prisms
            )
        )
    else:
        _apply_physical_groups(gmsh, named_selections)
        gmsh.write(msh_path)
        data["output_msh"] = msh_path
        log(
            "surface mesh: {} nodes, {} 2D elements ({} quads / {} triangles), bbox {}".format(
                len(node_tags), elements_2d, quads, triangles, ["%.4g" % v for v in bbox]
            )
        )

    data["quality"] = compute_mesh_quality(gmsh)
    data["memory_mb"] = _process_memory_mb()
    # Element-size mismatch warning: flag when the requested size is larger
    # than the smallest detected feature (would distort/degenerate the mesh).
    if feature_min is not None:
        data["smallest_feature"] = round(feature_min, 6)
        if base > feature_min * 1.5:
            data["size_warning"] = (
                "Element size {:.4g} is larger than the smallest detected feature "
                "({:.4g}) — the mesh may be distorted or miss small features. "
                "Reduce the global element size.".format(base, feature_min)
            )
    _progress(progress_file, 95, "Computing mesh quality")

    # Write the chosen universal export format (e.g. Nastran .bdf for ANSYS).
    if export_path:
        try:
            gmsh.write(export_path)
            data["output_export"] = export_path
        except Exception as exc:
            log("export write failed: {}".format(exc))

    _progress(progress_file, 100, "Done")

    return {
        "status": "ok",
        "message": "volume mesh generated" if want_volume else "surface mesh generated",
        "data": data,
    }


def _nearest_entity(gmsh, dim, x, y, z):
    """Nearest (tag, distance) of the dimension-`dim' entities to a point,
    using the entity's mesh nodes (discrete surfaces have no parametric
    geometry, so getClosestPoint is unavailable)."""
    best_tag, best_d = None, None
    for (d, tag) in gmsh.model.getEntities(dim):
        try:
            node_tags, coords, _ = gmsh.model.mesh.getNodes(dim, tag)
        except Exception:
            continue
        if len(node_tags) == 0:
            continue
        mind = None
        for i in range(0, len(node_tags)):
            cx, cy, cz = coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]
            dist = math.sqrt((cx - x) ** 2 + (cy - y) ** 2 + (cz - z) ** 2)
            if mind is None or dist < mind:
                mind = dist
        if best_d is None or mind < best_d:
            best_d, best_tag = mind, tag
    return best_tag, best_d


def _entity_points(gmsh, dim, tag):
    """Return the entity's mesh nodes as a list of [x, y, z] triples, or []."""
    try:
        node_tags, coords, _ = gmsh.model.mesh.getNodes(dim, tag)
    except Exception:
        return []
    if len(node_tags) == 0:
        return []
    return [[coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]] for i in range(len(node_tags))]


def _centroid(points):
    if not points:
        return None
    n = len(points)
    return [sum(p[i] for p in points) / n for i in range(3)]


def _entity_triangles(gmsh, tag):
    """Mesh triangles of a surface entity as [[p0, p1, p2], ...].

    Coordinates are resolved from the GLOBAL node table, not from
    ``getNodes(2, tag)``: a face's elements routinely reference nodes that
    Gmsh reports as owned by a neighbouring face (shared boundary nodes), so
    the per-entity node list is incomplete and filtering against it silently
    dropped every boundary triangle (partial highlights). Quadrilaterals are
    split into two triangles so a recombined (quad) surface still highlights."""
    try:
        etypes, etags, econn = gmsh.model.mesh.getElements(2, tag)
        all_tags, all_coords, _ = gmsh.model.mesh.getNodes()
    except Exception:
        return []
    idx = {t: (all_coords[3 * i], all_coords[3 * i + 1], all_coords[3 * i + 2]) for i, t in enumerate(all_tags)}
    tris = []
    for et, conn in zip(etypes, econn):
        if et == 2:
            for off in range(0, len(conn), 3):
                a, b, c = conn[off], conn[off + 1], conn[off + 2]
                if a in idx and b in idx and c in idx:
                    tris.append([idx[a], idx[b], idx[c]])
        elif et == 3:
            for off in range(0, len(conn), 4):
                a, b, c, d = conn[off], conn[off + 1], conn[off + 2], conn[off + 3]
                if a in idx and b in idx and c in idx and d in idx:
                    tris.append([idx[a], idx[b], idx[c]])
                    tris.append([idx[a], idx[c], idx[d]])
    return tris


def _write_quad_wireframe(gmsh, path):
    """Write the unique edges of the surface quadrilaterals to JSON so the
    browser can draw the real quad grid (an STL only carries triangles)."""
    try:
        ntags, coords, _ = gmsh.model.mesh.getNodes()
        etypes, _, econn = gmsh.model.mesh.getElements()
    except Exception:
        return
    idx = {t: (coords[3 * i], coords[3 * i + 1], coords[3 * i + 2]) for i, t in enumerate(ntags)}
    seen = set()
    edges = []
    for et, conn in zip(etypes, econn):
        if et != 3:
            continue
        for off in range(0, len(conn), 4):
            q = [conn[off], conn[off + 1], conn[off + 2], conn[off + 3]]
            for k in range(4):
                a, b = q[k], q[(k + 1) % 4]
                key = (a, b) if a < b else (b, a)
                if key in seen:
                    continue
                seen.add(key)
                pa, pb = idx.get(a), idx.get(b)
                if pa is not None and pb is not None:
                    edges.append(
                        [[round(float(c), 6) for c in pa], [round(float(c), 6) for c in pb]]
                    )
    try:
        with open(path, "w") as f:
            json.dump({"edges": edges}, f)
    except Exception as exc:
        log("quad wireframe write failed: {}".format(exc))


def _entity_segments(gmsh, tag):
    """Mesh line segments of a curve entity as [[p0, p1], ...] + total length.

    As with `_entity_triangles`, coordinates come from the global node table so
    segments touching shared nodes are not dropped."""
    try:
        etypes, etags, econn = gmsh.model.mesh.getElements(1, tag)
        all_tags, all_coords, _ = gmsh.model.mesh.getNodes()
    except Exception:
        return [], 0.0
    idx = {t: (all_coords[3 * i], all_coords[3 * i + 1], all_coords[3 * i + 2]) for i, t in enumerate(all_tags)}
    segs = []
    total = 0.0
    for et, conn in zip(etypes, econn):
        if et == 1:
            for off in range(0, len(conn), 2):
                a, b = idx.get(conn[off]), idx.get(conn[off + 1])
                if a is None or b is None:
                    continue
                segs.append([list(a), list(b)])
                total += math.dist(a, b)
    return segs, total


def _write_entity_snapshot(gmsh, path):
    """Persist the loaded model's per-face/per-edge mesh geometry to JSON.

    The Rust layer reads this file to answer interactive click-to-select
    picks without calling back into this worker, so picking keeps working
    while a long mesh job is occupying the (single) worker process."""
    def rp(p):
        return [round(float(c), 9) for c in p]

    snapshot = {"faces": [], "edges": []}
    for tag in [t for (d, t) in gmsh.model.getEntities(2)]:
        tris = _entity_triangles(gmsh, tag)
        if tris:
            snapshot["faces"].append(
                {"tag": tag, "tris": [[rp(p) for p in t] for t in tris]}
            )
    for tag in [t for (d, t) in gmsh.model.getEntities(1)]:
        segs, length = _entity_segments(gmsh, tag)
        if segs:
            snapshot["edges"].append(
                {
                    "tag": tag,
                    "segs": [[rp(a), rp(b)] for (a, b) in segs],
                    "length": round(float(length), 9),
                }
            )
    try:
        with open(path, "w") as f:
            json.dump(snapshot, f)
    except Exception as exc:
        log("entity snapshot write failed: {}".format(exc))


def _triangle_area(p0, p1, p2):
    ux, uy, uz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
    vx, vy, vz = p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]
    cx, cy, cz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    return 0.5 * math.sqrt(cx * cx + cy * cy + cz * cz)


def handle_pick(data):
    """Identify the nearest face (dim 2) and edge (dim 1) in the current
    model to a given point, for click-to-select in the viewport. Returns the
    full face triangles (for a whole-face highlight), ordered edge segments
    (whole-edge highlight), and geometric data (face area / edge length)."""
    gmsh, version = ensure_gmsh()
    x = float(data.get("x") or 0.0)
    y = float(data.get("y") or 0.0)
    z = float(data.get("z") or 0.0)

    best_face, best_fd = _nearest_entity(gmsh, 2, x, y, z)
    best_edge, best_ed = _nearest_entity(gmsh, 1, x, y, z)

    edge_points = _entity_points(gmsh, 1, best_edge) if best_edge is not None else []
    face_points = _entity_points(gmsh, 2, best_face) if best_face is not None else []

    face_tris = _entity_triangles(gmsh, best_face) if best_face is not None else []
    face_area = sum(_triangle_area(t[0], t[1], t[2]) for t in face_tris)
    edge_segs, edge_len = _entity_segments(gmsh, best_edge) if best_edge is not None else ([], 0.0)

    log("pick ({:.3f},{:.3f},{:.3f}) -> face {}, edge {}".format(x, y, z, best_face, best_edge))
    return {
        "status": "ok",
        "data": {
            "face": best_face,
            "face_distance": round(best_fd, 6) if best_fd is not None else None,
            "edge": best_edge,
            "edge_distance": round(best_ed, 6) if best_ed is not None else None,
            "edge_points": edge_points,
            "edge_segments": edge_segs,
            "edge_length": round(edge_len, 6),
            "face_triangles": face_tris,
            "face_area": round(face_area, 6),
            "face_point": _centroid(face_points),
        },
    }


def handle_entities(data=None):
    """Return every surface face and edge with a representative centroid/point,
    so the browser can do box (window) selection by projecting them to screen."""
    gmsh, version = ensure_gmsh()
    faces = []
    for (d, t) in gmsh.model.getEntities(2):
        pts = _entity_points(gmsh, 2, t)
        c = _centroid(pts)
        if c:
            faces.append({"tag": t, "centroid": c})
    edges = []
    for (d, t) in gmsh.model.getEntities(1):
        pts = _entity_points(gmsh, 1, t)
        c = _centroid(pts)
        if c:
            edges.append({"tag": t, "point": c})
    log("entities: {} faces, {} edges".format(len(faces), len(edges)))
    return {
        "status": "ok",
        "data": {"faces": faces, "edges": edges},
    }


HANDLERS = {"ping": handle_ping, "surface_mesh": handle_surface_mesh, "pick": handle_pick, "entities": handle_entities}


def process(request):
    job_id = request.get("id")
    job = request.get("job")
    handler = HANDLERS.get(job)
    if handler is None:
        return {
            "id": job_id,
            "status": "error",
            "message": "unknown job: {}".format(job),
            "data": {},
        }
    try:
        result = handler(request.get("data") or {})
    except Exception as exc:
        return {
            "id": job_id,
            "status": "error",
            "message": str(exc),
            "data": {},
        }
    response = {"id": job_id}
    response.update(result)
    return response


def main():
    log("worker started, python {}".format(sys.version.split()[0]))
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except Exception as exc:
                log("bad request JSON: {} -> {}".format(exc, line))
                sys.stdout.write(
                    json.dumps(
                        {
                            "id": None,
                            "status": "error",
                            "message": "bad request JSON: {}".format(exc),
                            "data": {},
                        }
                    )
                    + "\n"
                )
                sys.stdout.flush()
                continue
            response = process(request)
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()
    except KeyboardInterrupt:
        pass
    finally:
        if _GMSH is not None:
            try:
                _GMSH.finalize()
            except Exception:
                pass
        log("worker exited")


if __name__ == "__main__":
    main()
