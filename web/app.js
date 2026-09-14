"use strict";

const engineState = document.getElementById("engine-state");
const gmshVersion = document.getElementById("gmsh-version");
const meshStats = document.getElementById("mesh-stats");
const fileMsh = document.getElementById("file-msh");
const fileStl = document.getElementById("file-stl");
const updateBtn = document.getElementById("update-btn");
const stopBtn = document.getElementById("stop-btn");
let currentAbort = null;
const toolbarStatus = document.getElementById("toolbar-status");
const stage = document.getElementById("stage");
const stageHint = document.getElementById("stage-hint");
const importBtn = document.getElementById("import-btn");
const fileInput = document.getElementById("file-input");
const generateBtn = document.getElementById("generate-btn");
const loadProjectInput = document.getElementById("load-project-input");

let pendingFile = null;
let pendingFileData = null;
let stlStats = null; // bbox stats of the loaded geometry (minDim/maxDim/minEdge)

/* ---- sizing / refinement controls ---- */
const regionsBox = document.getElementById("regions");
const addRegionBtn = document.getElementById("add-region-btn");
const volumeEnable = document.getElementById("volume-enable");
const relevance = document.getElementById("relevance");
const sizeMax = document.getElementById("size-max");
const sizeMin = document.getElementById("size-min");
const sizeFace = document.getElementById("size-face");
const growthRate = document.getElementById("growth-rate");
const curvAngle = document.getElementById("curv-angle");
const sizeGlobal = document.getElementById("size-global");
const sizeSeed = document.getElementById("size-seed");
const advSizeFn = document.getElementById("adv-size-fn");
const smoothing = document.getElementById("smoothing");
const transitionSel = document.getElementById("transition");
const spanCenter = document.getElementById("span-center");
const surfaceAlgo = document.getElementById("surface-algo");
const meshMethod = document.getElementById("mesh-method");
const surfaceType = document.getElementById("surface-type");
const deleteMeshBtn = document.getElementById("delete-mesh-btn");
const selCount = document.getElementById("sel-count");
const viewCtxMenu = document.getElementById("view-ctx-menu");
const exportFormat = document.getElementById("export-format");
const sweepControls = document.getElementById("sweep-controls");
const revolveControls = document.getElementById("revolve-controls");
const revolveAxis = document.getElementById("revolve-axis");
const revolveLayers = document.getElementById("revolve-layers");
const pickSourceBtn = document.getElementById("pick-source-btn");
const pickTargetBtn = document.getElementById("pick-target-btn");
const sweepSourceVal = document.getElementById("sweep-source-val");
const sweepTargetVal = document.getElementById("sweep-target-val");
const sweepLayers = document.getElementById("sweep-layers");
let sweepSource = null;
let sweepTarget = null;
const minEdge = document.getElementById("min-edge");
const pickFaceBtn = document.getElementById("pick-face-btn");
const pickEdgeBtn = document.getElementById("pick-edge-btn");
const pickWallBtn = document.getElementById("pick-wall-btn");
const zoomIn = document.getElementById("zoom-in");
const zoomOut = document.getElementById("zoom-out");
const orientWidget = document.getElementById("orient-widget");
const gridToggle = document.getElementById("grid-toggle");
const entityType = document.getElementById("entity-type");
const selectionMode = document.getElementById("selection-mode");
const displayMode = document.getElementById("display-mode");
const fitView = document.getElementById("fit-view");
const isoView = document.getElementById("iso-view");
const physics = document.getElementById("physics");
const relevanceNum = document.getElementById("relevance-num");
const unitSystem = document.getElementById("unit-system");
const angleUnit = document.getElementById("angle-unit");
const statNodes = document.getElementById("stat-nodes");
const statElems = document.getElementById("stat-elems");
const statTris = document.getElementById("stat-tris");
const statQuads = document.getElementById("stat-quads");
const statTets = document.getElementById("stat-tets");
const statHexes = document.getElementById("stat-hexes");
const statPrisms = document.getElementById("stat-prisms");
const consoleBox = document.getElementById("console");
const consoleBody = document.getElementById("console-body");
const consoleResizer = document.getElementById("console-resizer");
const consoleHide = document.getElementById("console-hide");

const RELEVANCE_FACTOR = { coarse: 1.5, medium: 1.0, fine: 0.5 };

function addRegion(defaults) {
  const row = document.createElement("div");
  row.className = "region";
  const keys = ["xmin", "xmax", "ymin", "ymax", "zmin", "zmax", "size"];
  keys.forEach((k) => {
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.dataset.k = k;
    input.placeholder = k;
    if (defaults && defaults[k] !== undefined) input.value = defaults[k];
    row.appendChild(input);
  });
  const rm = document.createElement("button");
  rm.type = "button";
  rm.textContent = "Remove";
  rm.addEventListener("click", () => {
    row.remove();
    if (!regionsBox.children.length) regionsBox.hidden = true;
  });
  row.appendChild(rm);
  regionsBox.appendChild(row);
  regionsBox.hidden = false;
}

addRegionBtn.addEventListener("click", () =>
  addRegion({
    xmin: -0.05, xmax: 0.05, ymin: -0.05, ymax: 0.05, zmin: -0.05, zmax: 0.05, size: 0.004,
  })
);

function collectRegions() {
  const out = [];
  document.querySelectorAll("#regions .region").forEach((row) => {
    const get = (k) => parseFloat(row.querySelector(`[data-k="${k}"]`).value);
    const r = {
      xmin: get("xmin"), xmax: get("xmax"),
      ymin: get("ymin"), ymax: get("ymax"),
      zmin: get("zmin"), zmax: get("zmax"),
      size: get("size"),
    };
    if (Object.values(r).every(Number.isFinite)) out.push(r);
  });
  return out;
}

/* ---- per-entity sizing + boundary layer ---- */
const namedSelectionsBox = document.getElementById("named-selections");
const blAuto = document.getElementById("bl-auto");
const blOption = document.getElementById("bl-option");
const blLayers = document.getElementById("bl-layers");
const blFirst = document.getElementById("bl-first");
const blGrowth = document.getElementById("bl-growth");
const blTotal = document.getElementById("bl-total");
const blMax = document.getElementById("bl-max");

function addRow(container, keys, placeholders) {
  const row = document.createElement("div");
  row.className = "region";
  keys.forEach((k, i) => {
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.dataset.k = k;
    input.placeholder = placeholders[i];
    row.appendChild(input);
  });
  const rm = document.createElement("button");
  rm.type = "button";
  rm.textContent = "Remove";
  rm.addEventListener("click", () => {
    row.remove();
    if (!container.children.length) container.hidden = true;
  });
  row.appendChild(rm);
  container.appendChild(row);
  container.hidden = false;
  return row;
}

/* Geometry stats from an STL (bbox + smallest edge) so the default element
   size can be scaled to the geometry's actual smallest feature. */
function computeStlStats(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  let ntri = 0, isBinary = false;
  if (arrayBuffer.byteLength >= 84) {
    ntri = dv.getUint32(80, true);
    if (ntri > 0 && 84 + ntri * 50 === arrayBuffer.byteLength) isBinary = true;
  }
  let minEdge = Infinity;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const acc = (p) => {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    if (p[2] < minZ) minZ = p[2]; if (p[2] > maxZ) maxZ = p[2];
  };
  const edge = (a, b) => {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    if (d > 1e-9 && d < minEdge) minEdge = d;
  };
  if (isBinary) {
    for (let i = 0; i < ntri; i++) {
      const off = 84 + i * 50 + 12;
      const p = [];
      for (let v = 0; v < 3; v++) {
        const q = [dv.getFloat32(off + v * 12, true), dv.getFloat32(off + v * 12 + 4, true), dv.getFloat32(off + v * 12 + 8, true)];
        acc(q); p.push(q);
      }
      edge(p[0], p[1]); edge(p[1], p[2]); edge(p[2], p[0]);
    }
  } else {
    const text = new TextDecoder().decode(arrayBuffer);
    const re = /vertex\s+([-0-9.eE+]+)\s+([-0-9.eE+]+)\s+([-0-9.eE+]+)/g;
    const verts = []; let m;
    while ((m = re.exec(text))) { const q = [+m[1], +m[2], +m[3]]; acc(q); verts.push(q); }
    for (let i = 0; i + 2 < verts.length; i += 3) {
      edge(verts[i], verts[i + 1]); edge(verts[i + 1], verts[i + 2]); edge(verts[i + 2], verts[i]);
    }
  }
  const dimX = maxX - minX, dimY = maxY - minY, dimZ = maxZ - minZ;
  return {
    minEdge: Number.isFinite(minEdge) ? minEdge : null,
    maxDim: Math.max(dimX, dimY, dimZ),
    // Smallest real dimension of the geometry (the bounding box's shortest
    // side) — the sane reference for a default element size.
    minDim: Math.min(dimX, dimY, dimZ),
  };
}

/* Default element size from the geometry's smallest real dimension.
   Deliberately tied to the bounding box, NOT to the smallest tessellation edge
   (an STL artefact): the default is at most 1/10 of the shortest bbox side, so
   it is always meaningfully smaller than the model while staying coarse enough
   to mesh quickly. Expressed in the current Unit System (the coordinates are
   interpreted in that unit, and the unit handler rescales these fields). */
function suggestedElementSize(st) {
  if (!st) return null;
  const ref = st.minDim > 0 ? st.minDim : st.maxDim;
  if (!Number.isFinite(ref) || ref <= 0) return null;
  return ref / 10;
}

function applySuggestedSize(st) {
  const cap = suggestedElementSize(st);
  if (!cap) return;
  // Relevance (100 = neutral) scales the AUTO default only; the field then
  // holds the final value and is sent verbatim.
  const rel = 100 / (parseFloat(relevanceNum.value) || 100);
  const suggested = cap * rel;
  sizeGlobal.value = +suggested.toPrecision(4);
  sizeMax.value = +suggested.toPrecision(4);
  sizeFace.value = +suggested.toPrecision(4);
  sizeMin.value = +(suggested / 5).toPrecision(4);
  logConsole(
    `Auto element size: smallest geometry dimension ${st.minDim.toPrecision(4)} ${unitSymbol()} ` +
      `/10 = ${cap.toPrecision(4)}, x relevance ${rel.toPrecision(3)} -> default ${suggested.toPrecision(4)} ${unitSymbol()}.`,
    "info"
  );
}

function parseTags(str) {  return String(str || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

function addNamedSelection(type, tag, size, useWall) {
  // `wall` is a ROLE, not an entity type: normalise it to a face row flagged
  // as an inflation wall so a named selection can be reused everywhere.
  const entity = type === "wall" ? "face" : type;
  const isEdge = entity === "edge";
  const wallFlag = useWall === true || type === "wall";
  const row = document.createElement("div");
  row.className = "region ns";
  row.dataset.type = entity;
  const name = document.createElement("input");
  name.type = "text";
  name.dataset.k = "name";
  name.placeholder = "name (e.g. inlet)";
  row.appendChild(name);
  const typeIn = document.createElement("input");
  typeIn.type = "hidden";
  typeIn.dataset.k = "type";
  typeIn.value = entity;
  row.appendChild(typeIn);
  const tagIn = document.createElement("input");
  tagIn.type = "text";
  tagIn.dataset.k = "tag";
  tagIn.placeholder = "tags e.g. 4,7,10";
  tagIn.value = tag != null ? String(tag) : "";
  row.appendChild(tagIn);
  const sizeIn = document.createElement("input");
  sizeIn.type = "number";
  sizeIn.step = "any";
  sizeIn.dataset.k = "size";
  sizeIn.placeholder = "size";
  if (size) sizeIn.value = size;
  row.appendChild(sizeIn);

  // Role flags: a named selection can drive sizing and/or inflation.
  const useWrap = document.createElement("span");
  useWrap.className = "use-wrap";
  const mkUse = (key, label, checked) => {
    const lab = document.createElement("label");
    lab.className = "use-opt";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.dataset.k = key;
    cb.checked = !!checked;
    lab.appendChild(cb);
    lab.appendChild(document.createTextNode(label));
    return lab;
  };
  useWrap.appendChild(mkUse("use-sizing", "Sizing", Number.isFinite(parseFloat(sizeIn.value))));
  if (!isEdge) useWrap.appendChild(mkUse("use-wall", "Wall", wallFlag));
  row.appendChild(useWrap);

  const rm = document.createElement("button");
  rm.type = "button";
  rm.textContent = "Remove";
  rm.addEventListener("click", () => {
    row.remove();
    if (!namedSelectionsBox.children.length) namedSelectionsBox.hidden = true;
    updateSelectionCount();
  });
  row.appendChild(rm);

  // Scoped selection count for THIS control (persists after picking ends).
  // Click the field to reveal the assigned entity tags.
  const scope = document.createElement("div");
  scope.className = "scope-count";
  scope.title = "Entities scoped to this control (click to show tags)";
  const scopeText = document.createElement("span");
  scopeText.className = "scope-text";
  const scopeList = document.createElement("span");
  scopeList.className = "scope-list";
  scopeList.hidden = true;
  scope.appendChild(scopeText);
  scope.appendChild(scopeList);
  const refreshScope = () => {
    const tags = parseTags(tagIn.value);
    const isEdge = type === "edge";
    const noun = isEdge ? "Edge" : "Face";
    const label = isEdge ? "Boundary" : "Geometry";
    scopeText.textContent = `${label}: ${tags.length} ${noun}${tags.length === 1 ? "" : "s"}`;
    scopeList.textContent = tags.length ? " [" + tags.join(", ") + "]" : "";
    updateSelectionCount();
  };
  scope.addEventListener("click", () => { scopeList.hidden = !scopeList.hidden; });
  tagIn.addEventListener("input", refreshScope);
  row.appendChild(scope);
  refreshScope();

  namedSelectionsBox.appendChild(row);
  namedSelectionsBox.hidden = false;
  updateSelectionCount();
  return row;
}

function clearNamedSelections() {
  namedSelectionsBox.innerHTML = "";
  namedSelectionsBox.hidden = true;
  updateSelectionCount();
}

/* Finds the named-selection row for a given type+tag, or null. Used to make a
   second click on the same entity toggle it off. */
function findNamedSelection(type, tag) {
  const want = String(tag);
  for (const row of Array.from(namedSelectionsBox.children)) {
    if (row.dataset.type !== type) continue;
    const inp = row.querySelector('[data-k="tag"]');
    if (inp && parseTags(inp.value).some((t) => String(t) === want)) return row;
  }
  return null;
}

/* Removes a type+tag row (deselect). Returns true if something was removed. */
function removeNamedSelection(type, tag) {
  const row = findNamedSelection(type, tag);
  if (!row) return false;
  row.remove();
  if (!namedSelectionsBox.children.length) namedSelectionsBox.hidden = true;
  updateSelectionCount();
  return true;
}

/* ---- Sizing controls (ANSYS-style details panel with Apply / Cancel) ----
   Each control is an independent record; selecting one highlights only its
   own geometry and removing one never touches the others. */
const sizingListBox = document.getElementById("sizing-list");
const sizingDetails = document.getElementById("sizing-details");
const sizingGeometryVal = document.getElementById("sizing-geometry-val");
const sizingType = document.getElementById("sizing-type");
const sizingSize = document.getElementById("sizing-size");
const sizingSizeField = document.getElementById("sizing-size-field");
let sizingRecords = [];
let pendingSizing = null;
let activeSizingId = null;
let sizingSeq = 1;

function sizingGeometry(kind, d) {
  return kind === "edge"
    ? { segments: d.edge_segments || [], points: d.edge_points || [] }
    : { triangles: d.face_triangles || [], point: d.face_point || null };
}

function showPendingSizing(kind, d) {
  pendingSizing = {
    kind,
    tag: kind === "edge" ? d.edge : d.face,
    geometry: sizingGeometry(kind, d),
  };
  sizingGeometryVal.textContent = `${kind === "edge" ? "Edge" : "Face"} ${pendingSizing.tag}`;
  sizingDetails.hidden = false;
  if (!sizingSize.value) sizingSize.value = sizeMax.value || "";
  renderSizingSizeField();
}

function renderSizingSizeField() {
  sizingSizeField.hidden = sizingType.value !== "element_size";
}

function highlightSizingRecord(rec) {
  if (!rec) { clearSelection(); return; }
  const g = rec.geometry || {};
  if (rec.kind === "edge") showSelection("edge", null, null, g.points, null, g.segments);
  else showSelection("face", null, g.point, null, g.triangles, null);
}

function renderSizingList() {
  sizingListBox.innerHTML = "";
  if (!sizingRecords.length) { sizingListBox.hidden = true; return; }
  sizingRecords.forEach((rec) => {
    const row = document.createElement("div");
    row.className = "region";
    const label = document.createElement("span");
    label.className = "sizing-label";
    label.textContent = `${rec.kind === "edge" ? "Edge" : "Face"} ${rec.tag}`;
    row.appendChild(label);
    const sizeIn = document.createElement("input");
    sizeIn.type = "number";
    sizeIn.step = "any";
    sizeIn.dataset.k = "size";
    sizeIn.value = rec.size;
    sizeIn.addEventListener("input", () => { rec.size = parseFloat(sizeIn.value); saveAutosave(); });
    row.appendChild(sizeIn);
    const sel = document.createElement("button");
    sel.type = "button";
    sel.textContent = "Select";
    sel.addEventListener("click", () => {
      activeSizingId = rec.id;
      highlightSizingRecord(rec);
      toolbarStatus.textContent = `Sizing control: ${rec.kind} ${rec.tag} = ${rec.size}`;
    });
    row.appendChild(sel);
    const rm = document.createElement("button");
    rm.type = "button";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => {
      sizingRecords = sizingRecords.filter((r) => r.id !== rec.id);
      if (activeSizingId === rec.id) { activeSizingId = null; clearSelection(); }
      renderSizingList();
      saveAutosave();
    });
    row.appendChild(rm);
    sizingListBox.appendChild(row);
  });
  sizingListBox.hidden = false;
}

function applySizing() {
  if (!pendingSizing) return;
  const size = parseFloat(sizingSize.value);
  if (!Number.isFinite(size)) { toolbarStatus.textContent = "Enter a size before Apply."; return; }
  sizingRecords.push({
    id: "s" + sizingSeq++,
    kind: pendingSizing.kind,
    tag: pendingSizing.tag,
    type: sizingType.value,
    size,
    geometry: pendingSizing.geometry,
  });
  pendingSizing = null;
  sizingDetails.hidden = true;
  renderSizingList();
  toolbarStatus.textContent = `Sizing control applied (${sizingRecords.length} total).`;
  saveAutosave();
}

function cancelSizing() {
  pendingSizing = null;
  sizingDetails.hidden = true;
  clearSelection();
  toolbarStatus.textContent = "Sizing pick cancelled \u2014 nothing changed.";
}

document.getElementById("sizing-pick-face-btn").addEventListener("click", () => forcePickMode("sizing_face"));
document.getElementById("sizing-pick-edge-btn").addEventListener("click", () => forcePickMode("sizing_edge"));
document.getElementById("sizing-apply-btn").addEventListener("click", applySizing);
document.getElementById("sizing-cancel-btn").addEventListener("click", cancelSizing);
sizingType.addEventListener("change", renderSizingSizeField);
renderSizingSizeField();

function collectNamedSelections() {
  const out = [];
  namedSelectionsBox.querySelectorAll(".region").forEach((row) => {
    const type = row.dataset.type || "face";
    const tags = parseTags(row.querySelector('[data-k="tag"]').value);
    const name = row.querySelector('[data-k="name"]').value.trim() || null;
    const sizeIn = row.querySelector('[data-k="size"]');
    const size = sizeIn ? parseFloat(sizeIn.value) : NaN;
    const sizingCb = row.querySelector('[data-k="use-sizing"]');
    const wallCb = row.querySelector('[data-k="use-wall"]');
    const useSizing = sizingCb ? sizingCb.checked : false;
    const useWall = wallCb ? wallCb.checked : false;
    tags.forEach((tag) =>
      out.push({
        name,
        type,
        tag,
        size: useSizing && Number.isFinite(size) ? size : null,
        use: { sizing: useSizing, wall: useWall },
      })
    );
  });
  return out;
}

/* ---- click-to-select picking ---- */
function setPickMode(mode) {
  // Always SET, never toggle off. The Entity type dropdown's "Off" is how
  // picking is stopped. Toggling here turned "Pick face" into an OFF switch,
  // because the default entity type already arms face picking on load.
  pickMode = mode;
  if (mode === "face" || mode === "edge" || mode === "vertex") {
    entityType.value = mode;
  }
  updatePickButtons();
  if (renderer && renderer.domElement) {
    renderer.domElement.style.cursor = pickMode ? "crosshair" : "grab";
  }
  toolbarStatus.textContent = pickMode
    ? `Pick ${pickMode}: click the model in the viewport`
    : "";
}

function forcePickMode(mode) {
  pickMode = mode;
  updatePickButtons();
  if (renderer && renderer.domElement) {
    renderer.domElement.style.cursor = pickMode ? "crosshair" : "grab";
  }
  toolbarStatus.textContent = pickMode
    ? `Pick ${pickMode}: click the model in the viewport`
    : "";
}

function updatePickButtons() {
  [
    ["face", pickFaceBtn],
    ["edge", pickEdgeBtn],
    ["wall", pickWallBtn],
  ].forEach(([m, btn]) => btn.classList.toggle("active", pickMode === m));
}

pickFaceBtn.addEventListener("click", () => setPickMode("face"));
pickEdgeBtn.addEventListener("click", () => setPickMode("edge"));
pickWallBtn.addEventListener("click", () => setPickMode("wall"));

/* Standalone Named Selections panel: pick any face/edge to name it. */
const nsPickFaceBtn = document.getElementById("ns-pick-face-btn");
const nsPickEdgeBtn = document.getElementById("ns-pick-edge-btn");
if (nsPickFaceBtn) nsPickFaceBtn.addEventListener("click", () => forcePickMode("face"));
if (nsPickEdgeBtn) nsPickEdgeBtn.addEventListener("click", () => forcePickMode("edge"));

/* ---- manual sweep (source → target) ---- */
meshMethod.addEventListener("change", () => {
  const sweep = meshMethod.value === "sweep";
  sweepControls.hidden = !sweep;
  if (sweep) volumeEnable.checked = true;
  const rev = meshMethod.value === "revolve";
  if (revolveControls) revolveControls.hidden = !rev;
  if (rev) volumeEnable.checked = true;
});
pickSourceBtn.addEventListener("click", () => forcePickMode("sweep_source"));
pickTargetBtn.addEventListener("click", () => forcePickMode("sweep_target"));
const clearSourceBtn = document.getElementById("clear-source-btn");
const clearTargetBtn = document.getElementById("clear-target-btn");
clearSourceBtn.addEventListener("click", () => {
  sweepSource = null;
  sweepSourceVal.textContent = "\u2014";
  toolbarStatus.textContent = "Sweep source face cleared \u2014 pick a new one.";
  saveAutosave();
});
clearTargetBtn.addEventListener("click", () => {
  sweepTarget = null;
  sweepTargetVal.textContent = "\u2014";
  toolbarStatus.textContent = "Sweep target face cleared \u2014 pick a new one.";
  saveAutosave();
});

/* ---- CAD-style selection toolbar ---- */
let boxMode = false;
function updateSelection() {
  boxMode = selectionMode.value === "box";
  const et = entityType.value;
  if (et === "off") {
    forcePickMode(null);
  } else {
    forcePickMode(et); // "face" | "edge" | "vertex"
  }
}
entityType.addEventListener("change", updateSelection);
selectionMode.addEventListener("change", updateSelection);
fitView.addEventListener("click", resetView);
isoView.addEventListener("click", snapToIso);

/* ---- selection count (issue 4) ---- */
function updateSelectionCount() {
  if (!selCount) return;
  const ns = collectNamedSelections();
  const faces = ns.filter((s) => s.type === "face" || s.type === "wall").length;
  const edges = ns.filter((s) => s.type === "edge").length;
  const parts = [];
  if (faces) parts.push(`${faces} Face${faces > 1 ? "s" : ""}`);
  if (edges) parts.push(`${edges} Edge${edges > 1 ? "s" : ""}`);
  selCount.textContent = parts.length ? parts.join(" \u00b7 ") + " selected" : "0 selected";
}

/* ---- delete mesh: clears ONLY the generated mesh, keeps the geometry ---- */
deleteMeshBtn.addEventListener("click", () => {
  clearMeshResult();
  renderQuality(null);
  updateStats({});
  updateSelectionCount();
  // `currentMesh` IS the displayed geometry surface, so it must never be
  // removed here — Delete Mesh only drops the generated-mesh result.
  if (pendingFile) {
    // Re-display the raw imported geometry instead of the meshed surface.
    loadPreview(URL.createObjectURL(pendingFile), true);
  }
  toolbarStatus.textContent = "Mesh deleted. Geometry kept — click Generate Mesh to re-mesh.";
  logConsole("Mesh deleted (geometry, selections and sizing retained).", "info");
});

/* ---- viewport screenshot + sizing context menu (issues 2 & 3) ---- */
function renderFresh() {
  if (!renderer || !scene || !camera) return null;
  renderer.render(scene, camera);
  return renderer.domElement;
}
function copyViewImage() {
  const canvas = renderFresh();
  if (!canvas) return;
  canvas.toBlob(async (blob) => {
    if (!blob) { toolbarStatus.textContent = "Image capture failed."; return; }
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toolbarStatus.textContent = "View image copied to clipboard.";
    } catch (err) {
      toolbarStatus.textContent = "Copy failed: " + err.message;
    }
  }, "image/png");
}
function saveViewImage() {
  const canvas = renderFresh();
  if (!canvas) return;
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = "gmesh-view.png";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function hideViewContextMenu() { if (viewCtxMenu) viewCtxMenu.hidden = true; }
function applyContextSizing(kind, tag) {
  addNamedSelection(kind, tag, sizeMax.value);
  updateSelectionCount();
  toolbarStatus.textContent = `${kind === "face" ? "Face" : "Edge"} ${tag} selected — set its Element Size in Named Selections (left panel).`;
  const rows = namedSelectionsBox.querySelectorAll(".region");
  const last = rows[rows.length - 1];
  if (last) {
    const sizeInput = last.querySelector('[data-k="size"]');
    if (sizeInput) { sizeInput.focus(); sizeInput.select(); }
  }
  saveAutosave();
}
function showViewContextMenu(e, pickData) {
  if (!viewCtxMenu) return;
  viewCtxMenu.innerHTML = "";
  const add = (label, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", () => { hideViewContextMenu(); fn(); });
    viewCtxMenu.appendChild(b);
  };
  if (pickData && pickData.face != null) add("Face Sizing", () => applyContextSizing("face", pickData.face));
  if (pickData && pickData.edge != null) add("Edge Sizing", () => applyContextSizing("edge", pickData.edge));
  if (pickData) {
    const sep = document.createElement("div");
    sep.className = "ctx-sep";
    viewCtxMenu.appendChild(sep);
  }
  add("Copy image to clipboard", copyViewImage);
  add("Save image as\u2026", saveViewImage);
  viewCtxMenu.style.left = e.clientX + "px";
  viewCtxMenu.style.top = e.clientY + "px";
  viewCtxMenu.hidden = false;
}
document.addEventListener("click", hideViewContextMenu);

let viewportDown = null;

/* ---- display mode (Shaded / Wireframe / Shaded+Edges) ---- */
function setDisplayMode(mode) {
  if (!currentMesh) return;
  const solid = currentMesh.solid;
  const wire = currentMesh.wire;
  if (mode === "wireframe") {
    if (wire) {
      solid.visible = false;
      wire.visible = true;
    } else {
      solid.visible = true;
      solid.material.wireframe = true;
    }
  } else if (mode === "shaded") {
    solid.visible = true;
    if (solid.material) solid.material.wireframe = false;
    if (wire) wire.visible = false;
  } else {
    solid.visible = true;
    if (solid.material) solid.material.wireframe = false;
    if (wire) wire.visible = true;
  }
}
displayMode.addEventListener("change", () => setDisplayMode(displayMode.value));

/* ---- box (window) selection ---- */
let entityData = { faces: [], edges: [] };
let boxStart = null;
let boxEl = null;
async function fetchEntities() {
  try {
    const res = await fetch("/api/entities");
    const body = await res.json();
    if (body.status === "ok") entityData = body.data || { faces: [], edges: [] };
  } catch (_) {}
}
function boxRect(e) {
  const r = renderer.domElement.getBoundingClientRect();
  return {
    x0: Math.min(boxStart.x, e.clientX) - r.left,
    y0: Math.min(boxStart.y, e.clientY) - r.top,
    x1: Math.max(boxStart.x, e.clientX) - r.left,
    y1: Math.max(boxStart.y, e.clientY) - r.top,
    r,
  };
}
function updateBox(e) {
  if (!boxStart || !boxEl) return;
  const b = boxRect(e);
  boxEl.style.left = b.x0 + "px";
  boxEl.style.top = b.y0 + "px";
  boxEl.style.width = (b.x1 - b.x0) + "px";
  boxEl.style.height = (b.y1 - b.y0) + "px";
}
async function finalizeBox(e) {
  if (!boxStart) return;
  if (controls) controls.enabled = true;
  const b = boxRect(e);
  boxStart = null;
  if (boxEl) boxEl.style.display = "none";
  const project = (p) => {
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
    return { x: (v.x + 1) / 2 * b.r.width, y: (1 - (v.y + 1) / 2) * b.r.height };
  };
  const inBox = (sp) => sp.x >= b.x0 && sp.x <= b.x1 && sp.y >= b.y0 && sp.y <= b.y1;

  if (pickMode === "vertex") {
    const pos = vertexPositions();
    if (!pos) return;
    const indices = [];
    for (let i = 0; i < pos.length; i += 3) {
      const sp = project([pos[i], pos[i + 1], pos[i + 2]]);
      if (inBox(sp)) indices.push(i / 3);
    }
    clearVertexSelection();
    showVertexSelection(indices);
    toolbarStatus.textContent = indices.length
      ? `Box selection: ${indices.length} vertices highlighted`
      : "Box selection found nothing.";
    saveAutosave();
    return;
  }

  const kind = pickMode === "edge" ? "edge" : "face";
  const list = kind === "edge" ? entityData.edges : entityData.faces;

  // Occlusion test: a point counts only if the nearest surface hit from the
  // camera is (approximately) the point itself — i.e. it is actually visible.
  let ref = 1;
  if (currentMesh) {
    currentMesh.geometry.computeBoundingBox();
    const s = currentMesh.geometry.boundingBox.getSize(new THREE.Vector3());
    ref = Math.max(s.x, s.y, s.z) || 1;
  }
  const tol = ref * 0.02;
  const pointVisible = (p) => {
    const P = new THREE.Vector3(p[0], p[1], p[2]);
    const ndc = P.clone().project(camera);
    raycaster.setFromCamera(new THREE.Vector2(ndc.x, ndc.y), camera);
    const hits = raycaster.intersectObject(currentMesh.solid);
    if (!hits.length) return false;
    return Math.abs(hits[0].distance - camera.position.distanceTo(P)) < tol;
  };
  // True when ANY part of the entity is inside the rectangle and visible.
  const hitByBox = (it) => {
    const pts = it.points && it.points.length ? it.points : [it.centroid || it.point];
    let checked = 0;
    for (const p of pts) {
      if (!p) continue;
      const sp = project(p);
      if (!inBox(sp)) continue;
      if (++checked > 400) break;
      if (pointVisible(p)) return true;
    }
    return false;
  };

  // A box drag replaces the current selection (ANSYS behaviour), then adds
  // every entity whose visible portion falls inside the rectangle.
  clearNamedSelections();
  const picked = [];
  list.forEach((it) => {
    if (hitByBox(it)) picked.push(it);
  });
  picked.forEach((it) => addNamedSelection(kind, it.tag, sizeMax.value));
  if (picked.length) {
    toolbarStatus.textContent = `Box selection: ${picked.length} ${kind}(s) selected`;
    saveAutosave();
  } else {
    toolbarStatus.textContent = "Box selection found nothing.";
  }
  updateSelectionCount();
}

function onViewportClick(e) {
  if (boxMode) {
    if (controls) controls.enabled = false;
    boxStart = { x: e.clientX, y: e.clientY };
    if (!boxEl) {
      boxEl = document.createElement("div");
      boxEl.className = "sel-box";
      stage.appendChild(boxEl);
    }
    boxEl.style.display = "block";
    updateBox(e);
    return;
  }
  viewportDown = { x: e.clientX, y: e.clientY };
}

function handleViewportUp(e) {
  if (boxMode) {
    if (boxStart) finalizeBox(e);
    return;
  }
  if (!viewportDown) return;
  const dx = e.clientX - viewportDown.x;
  const dy = e.clientY - viewportDown.y;
  viewportDown = null;
  if (Math.hypot(dx, dy) > 6) return; // drag, not a click
  doPick(e);
}

async function doPick(e) {
  if (!pickMode || !currentMesh || !renderer) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(currentMesh.solid);
  if (!hits.length) return;
  const p = hits[0].point;

  if (pickMode === "vertex") {
    const idx = pickNearestVertex(p);
    if (idx < 0) return;
    const additiveV = e.ctrlKey || e.metaKey;
    if (!additiveV) { clearVertexSelection(); clearNamedSelections(); }
    showVertexSelection([idx]);
    showSelectionInfo("vertex", idx + 1, { point: [p.x, p.y, p.z] });
    toolbarStatus.textContent = `Selected vertex ${idx + 1} (${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)})`;
    pickMode = null;
    updatePickButtons();
    saveAutosave();
    return;
  }

  try {
    // Timeout so a busy/hung worker can't leave the click with no feedback.
    const pickCtrl = new AbortController();
    const pickTimer = setTimeout(() => pickCtrl.abort(), 10000);
    let body;
    try {
      const res = await fetch("/api/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: p.x, y: p.y, z: p.z }),
        signal: pickCtrl.signal,
      });
      body = await res.json();
    } finally {
      clearTimeout(pickTimer);
    }
    if (body.status !== "ok") {
      toolbarStatus.textContent = body.message || "Pick failed.";
      return;
    }
    const d = body.data || {};
    const additive = e.ctrlKey || e.metaKey; // Ctrl+click adds to selection
    if (pickMode === "sweep_source" && d.face != null) {
      sweepSource = d.face;
      sweepSourceVal.textContent = d.face;
      showSelection("face", p, d.face_point, null, d.face_triangles);
      showSelectionInfo("face", d.face, { area: d.face_area });
      toolbarStatus.textContent = `Sweep source face: ${d.face}`;
      pickMode = null;
      updatePickButtons();
      return;
    }
    if (pickMode === "sweep_target" && d.face != null) {
      sweepTarget = d.face;
      sweepTargetVal.textContent = d.face;
      showSelection("face", p, d.face_point, null, d.face_triangles);
      showSelectionInfo("face", d.face, { area: d.face_area });
      toolbarStatus.textContent = `Sweep target face: ${d.face}`;
      pickMode = null;
      updatePickButtons();
      return;
    }
    // Second click on an already-selected entity toggles it OFF.
    const toggleKind =
      pickMode === "face" && d.face != null ? ["face", d.face] :
      pickMode === "edge" && d.edge != null ? ["edge", d.edge] :
      pickMode === "wall" && d.face != null ? ["wall", d.face] : null;
    if (toggleKind && findNamedSelection(toggleKind[0], toggleKind[1])) {
      removeNamedSelection(toggleKind[0], toggleKind[1]);
      clearSelection();
      const el = document.getElementById("sel-info");
      if (el) el.hidden = true;
      lastSelectionInfo = null;
      toolbarStatus.textContent = `${toggleKind[0]} ${toggleKind[1]} deselected (click again to re-select).`;
      logConsole(`Pick ok: ${toggleKind[0]} ${toggleKind[1]} (deselected)`, "info");
      saveAutosave();
      return;
    }
    if (pickMode === "sizing_face" && d.face != null) {
      showSelection("face", p, d.face_point, null, d.face_triangles);
      showSelectionInfo("face", d.face, { area: d.face_area });
      showPendingSizing("face", d);
      toolbarStatus.textContent = `Face ${d.face} picked \u2014 press Apply to create the sizing control.`;
      pickMode = null;
      updatePickButtons();
      saveAutosave();
      return;
    }
    if (pickMode === "sizing_edge" && d.edge != null) {
      showSelection("edge", p, null, d.edge_points, null, d.edge_segments);
      showSelectionInfo("edge", d.edge, { length: d.edge_length });
      showPendingSizing("edge", d);
      toolbarStatus.textContent = `Edge ${d.edge} picked \u2014 press Apply to create the sizing control.`;
      pickMode = null;
      updatePickButtons();
      saveAutosave();
      return;
    }
    if (pickMode === "face" && d.face != null) {
      if (!additive) clearNamedSelections();
      addNamedSelection("face", d.face, sizeMax.value);
      showSelection("face", p, d.face_point, null, d.face_triangles);
      showSelectionInfo("face", d.face, { area: d.face_area });
      toolbarStatus.textContent = `Named face ${d.face} - type a name`;
    } else if (pickMode === "edge" && d.edge != null) {
      if (!additive) clearNamedSelections();
      addNamedSelection("edge", d.edge, sizeMax.value);
      showSelection("edge", p, null, d.edge_points, null, d.edge_segments);
      showSelectionInfo("edge", d.edge, { length: d.edge_length });
      toolbarStatus.textContent = `Named edge ${d.edge} - type a name`;
    } else if (pickMode === "wall" && d.face != null) {
      if (!additive) clearNamedSelections();
      addNamedSelection("wall", d.face, "");
      showSelection("face", p, d.face_point, null, d.face_triangles);
      showSelectionInfo("face", d.face, { area: d.face_area });
      toolbarStatus.textContent = `Named wall face ${d.face} - type a name`;
    } else {
      toolbarStatus.textContent = "Pick found no face/edge there.";
      return;
    }
    logConsole(
      "Pick ok: " +
        [
          d.face != null ? `face ${d.face}` : null,
          d.edge != null ? `edge ${d.edge}` : null,
        ]
          .filter(Boolean)
          .join(", "),
      "info"
    );
    // Keep pick mode active so several entities can be selected in a row:
    // a plain click replaces the selection, Ctrl/⌘+click adds to it. The mode
    // ends when the user switches Entity type to Off or toggles the button.
    saveAutosave();
  } catch (err) {
    // Fallback: still highlight the clicked element locally so the click is
    // never silently ignored when the worker/pick is unavailable.
    showLocalPickFallback(e);
    toolbarStatus.textContent = `Pick failed (${err.name === "AbortError" ? "mesh engine busy" : err.message}) — highlighted locally; retry when the engine is free.`;
    logConsole("Pick failed: " + err.message, "error");
  }
}

// Local, worker-independent highlight of the clicked triangle (fallback).
function showLocalPickFallback(e) {
  if (!currentMesh || !renderer) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(currentMesh.solid);
  if (!hits.length) return;
  const h = hits[0];
  if (h.face == null || !currentMesh.geometry.attributes.position) return;
  const pos = currentMesh.geometry.attributes.position;
  const idx = [h.face.a, h.face.b, h.face.c];
  const verts = [];
  idx.forEach((i) => verts.push(pos.getX(i), pos.getY(i), pos.getZ(i)));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  clearSelection();
  pickMarker = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
    color: 0x00e676, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: false,
  }));
  pickMarker.renderOrder = 999;
  scene.add(pickMarker);
}

function clearSelection() {
  if (pickMarker) scene.remove(pickMarker);
  if (pickLine) scene.remove(pickLine);
  if (pickLineHair) scene.remove(pickLineHair);
  pickMarker = null;
  pickLine = null;
  pickLineHair = null;
  clearVertexSelection();
}

function clearVertexSelection() {
  if (vertexSelMesh) { scene.remove(vertexSelMesh); vertexSelMesh = null; }
}

function vertexPositions() {
  if (!currentMesh || !currentMesh.geometry || !currentMesh.geometry.attributes || !currentMesh.geometry.attributes.position) return null;
  return currentMesh.geometry.attributes.position.array;
}

function pickNearestVertex(p) {
  const pos = vertexPositions();
  if (!pos) return -1;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const dx = pos[i] - p.x, dy = pos[i + 1] - p.y, dz = pos[i + 2] - p.z;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < bestD) { bestD = d; best = i / 3; }
  }
  return best;
}

function showVertexSelection(indices) {
  clearVertexSelection();
  if (!indices.length) return;
  const pos = vertexPositions();
  if (!pos) return;
  const pts = new Float32Array(indices.length * 3);
  indices.forEach((idx, k) => {
    pts[k * 3] = pos[idx * 3];
    pts[k * 3 + 1] = pos[idx * 3 + 1];
    pts[k * 3 + 2] = pos[idx * 3 + 2];
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pts, 3));
  vertexSelMesh = new THREE.Points(
    g,
    new THREE.PointsMaterial({ color: 0x00e676, size: 10, sizeAttenuation: false })
  );
  scene.add(vertexSelMesh);
}

/* Chain unordered segment pairs into an ordered polyline (so an edge can be
   traced as a single clean curve instead of a pile of loose segments). */
function chainSegments(segments) {
  const key = (p) => p[0].toFixed(6) + "," + p[1].toFixed(6) + "," + p[2].toFixed(6);
  const rest = segments.map((s) => [s[0].slice(), s[1].slice()]);
  if (!rest.length) return [];
  const chain = [rest[0][0], rest[0][1]];
  rest.splice(0, 1);
  let grew = true;
  while (rest.length && grew) {
    grew = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i][0];
      const b = rest[i][1];
      const head = chain[0];
      const tail = chain[chain.length - 1];
      if (key(a) === key(tail)) { chain.push(b); }
      else if (key(b) === key(tail)) { chain.push(a); }
      else if (key(b) === key(head)) { chain.unshift(a); }
      else if (key(a) === key(head)) { chain.unshift(b); }
      else { continue; }
      rest.splice(i, 1);
      grew = true;
      break;
    }
  }
  return chain;
}

/* Reference size of the displayed model (largest bbox dimension). */
function modelRef() {
  if (!currentMesh) return 1;
  currentMesh.geometry.computeBoundingBox();
  const s = currentMesh.geometry.boundingBox.getSize(new THREE.Vector3());
  return Math.max(s.x, s.y, s.z) || 1;
}

function showSelection(kind, point, facePoint, edgePoints, faceTriangles, edgeSegments) {
  clearSelection();
  const green = 0x00e676;
  if (kind === "face" && faceTriangles && faceTriangles.length) {
    // Highlight the ENTIRE face as a filled, semi-transparent surface.
    const verts = [];
    faceTriangles.forEach(([a, b, c]) => {
      verts.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({
      color: green, transparent: true, opacity: 0.55,
      side: THREE.DoubleSide, depthTest: false,
    });
    pickMarker = new THREE.Mesh(geo, mat);
    pickMarker.renderOrder = 999;
    scene.add(pickMarker);
  } else if (kind === "edge" && edgeSegments && edgeSegments.length) {
    // Trace ONLY this edge, as a thin tube along its real curve. WebGL ignores
    // LineBasicMaterial.linewidth (it stays a 1px hairline), so a tube is used
    // to make the outline clearly visible without filling anything.
    const ordered = chainSegments(edgeSegments);
    const pts = ordered.map((c) => new THREE.Vector3(c[0], c[1], c[2]));
    const ref = modelRef();
    const closed =
      pts.length > 3 && pts[0].distanceTo(pts[pts.length - 1]) < ref * 1e-4;
    if (closed) pts.pop();
    if (pts.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(pts, closed, "catmullrom", 0.5);
      const segs = Math.max(24, Math.min(600, pts.length * 2));
      const tube = new THREE.TubeGeometry(curve, segs, ref * 0.005, 8, closed);
      pickLine = new THREE.Mesh(
        tube,
        new THREE.MeshBasicMaterial({ color: green, depthTest: false, transparent: true, opacity: 0.95 })
      );
      pickLine.renderOrder = 999;
      scene.add(pickLine);
    }
    // A hairline on top keeps the exact geometry visible too.
    const verts = [];
    edgeSegments.forEach(([a, b]) => { verts.push(a[0], a[1], a[2], b[0], b[1], b[2]); });
    const hgeo = new THREE.BufferGeometry();
    hgeo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    pickLineHair = new THREE.LineSegments(
      hgeo,
      new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false })
    );
    pickLineHair.renderOrder = 1000;
    scene.add(pickLineHair);
  } else if (kind === "edge" && edgePoints && edgePoints.length > 1) {
    const pts = edgePoints.map((c) => new THREE.Vector3(c[0], c[1], c[2]));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    pickLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: green, depthTest: false }));
    scene.add(pickLine);
  } else {
    const geo = new THREE.SphereGeometry(1, 12, 12);
    const mat = new THREE.MeshBasicMaterial({ color: green });
    pickMarker = new THREE.Mesh(geo, mat);
    if (currentMesh) {
      pickMarker.scale.setScalar(modelRef() * 0.02);
    }
    const target = facePoint
      ? new THREE.Vector3(facePoint[0], facePoint[1], facePoint[2])
      : point;
    pickMarker.position.copy(target);
    scene.add(pickMarker);
  }
}

/* Selection info panel: type, tag, and geometric data (face area / edge length).
   The worker returns area/length in the MODEL's coordinate units; we convert
   them to the unit the user is currently displaying. */
let lastSelectionInfo = null;
function showSelectionInfo(type, tag, extra) {
  lastSelectionInfo = { type, tag, extra: extra || null };
  renderSelectionInfo();
}

function renderSelectionInfo() {
  const el = document.getElementById("sel-info");
  if (!el || !lastSelectionInfo) return;
  const { type, tag, extra } = lastSelectionInfo;
  const sym = unitSymbol();
  const from = UNIT_TO_M[modelUnit] || 1;
  const to = UNIT_TO_M[unitSystem.value] || 1;
  const lenF = from / to;
  const areaF = lenF * lenF;
  const fmt = (v) => {
    if (v === 0) return "0";
    const a = Math.abs(v);
    if (a >= 1e4 || a < 1e-3) return v.toExponential(4);
    return +v.toPrecision(6);
  };
  let html = `<div class="si-title">${type.toUpperCase()}</div>`;
  html += `<div class="si-row"><span>Tag</span><span>${tag}</span></div>`;
  if (extra && extra.area != null) {
    html += `<div class="si-row"><span>Area</span><span>${fmt(extra.area * areaF)} ${sym}&sup2;</span></div>`;
  }
  if (extra && extra.length != null) {
    html += `<div class="si-row"><span>Length</span><span>${fmt(extra.length * lenF)} ${sym}</span></div>`;
  }
  html += `<div class="si-row si-note"><span>Model units</span><span>${UNIT_SYMBOL[modelUnit] || modelUnit}</span></div>`;
  el.innerHTML = html;
  el.hidden = false;
}

/* ---- mesh quality dashboard ---- */
const QUALITY_LABELS = {
  skewness: "Skewness",
  aspect_ratio: "Aspect ratio",
  orthogonal_quality: "Orthogonal quality",
  jacobian_ratio: "Jacobian ratio",
};

function renderQuality(q) {
  const box = document.getElementById("quality");
  if (!q) {
    box.hidden = true;
    return;
  }
  box.innerHTML = "";
  for (const key of Object.keys(QUALITY_LABELS)) {
    const m = q[key];
    if (!m) continue;
    const ok = m.failed === 0;
    const row = document.createElement("div");
    row.className = "q-row";
    const limit = m.mode === "max" ? `≤ ${m.threshold}` : `≥ ${m.threshold}`;
    row.innerHTML =
      `<span class="q-name">${QUALITY_LABELS[key]}</span>` +
      `<span class="q-val">min ${m.min}</span>` +
      `<span class="q-val">max ${m.max}</span>` +
      `<span class="q-val">mean ${m.mean}</span>` +
      `<span class="q-limit">${limit}</span>` +
      `<span class="q-fail ${ok ? "ok" : "bad"}">${m.failed}/${m.count} fail</span>`;
    box.appendChild(row);
  }
  box.hidden = false;
}

/* ---- engine status ---- */
function setState(state, text) {
  engineState.dataset.state = state;
  engineState.textContent = text;
}

/* Loud banner so a dead/unreachable meshing engine is never a silent hang,
   with a one-click recovery action. */
function showBackendError(msg) {
  const el = document.getElementById("backend-banner");
  if (!el) return;
  el.innerHTML =
    "<span>MESH ENGINE UNAVAILABLE &mdash; " + msg + "</span> " +
    '<button id="restart-engine-btn" type="button">Restart mesh engine</button>' +
    "<br><code>The meshing worker is not responding. Click Restart above. If it stays down, " +
    "double-click <b>start-gmesh.bat</b> in the GMESH folder &mdash; its watchdog keeps the " +
    "server running by itself.</code>";
  el.hidden = false;
  const btn = document.getElementById("restart-engine-btn");
  if (btn) {
    btn.onclick = () => restartEngine();
  }
}
function clearBackendError() {
  const el = document.getElementById("backend-banner");
  if (el) el.hidden = true;
}

/* Kills the (possibly hung) worker and starts a fresh one, then re-checks. */
async function restartEngine() {
  setState("restarting", "Mesh engine: restarting\u2026");
  try {
    const res = await fetch("/api/restart-engine", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    logConsole("Mesh engine restart: " + (body.message || res.status), "info");
  } catch (e) {
    logConsole("Mesh engine restart failed: " + e.message, "error");
  }
  await checkEngine();
}

/* Clicking the engine badge restarts the engine when it is unreachable. */
engineState.addEventListener("click", () => {
  if (engineState.dataset.state === "error") restartEngine();
});

async function checkEngine() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch("/api/ping", { headers: { accept: "application/json" }, signal: ctrl.signal });
    const body = await res.json();
    if (body.status === "ok" && body.busy) {
      // A running mesh job occupies the single worker; that is normal, not an
      // outage. Never raise the "unavailable" banner while meshing.
      if (!body.gmsh_version) {
        // Still starting up: no version known yet.
        setState("checking", "Mesh engine: connecting\u2026");
      } else {
        setState("busy", "Mesh engine: busy (meshing\u2026)");
      }
      gmshVersion.textContent = `Mesh engine: Gmsh ${body.gmsh_version || "?"} (meshing)`;
      clearBackendError();
    } else if (body.status === "ok" && body.gmsh_version) {
      setState("ok", "Mesh engine: connected");
      gmshVersion.textContent = `Mesh engine: Gmsh ${body.gmsh_version} (live)`;
      clearBackendError();
    } else {
      setState("error", "Mesh engine: unreachable \u2014 click to restart");
      gmshVersion.textContent = `Mesh engine: ${body.message || "unknown error"}`;
      showBackendError(body.message || "the mesh engine reported an error");
    }
  } catch (err) {
    if (err.name === "AbortError") {
      // The server answered too slowly — that means it is up and working (a
      // long mesh occupies the single worker), NOT that it is unreachable.
      setState("busy", "Mesh engine: busy (meshing\u2026)");
      clearBackendError();
      return;
    }
    setState("error", "Mesh engine: unreachable \u2014 click to restart");
    gmshVersion.textContent = `Mesh engine: ${err.message}`;
    showBackendError(err.message);
  } finally {
    clearTimeout(timer);
  }
}
/* Re-check periodically so the banner clears by itself once the engine is back. */
setInterval(checkEngine, 15000);

/* Fast retry while the engine is still starting up, so the badge flips to
   "connected" within a fraction of a second of the worker being ready. */
let engineFastTries = 0;
const engineFastTimer = setInterval(async () => {
  engineFastTries += 1;
  const st = engineState.dataset.state;
  if (st === "ok" || engineFastTries > 40) {
    clearInterval(engineFastTimer);
    return;
  }
  await checkEngine();
}, 600);

/* ---- viewport (module scope so the generate handler can reach it) ---- */
let viewerReady = false;
let scene = null;
let camera = null;
let renderer = null;
let controls = null;
let stageBox = null;
let currentMesh = null;
let gridRef = null;
let axesRef = null;
let pickMode = null;
let pickMarker = null;
let pickLine = null;
let pickLineHair = null;
let vertexSelMesh = null;
let raycaster = null;
let orientScene = null;
let orientCamera = null;
let orientRenderer = null;
let orientAxes = null;
let orientYaw = new THREE.Group();
let orientPitch = new THREE.Group();
let orientParts = [];
let orientCyan = null;
let camAnim = null;

function initViewer() {
  if (typeof THREE === "undefined") {
    stageHint.textContent = "3D viewer failed to load (THREE.js unavailable — check network).";
    return;
  }
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x12151c);
  camera = new THREE.PerspectiveCamera(50, 1, 0.001, 10000);
  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);

  stageBox = document.createElement("div");
  stageBox.style.position = "absolute";
  stageBox.style.inset = "0";
  stage.appendChild(stageBox);
  stageBox.appendChild(renderer.domElement);

  controls = new THREE.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.1;
  // Standard CAD navigation (no mode switching): left-drag = rotate,
  // middle-drag (or Shift+left-drag) = pan, wheel = zoom.
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.PAN,
    RIGHT: THREE.MOUSE.PAN,
  };
  controls.screenSpacePanning = true; // free pan in screen space
  controls.enableZoom = true;
  controls.zoomSpeed = 1.0;
  controls.panSpeed = 1.0;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift" && controls) controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Shift" && controls) controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  });
  raycaster = new THREE.Raycaster();

  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(1, 1, 1);
  scene.add(dir);
  gridRef = new THREE.GridHelper(1, 10, 0x2a3140, 0x2a3140);
  axesRef = new THREE.AxesHelper(0.4);
  scene.add(gridRef);
  scene.add(axesRef);

  initOrient();
  renderer.domElement.addEventListener("pointerdown", onViewportClick);
  renderer.domElement.addEventListener("pointermove", (e) => {
    if (boxMode && boxStart) updateBox(e);
  });
  renderer.domElement.addEventListener("pointerup", handleViewportUp);
  renderer.domElement.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    if (!currentMesh) { showViewContextMenu(e, null); return; }
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(currentMesh.solid);
    let pickData = null;
    if (hits.length) {
      const p = hits[0].point;
      try {
        const res = await fetch("/api/pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ x: p.x, y: p.y, z: p.z }),
        });
        const body = await res.json();
        if (body.status === "ok") pickData = body.data;
      } catch (_) {}
    }
    showViewContextMenu(e, pickData);
  });
  zoomIn.addEventListener("click", () => zoomStep(0.8));
  zoomOut.addEventListener("click", () => zoomStep(1.25));
  gridToggle.addEventListener("click", () => {
    if (!gridRef || !axesRef) return;
    const show = !gridRef.visible;
    gridRef.visible = show;
    axesRef.visible = show;
    gridToggle.classList.toggle("active", show);
  });
  renderer.domElement.style.cursor = "grab";
  renderer.domElement.addEventListener("pointerdown", () => {
    renderer.domElement.style.cursor = "grabbing";
  });
  renderer.domElement.addEventListener("pointerup", () => {
    renderer.domElement.style.cursor = pickMode ? "crosshair" : "grab";
  });

  resize();
  window.addEventListener("resize", resize);
  animate();
  viewerReady = true;
}

function makeAxisLabel(text, color) {
  const c = document.createElement("canvas");
  c.width = 96;
  c.height = 96;
  const ctx = c.getContext("2d");
  ctx.font = "bold 68px Arial";
  ctx.fillStyle = "#" + color.toString(16).padStart(6, "0");
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 48, 52);
  const tex = new THREE.CanvasTexture(c);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  sprite.scale.set(0.32, 0.32, 1);
  return sprite;
}

function addOrientAxis(group, dir, color, len, label) {
  const d = new THREE.Vector3(...dir);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
  // Thick shaft (cylinder), oriented along the axis.
  const shaftLen = len * 0.68;
  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, shaftLen, 16),
    new THREE.MeshBasicMaterial({ color, depthTest: false })
  );
  shaft.quaternion.copy(q);
  shaft.position.copy(d).multiplyScalar(shaftLen / 2);
  // Cone head at the tip.
  const headLen = 0.22;
  const head = new THREE.Mesh(
    new THREE.ConeGeometry(0.12, headLen, 20),
    new THREE.MeshBasicMaterial({ color, depthTest: false })
  );
  head.quaternion.copy(q);
  head.position.copy(d).multiplyScalar(len * 0.68 + headLen * 0.45);
  // Small sphere marker at the arrow tip.
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.075, 16, 16),
    new THREE.MeshBasicMaterial({ color, depthTest: false })
  );
  tip.position.copy(d).multiplyScalar(len * 0.68 + headLen * 0.95);
  // Letter label past the tip.
  const sprite = makeAxisLabel(label, color);
  sprite.position.copy(d).multiplyScalar(len + 0.16);
  [shaft, head, tip, sprite].forEach((m) => { m.userData.orientAxis = label.toLowerCase(); });
  group.add(shaft, head, tip, sprite);
  orientParts.push(shaft, head, tip, sprite);
}

function initOrient() {
  if (!orientWidget) return;
  try {
    orientScene = new THREE.Scene();
    orientCamera = new THREE.PerspectiveCamera(45, 1, 0.01, 10);
    orientCamera.position.set(0, 0, 3);
    orientCamera.lookAt(0, 0, 0);
    orientRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    orientRenderer.setSize(110, 110);
    orientWidget.appendChild(orientRenderer.domElement);

    // The triad lives at world axes; the widget camera mirrors the main camera.
    orientPitch = new THREE.Group();
    orientYaw = new THREE.Group();
    orientPitch.add(orientYaw);
    orientScene.add(orientPitch);

    const LEN = 0.9;
    const AXIS = {
      x: { dir: [1, 0, 0], color: 0xff3b30, label: "X" },
      y: { dir: [0, 1, 0], color: 0x34c759, label: "Y" },
      z: { dir: [0, 0, 1], color: 0x0a84ff, label: "Z" },
    };
    orientParts = [];
    for (const key of ["x", "y", "z"]) {
      const a = AXIS[key];
      addOrientAxis(orientYaw, a.dir, a.color, LEN, a.label);
    }
    // Cyan origin marker at the centre (click does nothing, drag free-rotates).
    orientCyan = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 20, 20),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, depthTest: false })
    );
    orientCyan.userData.orientAxis = "free";
    orientScene.add(orientCyan);

    bindOrientEvents();
  } catch (err) {
    console.warn("orientation widget unavailable:", err);
    orientRenderer = null;
  }
}

function bindOrientEvents() {
  if (!orientWidget || !orientRenderer) return;
  const el = orientRenderer.domElement;
  let down = null;
  let ray = new THREE.Raycaster();
  const ndc = (e) => {
    const r = el.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  const pick = (e) => {
    ray.setFromCamera(ndc(e), orientCamera);
    const hits = ray.intersectObjects(orientParts.concat(orientCyan), true);
    return hits.length ? hits[0].object : null;
  };
  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    down = { x: e.clientX, y: e.clientY, obj: pick(e) };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (!down) return;
    const dx = e.clientX - down.x;
    const dy = e.clientY - down.y;
    // Free-rotate by dragging anywhere on the widget.
    if (Math.hypot(dx, dy) > 3) down.dragged = true;
    rotateCamera(dx, dy);
    down.x = e.clientX;
    down.y = e.clientY;
  });
  el.addEventListener("pointerup", (e) => {
    if (!down) return;
    const wasDrag = down.dragged;
    const obj = down.obj;
    down = null;
    // Clicking an axis arrow/ball snaps to that axis view; clicking the
    // center (cyan) ball snaps to Isometric (same snapToIso as the Iso button).
    if (!wasDrag && obj && obj.userData.orientAxis) {
      if (obj.userData.orientAxis === "free") {
        snapToIso();
      } else {
        snapToAxis(obj.userData.orientAxis);
      }
    }
  });
  el.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    resetView();
  });
}

function rotateCamera(dx, dy) {
  if (!controls || !camera) return;
  const target = controls.target;
  const offset = camera.position.clone().sub(target);
  const sph = new THREE.Spherical().setFromVector3(offset);
  sph.theta += dx * 0.008;
  sph.phi -= dy * 0.008;
  sph.phi = Math.max(0.02, Math.min(Math.PI - 0.02, sph.phi));
  offset.setFromSpherical(sph);
  camera.position.copy(target).add(offset);
  camera.lookAt(target);
  controls.update();
}

function snapToAxis(axis) {
  if (!camera || !controls) return;
  const dirs = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const dir = new THREE.Vector3(...dirs[axis]);
  const target = controls.target;
  const dist = camera.position.distanceTo(target) || 3;
  const to = target.clone().addScaledVector(dir, dist);
  const m = new THREE.Matrix4().lookAt(to, target, camera.up);
  const toQuat = new THREE.Quaternion().setFromRotationMatrix(m);
  camAnim = {
    fromPos: camera.position.clone(),
    fromQuat: camera.quaternion.clone(),
    toPos: to.clone(),
    toQuat,
    t: 0,
    dur: 0.35,
  };
}

// Isometric corner view (equal angle to all three axes).
function snapToIso() {
  if (!camera || !controls) return;
  const target = controls.target;
  const dist = camera.position.distanceTo(target) || 3;
  const dir = new THREE.Vector3(1, 1, 1).normalize();
  const to = target.clone().addScaledVector(dir, dist);
  const m = new THREE.Matrix4().lookAt(to, target, camera.up);
  camAnim = {
    fromPos: camera.position.clone(),
    fromQuat: camera.quaternion.clone(),
    toPos: to.clone(),
    toQuat: new THREE.Quaternion().setFromRotationMatrix(m),
    t: 0,
    dur: 0.35,
  };
}

function resetView() {
  if (!currentMesh) return;
  geometry_to_camera(currentMesh.geometry);
}

function zoomStep(scale) {
  if (!controls || !camera) return;
  const target = controls.target;
  const dir = new THREE.Vector3().subVectors(target, camera.position);
  const dist = dir.length();
  const newDist = dist * scale;
  if (newDist <= 1e-6) return;
  dir.normalize();
  camera.position.copy(target).addScaledVector(dir, -newDist);
  controls.update();
}

function geometry_to_camera(geometry) {
  fitCamera(geometry);
}

function fitCamera(geometry) {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  const center = new THREE.Vector3();
  bb.getCenter(center);
  const size = bb.getSize(new THREE.Vector3());
  // Bounding-sphere radius = half the box diagonal, so the entire model is
  // guaranteed to be enclosed regardless of shape (elongated or not).
  const radius = size.length() * 0.5;
  if (radius <= 1e-9) return;
  // Margin so the model never touches the viewport edge.
  const margin = 1.12;
  const dist = (radius * margin) / Math.sin((camera.fov * Math.PI) / 360);
  // Iso-ish viewing direction; frames the model without aligning to an axis.
  const dir = new THREE.Vector3(1, 0.9, 1).normalize();
  camera.position.copy(center).addScaledVector(dir, dist);
  camera.near = Math.max(dist / 100, 1e-4);
  camera.far = dist * 60 + radius * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();

  // Scale the reference grid/axes to the model so small parts are not dwarfed.
  const ref = Math.max(size.x, size.y, size.z);
  if (gridRef) {
    gridRef.scale.setScalar(ref);
    gridRef.position.set(center.x, bb.min.y, center.z);
  }
  if (axesRef) {
    axesRef.scale.setScalar(ref * 0.25);
    axesRef.position.copy(center);
  }
}

function loadPreview(url, raw) {
  const loader = new THREE.STLLoader();
  loader.load(
    url,
    (geometry) => {
      try {
        geometry.computeVertexNormals();

        // Shaded solid surface (ANSYS-like neutral grey), pushed slightly back
        // with polygon offset so the wireframe lines render cleanly on top.
        const solidMaterial = new THREE.MeshStandardMaterial({
          color: raw ? 0x7fa6c9 : 0xbfc6cf,
          side: THREE.DoubleSide,
          flatShading: true,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
          transparent: !!raw,
          opacity: raw ? 0.65 : 1.0,
        });
        const solid = new THREE.Mesh(geometry, solidMaterial);

        // Black wireframe showing every individual mesh element edge. Only
        // rendered for a generated mesh, not for the raw imported geometry.
        let wire = null;
        if (!raw) {
          const wireMaterial = new THREE.MeshBasicMaterial({
            color: 0x000000,
            wireframe: true,
            side: THREE.DoubleSide,
          });
          wire = new THREE.Mesh(geometry, wireMaterial);
          // If the surface was quad-recombined, draw the REAL quad grid: an STL
          // carries only triangles, so the triangle wireframe would hide it.
          const m = /^\/preview\/(\d+)\/mesh\.stl$/.exec(url || "");
          if (m) {
            fetch(`/preview/${m[1]}/quads.json`)
              .then((r) => (r.ok ? r.json() : null))
              .then((q) => {
                if (!q || !q.edges || !q.edges.length || !currentMesh) return;
                const verts = [];
                q.edges.forEach(([a, b]) => verts.push(a[0], a[1], a[2], b[0], b[1], b[2]));
                const g = new THREE.BufferGeometry();
                g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
                const quadWire = new THREE.LineSegments(
                  g,
                  new THREE.LineBasicMaterial({ color: 0x000000 })
                );
                if (currentMesh.wire) scene.remove(currentMesh.wire);
                scene.add(quadWire);
                currentMesh.wire = quadWire;
                logConsole(
                  `Surface quad grid: ${q.edges.length} quad edges (4-sided cells), drawn from the recombined surface.`,
                  "info"
                );
              })
              .catch(() => {});
          }
        }

        // Add the new mesh BEFORE removing the old one, so if anything goes
        // wrong the previous body stays on screen.
        scene.add(solid);
        if (wire) scene.add(wire);
        clearPreview();
        currentMesh = { solid, wire, geometry };
        fitCamera(geometry);
        stageHint.style.display = "none";
        if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
        // Refresh the face/edge inventory so box selection works even before
        // a mesh has been generated in this browser session.
        fetchEntities();
      } catch (err) {
        console.error("loadPreview failed:", err);
        toolbarStatus.textContent = "Preview load error.";
      }
    },
    undefined,
    (err) => {
      toolbarStatus.textContent = "Failed to load preview.";
      console.error(err);
    }
  );
}

function clearPreview() {
  if (!currentMesh) return;
  scene.remove(currentMesh.solid);
  if (currentMesh.wire) scene.remove(currentMesh.wire);
  currentMesh.geometry.dispose();
  currentMesh = null;
  clearSelection();
}

/* Reset all generated-mesh output so an import never looks like a result. */
function clearMeshResult() {
  meshStats.textContent = "";
  renderQuality(null);
  updateStats({});
  fileMsh.hidden = true;
  fileMsh.dataset.url = "";
  fileStl.hidden = true;
  fileStl.dataset.url = "";
  if (minEdge) minEdge.textContent = "\u2014";
}

function resize() {
  if (!stageBox) return;
  const w = stageBox.clientWidth;
  const h = stageBox.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  if (controls) controls.update();
  // Smooth camera snap-to-axis animation.
  if (camAnim) {
    camAnim.t += 0.016;
    const k = Math.min(1, camAnim.t / camAnim.dur);
    const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
    camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, e);
    camera.quaternion.slerpQuaternions(camAnim.fromQuat, camAnim.toQuat, e);
    if (k >= 1) camAnim = null;
  }
  if (renderer && scene && camera) renderer.render(scene, camera);
  // Orientation widget: place the widget camera in the same relative direction
  // as the main camera and look at the triad origin, so the triad mirrors the
  // live view (correct centring for any viewing angle).
  if (orientRenderer && orientScene && controls) {
    const offset = camera.position.clone().sub(controls.target);
    const dir = offset.lengthSq() > 1e-8 ? offset.normalize() : new THREE.Vector3(0, 0, 1);
    orientCamera.position.copy(dir).multiplyScalar(3);
    orientCamera.up.copy(camera.up);
    orientCamera.lookAt(0, 0, 0);
    orientCamera.updateMatrixWorld();
    orientRenderer.render(orientScene, orientCamera);
  }
}

/* ---- file selection (attached before viewport init so the Import STL
   button always works, even if 3D/WebGL initialisation fails) ---- */
importBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  if (fileInput.files && fileInput.files.length) {
    pendingFile = fileInput.files[0];
    // New geometry: drop every geometry-scoped selection so stale face/edge
    // tags from the previous STL can't leak into the mesh job
    // (avoids "Unknown model face with tag N").
    clearNamedSelections();
    clearRows(regionsBox);
    clearVertexSelection();
    clearSelection();
    const si = document.getElementById("sel-info");
    if (si) si.hidden = true;
    clearMeshResult();
    loadPreview(URL.createObjectURL(pendingFile), true);
    toolbarStatus.textContent = `Geometry loaded: ${pendingFile.name} — click "Generate Mesh" to mesh it.`;
    logConsole(`Geometry loaded: ${pendingFile.name}. Cleared previous selections/sizing. Click "Generate Mesh" to mesh it.`, "info");
    const reader = new FileReader();
    reader.onload = () => {
      pendingFileData = String(reader.result).split(",")[1] || "";
      saveAutosave();
    };
    reader.readAsDataURL(pendingFile);
    // Scale the default element size to the geometry's smallest dimension.
    const statsReader = new FileReader();
    statsReader.onload = () => {
      try {
        stlStats = computeStlStats(statsReader.result);
        applySuggestedSize(stlStats);
        saveAutosave();
      } catch (e) {
        console.warn("geometry stats failed:", e);
      }
    };
    statsReader.readAsArrayBuffer(pendingFile);
  }
});

/* ---- save / load project ---- */
function clearRows(container) {
  container.innerHTML = "";
  container.hidden = true;
}

function serializeProject() {
  if (!pendingFile) return null;
  const namedSelections = collectNamedSelections();
  return {
    format: "gmesh-project",
    version: 2,
    geometry: { filename: pendingFile.name, data: pendingFileData || "" },
    defaults: {
      physics: physics.value,
      relevance_num: relevanceNum.value,
      unit_system: unitSystem.value,
      angle_unit: angleUnit.value,
    },
    sizing: {
      global_size: sizeGlobal.value,
      advanced_size_function: advSizeFn.value,
      relevance: relevance.value,
      size_seed: sizeSeed.value,
      smoothing: smoothing.value,
      transition: transitionSel.value,
      span_angle_center: spanCenter.value,
      curv_angle: curvAngle.value,
      size_min: sizeMin.value,
      size_face: sizeFace.value,
      size_max: sizeMax.value,
      growth_rate: growthRate.value,
    },
    volume: volumeEnable.checked,
    boundary_layer:
      blAuto.value !== "none"
        ? {
            auto: blAuto.value,
            option: blOption.value,
            layers: blLayers.value,
            first: blFirst.value,
            growth: blGrowth.value,
            total: blTotal.value,
            max_layers: blMax.value,
            walls: namedSelections
              .filter((s) => s.use && s.use.wall)
              .map((s) => s.tag),
          }
        : null,
    patch_conforming: { surface_algorithm: surfaceAlgo.value },
    mesh: {
      method: meshMethod.value,
      surface_type: surfaceType.value,
      export_format: exportFormat.value,
    },
    regions: collectRegions(),
    named_selections: namedSelections,
    sizing_controls: sizingRecords,
  };
}

function saveProject() {
  if (!pendingFile) {
    toolbarStatus.textContent = "Import an STL before saving a project.";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingFileData = String(reader.result).split(",")[1] || "";
    const project = serializeProject();
    const blob = new Blob([JSON.stringify(project, null, 2)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download =
      (pendingFile.name.replace(/\.stl$/i, "") || "gmesh") + ".gmesh.json";
    a.click();
    URL.revokeObjectURL(a.href);
    addRecent(project);
    toolbarStatus.textContent = "Project saved.";
  };
  reader.readAsDataURL(pendingFile);
}

function applyProject(p) {
  if (p.format !== "gmesh-project") throw new Error("not a GMESH project file");
  if (p.defaults) {
    physics.value = p.defaults.physics || "mechanical";
    relevanceNum.value = p.defaults.relevance_num ?? 100;
    unitSystem.value = p.defaults.unit_system || "m";
    angleUnit.value = p.defaults.angle_unit || "deg";
    currentUnit = unitSystem.value;
    currentAngleUnit = angleUnit.value;
  }
  if (p.sizing) {
    sizeGlobal.value = p.sizing.global_size ?? 0.02;
    advSizeFn.value = p.sizing.advanced_size_function || "off";
    relevance.value = p.sizing.relevance || "medium";
    sizeSeed.value = p.sizing.size_seed ?? "";
    smoothing.value = p.sizing.smoothing || "none";
    transitionSel.value = p.sizing.transition || "fast";
    spanCenter.value = p.sizing.span_angle_center || "medium";
    curvAngle.value = p.sizing.curv_angle ?? 30;
    sizeMin.value = p.sizing.size_min ?? 0.001;
    sizeFace.value = p.sizing.size_face ?? 0.02;
    sizeMax.value = p.sizing.size_max ?? 0.02;
    growthRate.value = p.sizing.growth_rate ?? 1.2;
  }
  volumeEnable.checked = !!p.volume;
  if (p.boundary_layer) {
    blAuto.value = p.boundary_layer.auto || "all_faces";
    blOption.value = p.boundary_layer.option || "smooth_transition";
    blLayers.value = p.boundary_layer.layers ?? 5;
    blFirst.value = p.boundary_layer.first ?? 0.001;
    blGrowth.value = p.boundary_layer.growth ?? 1.2;
    blTotal.value = p.boundary_layer.total ?? "";
    blMax.value = p.boundary_layer.max_layers ?? "";
  } else {
    blAuto.value = "none";
  }
  if (p.patch_conforming) {
    surfaceAlgo.value = p.patch_conforming.surface_algorithm || "program_controlled";
  }
  if (p.mesh) {
    meshMethod.value = p.mesh.method || "tet";
    surfaceType.value = p.mesh.surface_type || "tri";
    exportFormat.value = p.mesh.export_format || "msh";
  }
  clearRows(regionsBox);
  (p.regions || []).forEach((r) => addRegion(r));
  clearNamedSelections();
  if (Array.isArray(p.named_selections)) {
    p.named_selections.forEach((s) => {
      const useWall = !!(s.use && s.use.wall) || s.type === "wall";
      const row = addNamedSelection(s.type || "face", s.tag, s.size || "", useWall);
      if (s.name) row.querySelector('[data-k="name"]').value = s.name;
      const sizingCb = row.querySelector('[data-k="use-sizing"]');
      if (sizingCb && s.use) sizingCb.checked = !!s.use.sizing;
    });
  } else {
    (p.edge_sizes || []).forEach((s) => addNamedSelection("edge", s.tag, s.size));
    (p.face_sizes || []).forEach((s) => addNamedSelection("face", s.tag, s.size));
    ((p.boundary_layer && p.boundary_layer.walls) || []).forEach((t) =>
      addNamedSelection("wall", t, "")
    );
  }
  // Independent sizing controls.
  sizingRecords = Array.isArray(p.sizing_controls) ? p.sizing_controls.slice() : [];
  sizingSeq = sizingRecords.length + 1;
  renderSizingList();
  if (p.geometry && p.geometry.data) {
    const bin = atob(p.geometry.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File(
      [new Blob([bytes], { type: "model/stl" })],
      p.geometry.filename || "geometry.stl",
      { type: "model/stl" }
    );
    pendingFile = file;
    pendingFileData = p.geometry.data;
    loadPreview(URL.createObjectURL(file), true);
    updateUnitLabels();
    return true;
  }
  updateUnitLabels();
  return false;
}

function loadProject(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const p = JSON.parse(reader.result);
      const hasGeom = applyProject(p);
      toolbarStatus.textContent = hasGeom
        ? `Loaded project (${p.geometry.filename}).`
        : "Loaded project settings (re-import the STL to generate).";
    } catch (err) {
      toolbarStatus.textContent = `Load failed: ${err.message}`;
    }
  };
  reader.readAsText(file);
}

/* ---- autosave + recent projects (localStorage) ---- */
const LS_AUTOSAVE = "gmesh.autosave";
const LS_RECENT = "gmesh.recent";
let autosaveTimer = null;

function saveAutosave() {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    const project = serializeProject();
    if (!project) return;
    try {
      localStorage.setItem(LS_AUTOSAVE, JSON.stringify(project));
    } catch (e) {}
  }, 400);
}

function getAutosave() {
  try {
    const raw = localStorage.getItem(LS_AUTOSAVE);
    if (!raw) return null;
    const p = JSON.parse(raw);
    return p && p.format === "gmesh-project" ? p : null;
  } catch (e) {
    return null;
  }
}

function addRecent(project) {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(LS_RECENT) || "[]");
  } catch (e) {
    list = [];
  }
  const name = (project.geometry && project.geometry.filename) || "project";
  list = list.filter((x) => x.name !== name);
  list.unshift({ name, data: project, at: Date.now() });
  list = list.slice(0, 10);
  try {
    localStorage.setItem(LS_RECENT, JSON.stringify(list));
  } catch (e) {}
  renderRecent();
}

function getRecent() {
  try {
    return JSON.parse(localStorage.getItem(LS_RECENT) || "[]");
  } catch (e) {
    return [];
  }
}

function renderRecent() {
  const menu = document.getElementById("recent-menu");
  if (!menu) return;
  const list = getRecent();
  if (!list.length) {
    menu.innerHTML = '<div class="recent-empty">No recent projects.</div>';
    menu.hidden = false;
    return;
  }
  menu.innerHTML = "";
  list.forEach((entry) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "recent-item";
    btn.textContent = entry.name;
    btn.addEventListener("click", () => {
      try {
        applyProject(entry.data);
        toolbarStatus.textContent = `Opened recent: ${entry.name}`;
        menu.hidden = true;
      } catch (err) {
        toolbarStatus.textContent = `Recent load failed: ${err.message}`;
      }
    });
    menu.appendChild(btn);
  });
  menu.hidden = false;
}

loadProjectInput.addEventListener("change", () => {
  if (loadProjectInput.files && loadProjectInput.files.length) {
    loadProject(loadProjectInput.files[0]);
    loadProjectInput.value = "";
  }
});

// Apply the default selection mode (Face / Single) now that all module
// bindings (pickMode, renderer, ...) are initialized.
updateSelection();

try {
  initViewer();
} catch (err) {
  console.error("3D viewer initialisation failed:", err);
}

/* ---- recent projects (corner) ---- */
const recentBtn = document.getElementById("recent-btn");
const recentMenu = document.getElementById("recent-menu");
recentBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (recentMenu.hidden) renderRecent();
  else recentMenu.hidden = true;
});
document.addEventListener("click", (e) => {
  if (
    !recentMenu.hidden &&
    !recentMenu.contains(e.target) &&
    e.target !== recentBtn
  ) {
    recentMenu.hidden = true;
  }
});

/* ---- autosave triggers ---- */
document.addEventListener("input", saveAutosave);
document.addEventListener("change", saveAutosave);


/* ---- generate surface mesh ---- */
function logConsole(msg, type) {
  // Mirror into the real browser console so DevTools shows the same log.
  if (type === "error") console.error(msg);
  else console.log(msg);
  if (!consoleBody) return;
  const line = document.createElement("div");
  line.className = "line " + (type || "info");
  line.textContent = msg;
  consoleBody.appendChild(line);
  while (consoleBody.childNodes.length > 200) consoleBody.removeChild(consoleBody.firstChild);
  consoleBody.scrollTop = consoleBody.scrollHeight;
}

/* A single, updateable console line for live progress percentage. */
let progressLineEl = null;
function logProgress(msg) {
  if (!consoleBody) return;
  if (!progressLineEl || !consoleBody.contains(progressLineEl)) {
    progressLineEl = document.createElement("div");
    progressLineEl.className = "line info";
    consoleBody.appendChild(progressLineEl);
  }
  progressLineEl.textContent = msg;
  consoleBody.scrollTop = consoleBody.scrollHeight;
}

function updateStats(s) {
  const set = (el, v) => { if (el) el.textContent = v; };
  set(statNodes, s.nodes ?? "—");
  set(statElems, s.elements_2d ?? "—");
  set(statTris, s.triangles ?? "—");
  set(statQuads, s.quads ?? "—");
  set(statTets, s.volume_tets ?? "—");
  set(statHexes, s.volume_hexes ?? "—");
  set(statPrisms, s.volume_prisms ?? "—");
  set(minEdge, s.minimum_edge_length != null ? s.minimum_edge_length + " " + unitSymbol() : "—");
}

const PHYSICS_DEFAULTS = {
  mechanical: { global: 0.02, min: 0.001, face: 0.02, max: 0.02, growth: 1.2, curv: 30 },
  cfd: { global: 0.01, min: 0.0005, face: 0.01, max: 0.01, growth: 1.2, curv: 20 },
  electromagnetics: { global: 0.05, min: 0.005, face: 0.05, max: 0.05, growth: 1.3, curv: 45 },
};

/* ---- units (display/interpretation only; Gmsh is unit-agnostic) ---- */
const UNIT_TO_M = { m: 1, mm: 0.001, cm: 0.01, ft: 0.3048, in: 0.0254 };
const UNIT_SYMBOL = { m: "m", mm: "mm", cm: "cm", ft: "ft", in: "in" };
let currentUnit = unitSystem.value;
// Unit the geometry was meshed in; pick results (area/length) are in these
// units, so the info panel converts from this to the currently displayed unit.
let modelUnit = unitSystem.value;
let currentAngleUnit = angleUnit.value;
const LENGTH_FIELDS = [sizeGlobal, sizeMin, sizeMax, sizeFace, sizeSeed, blFirst, blTotal];
function unitSymbol() { return UNIT_SYMBOL[unitSystem.value] || "m"; }
function toDeg(v) { return angleUnit.value === "rad" ? v * 180 / Math.PI : v; }
function fromDeg(deg) { return angleUnit.value === "rad" ? +(deg * Math.PI / 180).toPrecision(6) : deg; }
function updateUnitLabels() {
  const sym = unitSymbol();
  document.querySelectorAll(".field").forEach((f) => {
    f.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.includes("(m)")) {
        node.textContent = node.textContent.split("(m)").join("(" + sym + ")");
      }
    });
  });
}
unitSystem.addEventListener("change", () => {
  const factor = UNIT_TO_M[currentUnit] / UNIT_TO_M[unitSystem.value];
  LENGTH_FIELDS.forEach((el) => {
    if (!el) return;
    const v = parseFloat(el.value);
    if (Number.isFinite(v)) el.value = +(v * factor).toPrecision(6);
  });
  currentUnit = unitSystem.value;
  updateUnitLabels();
  renderSelectionInfo();
  saveAutosave();
});
angleUnit.addEventListener("change", () => {
  const v = parseFloat(curvAngle.value);
  if (Number.isFinite(v)) {
    if (currentAngleUnit === "deg" && angleUnit.value === "rad") curvAngle.value = +(v * Math.PI / 180).toPrecision(6);
    else if (currentAngleUnit === "rad" && angleUnit.value === "deg") curvAngle.value = +(v * 180 / Math.PI).toPrecision(6);
  }
  currentAngleUnit = angleUnit.value;
  saveAutosave();
});

function applyPhysicsDefaults() {
  const d = PHYSICS_DEFAULTS[physics.value] || PHYSICS_DEFAULTS.mechanical;
  const f = UNIT_TO_M[unitSystem.value];
  sizeGlobal.value = +(d.global / f).toPrecision(6);
  sizeMin.value = +(d.min / f).toPrecision(6);
  sizeFace.value = +(d.face / f).toPrecision(6);
  sizeMax.value = +(d.max / f).toPrecision(6);
  growthRate.value = d.growth;
  if (advSizeFn.value === "curvature") curvAngle.value = fromDeg(d.curv);
}
physics.addEventListener("change", () => {
  applyPhysicsDefaults();
  logConsole("Physics preference: " + physics.value + " (Gmsh is physics-agnostic — sensible size defaults applied)", "info");
});

const SPAN_ANGLE = { coarse: 90, medium: 30, fine: 18 };
function applySpanCenter() {
  if (advSizeFn.value === "curvature") curvAngle.value = fromDeg(SPAN_ANGLE[spanCenter.value] || 30);
}
spanCenter.addEventListener("change", applySpanCenter);
advSizeFn.addEventListener("change", applySpanCenter);
updateUnitLabels();

async function runMesh() {
  if (!viewerReady) {
    toolbarStatus.textContent = "Viewer unavailable.";
    return;
  }
  if (!pendingFile) {
    toolbarStatus.textContent = "Choose an STL first.";
    return;
  }

  const factor = RELEVANCE_FACTOR[relevance.value] || 1.0;
  // Hard ceiling: the element size may never exceed 1/10 of the geometry's
  // smallest real dimension, whatever the Relevance slider says.
  const cap = suggestedElementSize(stlStats) || Infinity;
  // The Global Element Size field IS the element size that is sent — read
  // verbatim, no silent Relevance scaling. Relevance only shapes the AUTO
  // default when the geometry is imported.
  const globalSize = Math.min(parseFloat(sizeGlobal.value) || 0.02, cap);
  // Gmsh's MeshSizeMax drives the actual element size, so it must be the
  // global size — otherwise a stale/auto-filled Max field silently overrides
  // what the user typed. Min is the lower bound (defaults to global/5).
  const maxSize = globalSize;
  const faceSize = globalSize;
  const effectiveMax = globalSize;
  const minField = parseFloat(sizeMin.value);
  const minSize = Math.min(
    Number.isFinite(minField) && minField > 0 ? minField : globalSize / 5,
    globalSize
  );
  const curvAngleVal = toDeg(parseFloat(curvAngle.value) || 0);
  const curvEls = curvAngleVal > 0 && curvAngleVal < 180 ? Math.round(360 / curvAngleVal) : 0;
  const adv = advSizeFn.value;
  const seed = parseFloat(sizeSeed.value) || 0;

  const form = new FormData();
  form.append("geo", pendingFile);
  // The mesh is generated in the currently selected unit; record it so pick
  // results (area/length) can be converted for display afterwards.
  modelUnit = unitSystem.value;
  form.append("size", String(globalSize));
  form.append("size_seed", String(seed));
  form.append("size_max", String(effectiveMax));
  form.append("size_min", String(minSize));
  form.append("growth_rate", String(parseFloat(growthRate.value) || 1.2));
  form.append("advanced_size_function", adv);
  form.append("curvature", adv === "curvature" ? String(curvEls) : "0");
  form.append("proximity", adv === "proximity" ? "5" : "0");
  form.append("smoothing", smoothing.value);
  form.append("transition", transitionSel.value);
  form.append("span_angle_center", spanCenter.value);
  form.append("surface_algorithm", surfaceAlgo.value);
  form.append("volume", volumeEnable.checked ? "true" : "false");
  form.append("mesh_method", meshMethod.value);
  form.append("recombine", surfaceType.value === "quad" ? "true" : "false");
  if (meshMethod.value === "revolve") {
    form.append("revolve_axis", revolveAxis.value);
    form.append("revolve_layers", String(parseInt(revolveLayers.value, 10) || 24));
  }
  if (meshMethod.value === "sweep") {
    if (sweepSource != null) form.append("sweep_source", JSON.stringify([sweepSource]));
    if (sweepTarget != null) form.append("sweep_target", String(sweepTarget));
    form.append("sweep_layers", String(parseInt(sweepLayers.value, 10) || 5));
  }
  form.append("export_format", exportFormat.value);
  form.append("regions", JSON.stringify(collectRegions()));
  const namedSelections = collectNamedSelections();
  const edgeSizes = namedSelections
    .filter((s) => s.type === "edge" && s.size != null)
    .map((s) => ({ tag: s.tag, size: s.size }));
  const faceSizes = namedSelections
    .filter((s) => s.type === "face" && s.size != null)
    .map((s) => ({ tag: s.tag, size: s.size }));
  // Independent sizing controls (ANSYS-style) feed the same size fields.
  sizingRecords.forEach((r) => {
    if (r.type !== "element_size" || !Number.isFinite(r.size)) return;
    (r.kind === "edge" ? edgeSizes : faceSizes).push({ tag: r.tag, size: r.size });
  });
  form.append("edge_sizes", JSON.stringify(edgeSizes));
  form.append("face_sizes", JSON.stringify(faceSizes));
  // Forward the full named selections (name + type + tag) so the worker can
  // create Gmsh Physical Groups and write them to the .msh $PhysicalNames.
  form.append(
    "named_selections",
    JSON.stringify(
      namedSelections
        .filter((s) => s.tag != null)
        .map((s) => ({ name: s.name, type: s.type, tag: s.tag }))
    )
  );
  if (blAuto.value !== "none") {
    form.append(
      "boundary_layer",
      JSON.stringify({
        auto: blAuto.value,
        option: blOption.value,
        faces: namedSelections
          .filter((s) => s.use && s.use.wall && s.tag != null)
          .map((s) => s.tag),
        layers: parseInt(blLayers.value, 10) || 5,
        first: parseFloat(blFirst.value) || 0.001,
        growth: parseFloat(blGrowth.value) || 1.2,
        total: parseFloat(blTotal.value) || 0,
        max_layers: parseInt(blMax.value, 10) || 0,
      })
    );
  }

  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  form.append("token", token);
  const controller = new AbortController();
  currentAbort = controller;
  progressLineEl = null;
  generateBtn.disabled = true;
  updateBtn.disabled = true;
  stopBtn.disabled = false;
  toolbarStatus.textContent = "Generating mesh…";
  logConsole(
    `Generating… element size ${globalSize} ${unitSymbol()} (max ${effectiveMax}, min ${minSize}) · adv ${adv} · smoothing ${smoothing.value} · surface ${surfaceAlgo.value}`,
    "info"
  );

  const pollProgress = async () => {
    try {
      const res = await fetch("/api/progress/" + token);
      if (res.ok) {
        const p = await res.json();
        if (p && p.percent != null) {
          logProgress(`Meshing… ${p.percent}% (${p.stage || "working"})`);
        }
      }
    } catch (_) {}
  };
  const pollTimer = setInterval(pollProgress, 600);

  setState("busy", "Mesh engine: busy (meshing\u2026)");
  try {
    const res = await fetch("/api/mesh", { method: "POST", body: form, signal: controller.signal });
    const body = await res.json();
    if (body.status === "ok") {
      const s = body.stats || {};
      logProgress("Meshing… 100% (Done)");
      const prisms = s.volume_prisms ? ` / ${s.volume_prisms} prisms` : "";
      const vol = s.volume ? ` · Volume: ${s.volume_nodes} nodes / ${s.volume_tets} tets / ${s.volume_hexes ?? 0} hexes${prisms}` : "";
      const perf = ` · ${(s.generation_seconds || 0).toFixed(2)} s · ${s.memory_mb ?? "?"} MB`;
      meshStats.textContent =
        `Nodes ${s.nodes} · Surface elems ${s.elements_2d} (${s.triangles} triangles)` +
        `${vol} · size ${effectiveMax} ${unitSymbol()}${perf}`;
      if (body.export_url || body.msh_url) {
        fileMsh.hidden = false;
        fileMsh.dataset.url = body.export_url || body.msh_url;
        fileMsh.dataset.filename = "mesh." + (body.export_format || "msh");
        fileMsh.title = "Download mesh (" + (body.export_format || "msh") + ")";
      }
      fileStl.hidden = false;
      fileStl.dataset.url = body.preview_url;
      if (s.faces && s.edges) {
        toolbarStatus.textContent =
          `Done. Faces: ${s.faces.join(", ")} · Edges: ${s.edges.join(", ")}`;
      } else {
        toolbarStatus.textContent = "Done.";
      }
      renderQuality(s.quality);
      loadPreview(body.preview_url);
      fetchEntities();
      saveAutosave();
      updateStats(s);
      gmshVersion.textContent = `Mesh engine: Gmsh ${s.gmsh_version || "?"} (live)`;
      logConsole(
        `Mesh generated: ${s.nodes} nodes, ${s.quads ?? 0} quads / ${s.triangles ?? 0} triangles` +
          (s.minimum_edge_length != null ? `, min edge ${s.minimum_edge_length} ${unitSymbol()}` : "") +
          (s.volume ? `, volume: ${s.volume_tets} tets / ${s.volume_hexes ?? 0} hexes / ${s.volume_prisms ?? 0} prisms (${s.mesh_method_used || "tet"})` : ""),
        "ok"
      );
      // The surface result is independent of the volume. A tet fallback for a
      // hex-dominant volume is a known Gmsh limitation, not a failure — report
      // it quietly and keep the surface result.
      if (s.mesh_method_used === "tet_fallback") {
        logConsole(
          "Volume: hex-dominant is not available for this geometry (a known Gmsh limitation) — tetrahedra used. The surface mesh is unaffected.",
          "info"
        );
      }
      if (s.size_warning) {
        logConsole("WARNING: " + s.size_warning, "error");
        toolbarStatus.textContent = "Warning: " + s.size_warning;
      }
    } else {
      toolbarStatus.textContent = body.message || "Meshing failed.";
      logProgress("Meshing failed.");
      logConsole(body.message || "Meshing failed.", "error");
    }
  } catch (err) {
    if (err.name === "AbortError") {
      toolbarStatus.textContent = "Mesh generation stopped.";
      logProgress("Meshing stopped.");
      logConsole("Mesh generation stopped by user.", "info");
    } else {
      toolbarStatus.textContent = `Error: ${err.message}`;
      logProgress("Meshing error: " + err.message);
      logConsole("Error: " + err.message, "error");
      // A transport-level failure means the backend/worker is gone — say so loudly.
      showBackendError(err.message);
      checkEngine();
    }
  } finally {
    clearInterval(pollTimer);
    stopBtn.disabled = true;
    currentAbort = null;
    generateBtn.disabled = false;
    updateBtn.disabled = false;
    checkEngine();
  }
}

generateBtn.addEventListener("click", runMesh);
updateBtn.addEventListener("click", runMesh);
stopBtn.addEventListener("click", () => {
  if (currentAbort) currentAbort.abort();
});

fileMsh.addEventListener("click", () => {
  if (!fileMsh.dataset.url) return;
  const a = document.createElement("a");
  a.href = fileMsh.dataset.url;
  a.download = fileMsh.dataset.filename || "mesh.msh";
  document.body.appendChild(a);
  a.click();
  a.remove();
});
fileStl.addEventListener("click", () => {
  if (fileStl.dataset.url) loadPreview(fileStl.dataset.url);
});
consoleHide.addEventListener("click", () => consoleBox.classList.toggle("collapsed"));

/* ---- resizable console (drag the divider, Word-table style arrow cursor) ---- */
if (consoleResizer) {
  let resizingConsole = false;
  consoleResizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    resizingConsole = true;
    document.body.classList.add("console-resizing");
    consoleBox.classList.remove("collapsed");
  });
  window.addEventListener("mousemove", (e) => {
    if (!resizingConsole) return;
    const content = consoleResizer.parentElement.getBoundingClientRect();
    const h = content.bottom - e.clientY;
    consoleBox.style.height = Math.max(40, Math.min(h, content.height * 0.7)) + "px";
  });
  window.addEventListener("mouseup", () => {
    if (!resizingConsole) return;
    resizingConsole = false;
    document.body.classList.remove("console-resizing");
  });
}

/* ---- resizable left/right splitter ---- */
const splitter = document.getElementById("splitter");
const sidebarEl = document.querySelector(".sidebar");
const workspaceEl = document.querySelector(".workspace");
if (splitter && sidebarEl && workspaceEl) {
  let resizing = false;
  splitter.addEventListener("mousedown", (e) => {
    e.preventDefault();
    resizing = true;
    document.body.classList.add("resizing");
  });
  window.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    const rect = workspaceEl.getBoundingClientRect();
    let w = e.clientX - rect.left;
    w = Math.max(240, Math.min(w, rect.width * 0.6));
    sidebarEl.style.width = w + "px";
  });
  window.addEventListener("mouseup", () => {
    resizing = false;
    document.body.classList.remove("resizing");
  });
}

/* ---- Qt-style desktop chrome: title-bar window buttons + menu bar ---- */
function closeAllMenus() {
  document.querySelectorAll(".menu.open").forEach((m) => {
    m.classList.remove("open");
    const dd = m.querySelector(".menu-dropdown");
    if (dd) dd.hidden = true;
  });
}
document.querySelectorAll(".menu").forEach((menu) => {
  const btn = menu.querySelector(".menu-btn");
  const dd = menu.querySelector(".menu-dropdown");
  if (!btn || !dd) return;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = menu.classList.contains("open");
    closeAllMenus();
    if (!wasOpen) {
      menu.classList.add("open");
      dd.hidden = false;
    }
  });
});
document.addEventListener("click", closeAllMenus);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAllMenus();
});

const wireMenu = (id, fn) => {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener("click", () => {
    closeAllMenus();
    fn();
  });
};
wireMenu("menu-import", () => importBtn.click());
wireMenu("menu-save", () => saveProject());
wireMenu("menu-load", () => loadProjectInput.click());
wireMenu("menu-generate", () => generateBtn.click());
wireMenu("menu-volume", () => {
  volumeEnable.checked = !volumeEnable.checked;
  saveAutosave();
});
wireMenu("menu-boundary", () => {
  blAuto.value = blAuto.value === "none" ? "all_faces" : "none";
  saveAutosave();
});
wireMenu("menu-reset", () => resetView());
wireMenu("menu-zoom-in", () => zoomIn.click());
wireMenu("menu-zoom-out", () => zoomOut.click());
wireMenu("menu-about", () => {
  alert("GMESH \u2014 standalone mesh generation tool\nRust application layer + Python/Gmsh worker.\nUnits: SI (metres, kg, seconds).");
});

const winMax = document.getElementById("win-max");
if (winMax) {
  winMax.addEventListener("click", () => document.body.classList.toggle("maximized"));
}

checkEngine();

/* ---- restore autosaved work after a crash / reload ----
   Runs last so every module binding (currentUnit, pickMode, ...) is
   initialized before applyProject() touches it. */
const autosaved = getAutosave();
if (autosaved) {
  try {
    applyProject(autosaved);
    toolbarStatus.textContent = "Restored autosaved project.";
  } catch (err) {
    console.warn("autosave restore failed:", err && err.name, err && err.message, err && err.stack);
  }
}
