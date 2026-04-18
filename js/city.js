// 3D Code City renderer — Three.js + d3-treemap
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";

let scene, camera, renderer, controls, raycaster, pointer;
let buildings = [];
let resizeHandler, pointerHandler, animId;
let tooltipEl;
let hovered = null;
// Animated extras (evening scene)
let pedestrians = null;
let pedData = null;
let smokeSystem = null;

const WORLD_SIZE = 200;
const MAX_HEIGHT = 80;


function createAsphaltTexture() {
  // Dark asphalt for the street network under the whole city
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#3d3b36";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1400; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const v = 48 + Math.random() * 30 | 0;
    const a = 0.28 + Math.random() * 0.35;
    ctx.fillStyle = `rgba(${v},${v - 2},${v - 6},${a})`;
    ctx.fillRect(x, y, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 10);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function colorForScore(score, maxScore) {
  // redyellowgreen reversed: 0 → green, 1 → red
  const t = maxScore > 0 ? Math.min(1, Math.max(0, score / maxScore)) : 0;
  // Interpolate green (0) → yellow (0.5) → red (1)
  let r, g, b;
  if (t < 0.5) {
    const k = t * 2;
    r = Math.round(26 + (255 - 26) * k);
    g = Math.round(150 + (236 - 150) * k);
    b = Math.round(65 + (139 - 65) * k * 0);
  } else {
    const k = (t - 0.5) * 2;
    r = Math.round(255 - (255 - 215) * k);
    g = Math.round(236 - (236 - 25) * k);
    b = Math.round(139 - (139 - 28) * k);
  }
  return new THREE.Color(r / 255, g / 255, b / 255);
}

function ensureTooltip(container) {
  if (tooltipEl && tooltipEl.parentNode) return tooltipEl;
  tooltipEl = document.createElement("div");
  tooltipEl.className = "city-tooltip";
  tooltipEl.style.cssText = `
    position: absolute; pointer-events: none; display: none;
    background: rgba(30,30,30,0.92); color: #fff; padding: 8px 10px;
    border-radius: 4px; font-size: 12px; line-height: 1.4;
    z-index: 10; max-width: 320px; font-family: system-ui, sans-serif;
    box-shadow: 0 2px 6px rgba(0,0,0,0.3);
  `;
  container.style.position = "relative";
  container.appendChild(tooltipEl);
  return tooltipEl;
}

function buildTreemap(nodes) {
  // Convert flat node list to d3-hierarchy
  const byId = new Map(nodes.map(n => [n.id, { ...n, children: [] }]));
  const root = byId.get("root");
  if (!root) return null;
  for (const n of nodes) {
    if (n.parent && byId.has(n.parent) && n.id !== "root") {
      byId.get(n.parent).children.push(byId.get(n.id));
    }
  }
  const h = hierarchy(root)
    .sum(d => (d.children && d.children.length) ? 0 : Math.max(d.changes || 0, 1))
    .sort((a, b) => (b.value || 0) - (a.value || 0));
  const layout = treemap()
    .tile(treemapSquarify.ratio(1.618))
    .size([WORLD_SIZE, WORLD_SIZE])
    .paddingInner(2.4)
    .paddingOuter(3.5)
    .paddingTop(3.5)
    .round(false)(h);
  return layout;
}

// Build a Map<id, {x0,y0,x1,y1,depth,parent}> from a master node list.
// Callers pass union-of-all-snapshots nodes so positions are stable across playback.
export function buildLayoutMap(masterNodes) {
  const layout = buildTreemap(masterNodes);
  if (!layout) return null;
  const map = new Map();
  layout.descendants().forEach(d => {
    map.set(d.data.id, {
      x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1,
      depth: d.depth, parent: d.parent?.data?.id || null,
    });
  });
  return map;
}

function disposeScene() {
  if (animId) cancelAnimationFrame(animId);
  if (resizeHandler) window.removeEventListener("resize", resizeHandler);
  if (pointerHandler && renderer) renderer.domElement.removeEventListener("pointermove", pointerHandler);
  if (renderer) {
    renderer.dispose();
    if (renderer.domElement && renderer.domElement.parentNode) {
      renderer.domElement.parentNode.removeChild(renderer.domElement);
    }
  }
  for (const b of buildings) {
    if (b.mesh.geometry) b.mesh.geometry.dispose();
    if (b.mesh.material) b.mesh.material.dispose();
  }
  if (tooltipEl && tooltipEl.parentNode) {
    tooltipEl.parentNode.removeChild(tooltipEl);
    tooltipEl = null;
  }
  if (smokeSystem) {
    smokeSystem.geometry.dispose();
    smokeSystem.material.dispose();
  }
  if (pedestrians) {
    pedestrians.geometry.dispose();
    pedestrians.material.dispose();
  }
  scene = camera = renderer = controls = raycaster = pointer = null;
  buildings = [];
  pedestrians = pedData = smokeSystem = null;
  animId = resizeHandler = pointerHandler = null;
  hovered = null;
}

export function disposeCity() {
  disposeScene();
}

export function setAutoRotate(enabled) {
  if (controls) {
    controls.autoRotate = !!enabled;
    controls.autoRotateSpeed = 0.8;
  }
}

// Update existing buildings in-place with new per-file metrics without rebuilding
// the scene (preserves camera, pedestrians, street layout). Used by timeline playback.
export function updateCityMetrics(metricsById) {
  if (!scene || buildings.length === 0) return;
  let maxScore = 0.01;
  let maxLoc = 1;
  for (const m of Object.values(metricsById)) {
    if (m.hotspot_score > maxScore) maxScore = m.hotspot_score;
    if (m.loc > maxLoc) maxLoc = m.loc;
  }
  for (const b of buildings) {
    const m = metricsById[b.mesh.userData.id];
    if (m) {
      const loc = m.loc || 0;
      const h = Math.max(1, Math.sqrt(loc / maxLoc) * MAX_HEIGHT);
      // scale.y of a BoxGeometry(w, initialH, d) gives final height = initialH * scale.y.
      // Store initialH on userData on first call so we can recompute scale.
      if (!b.mesh.userData._initH) {
        b.mesh.userData._initH = b.mesh.geometry.parameters.height;
      }
      b.mesh.scale.y = h / b.mesh.userData._initH;
      b.mesh.position.y = h / 2;
      // Color
      b.mesh.material.color.copy(_colorForScore(m.hotspot_score || 0, maxScore));
      // Update userData for tooltip
      b.mesh.userData.loc = m.loc;
      b.mesh.userData.changes = m.changes;
      b.mesh.userData.hotspot_score = m.hotspot_score;
      b.mesh.userData.primary_author = m.primary_author;
      b.mesh.visible = loc > 0 || (m.changes || 0) > 0;
    } else {
      // File doesn't exist at this snapshot → hide
      b.mesh.visible = false;
    }
  }
}

function _colorForScore(score, maxScore) {
  return colorForScore(score, maxScore);
}

export function renderCity(spec, container, meta = {}, opts = {}) {
  disposeScene();
  container.innerHTML = "";

  const nodes = spec?.data?.[0]?.values || [];
  if (nodes.length === 0) {
    container.innerHTML = '<p class="text-muted">No data to render.</p>';
    return;
  }

  // Either use a stable layoutMap (timeline mode) or compute fresh via d3-treemap
  let leaves, topDistricts;
  if (opts.layoutMap) {
    const parentIds = new Set();
    opts.layoutMap.forEach(pos => { if (pos.parent) parentIds.add(pos.parent); });
    leaves = [];
    topDistricts = [];
    for (const n of nodes) {
      const pos = opts.layoutMap.get(n.id);
      if (!pos) continue;
      const wrapped = { data: n, x0: pos.x0, y0: pos.y0, x1: pos.x1, y1: pos.y1, depth: pos.depth };
      if (parentIds.has(n.id)) {
        if (pos.depth === 1) topDistricts.push(wrapped);
      } else if (n.id !== "root") {
        leaves.push(wrapped);
      }
    }
  } else {
    const layoutRoot = buildTreemap(nodes);
    if (!layoutRoot) {
      container.innerHTML = '<p class="text-danger">Invalid tree structure.</p>';
      return;
    }
    leaves = layoutRoot.leaves().filter(d => d.data.id !== "root");
    topDistricts = layoutRoot.descendants().filter(d =>
      d.depth === 1 && d.children && d.data.id !== "root"
    );
  }
  const maxScore = Math.max(...leaves.map(d => d.data.hotspot_score || 0), 0.01);
  const maxLoc = Math.max(...leaves.map(d => d.data.loc || 0), 1);

  // Scene setup
  const width = container.clientWidth || 900;
  const height = 600;

  scene = new THREE.Scene();
  // Evening ambient — dusky blue-grey, uniform
  scene.background = new THREE.Color(0x242a36);

  camera = new THREE.PerspectiveCamera(48, width / height, 0.1, WORLD_SIZE * 8);
  camera.position.set(WORLD_SIZE * 0.9, WORLD_SIZE * 0.85, WORLD_SIZE * 1.1);
  camera.lookAt(0, 0, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  // Evening lighting: cool ambient with warm low sun
  scene.add(new THREE.HemisphereLight(0x4a5e85, 0x201810, 0.35));
  scene.add(new THREE.AmbientLight(0x3c4a66, 0.18));

  const sun = new THREE.DirectionalLight(0xff9a5a, 0.85);
  sun.position.set(WORLD_SIZE * 0.5, WORLD_SIZE * 0.45, WORLD_SIZE * 0.25);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.radius = 3.5;
  sun.shadow.camera.left = -WORLD_SIZE * 0.65;
  sun.shadow.camera.right = WORLD_SIZE * 0.65;
  sun.shadow.camera.top = WORLD_SIZE * 0.65;
  sun.shadow.camera.bottom = -WORLD_SIZE * 0.65;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = WORLD_SIZE * 4;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  // Cool rim light from opposite side — bluish twilight accent
  const rim = new THREE.DirectionalLight(0x6a88b5, 0.3);
  rim.position.set(-WORLD_SIZE * 0.5, WORLD_SIZE * 0.6, -WORLD_SIZE * 0.4);
  scene.add(rim);

  // Full ground = dark asphalt. Every gap between buildings shows through as a street.
  const coreGround = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_SIZE * 1.1, WORLD_SIZE * 1.1),
    new THREE.MeshStandardMaterial({
      map: createAsphaltTexture(),
      roughness: 0.95,
      metalness: 0,
    }),
  );
  coreGround.rotation.x = -Math.PI / 2;
  coreGround.position.y = -0.02;
  coreGround.receiveShadow = true;
  scene.add(coreGround);

  // Top-level district outlines — thin emissive border strips on asphalt, marking neighborhoods
  const districtBorderMat = new THREE.MeshStandardMaterial({
    color: 0xe8d68a,
    emissive: 0x362a10,
    roughness: 0.8,
    metalness: 0,
  });
  const borderW = 0.25;
  for (const d of topDistricts) {
    const w = d.x1 - d.x0;
    const depth = d.y1 - d.y0;
    if (w < 1.5 || depth < 1.5) continue;
    const cx = d.x0 + w / 2 - WORLD_SIZE / 2;
    const cz = d.y0 + depth / 2 - WORLD_SIZE / 2;
    // Four thin bars forming a rectangle outline
    const top = new THREE.Mesh(new THREE.BoxGeometry(w, 0.05, borderW), districtBorderMat);
    top.position.set(cx, 0.03, cz - depth / 2);
    scene.add(top);
    const bot = top.clone(); bot.position.z = cz + depth / 2; scene.add(bot);
    const left = new THREE.Mesh(new THREE.BoxGeometry(borderW, 0.05, depth), districtBorderMat);
    left.position.set(cx - w / 2, 0.03, cz);
    scene.add(left);
    const right = left.clone(); right.position.x = cx + w / 2; scene.add(right);
  }

  // Shared edge material for building outlines
  const edgeMat = new THREE.LineBasicMaterial({
    color: 0x1a1a1a,
    transparent: true,
    opacity: 0.35,
  });

  // Buildings (leaf files)
  for (const leaf of leaves) {
    const w = leaf.x1 - leaf.x0;
    const depth = leaf.y1 - leaf.y0;
    if (w < 0.2 || depth < 0.2) continue;

    const loc = leaf.data.loc || 0;
    // Height: sqrt-scaled so huge files don't dominate
    const h = Math.max(1, Math.sqrt(loc / maxLoc) * MAX_HEIGHT);

    const color = colorForScore(leaf.data.hotspot_score || 0, maxScore);
    const mat = new THREE.MeshStandardMaterial({
      color,
      roughness: 0.55,
      metalness: 0.08,
      flatShading: false,
    });

    const bw = w * 0.92;
    const bd = depth * 0.92;
    const geom = new THREE.BoxGeometry(bw, h, bd);
    const mesh = new THREE.Mesh(geom, mat);
    // Buildings sit directly on asphalt — every gap around them is a visible street
    mesh.position.set(
      leaf.x0 + w / 2 - WORLD_SIZE / 2,
      h / 2,
      leaf.y0 + depth / 2 - WORLD_SIZE / 2,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = leaf.data;
    scene.add(mesh);

    if (h > 2.5 && bw > 1.2 && bd > 1.2) {
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 15), edgeMat);
      edges.position.copy(mesh.position);
      scene.add(edges);
    }

    buildings.push({ mesh, baseColor: color.clone() });
  }

  // -------- Street lamps at top-district corners --------
  {
    const poleGeom = new THREE.CylinderGeometry(0.11, 0.11, 2.2, 6);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0x2d2d30, roughness: 0.85 });
    const bulbGeom = new THREE.SphereGeometry(0.35, 8, 6);
    const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffcf82 });
    const seen = new Set();
    for (const d of topDistricts) {
      const corners = [[d.x0, d.y0], [d.x1, d.y0], [d.x0, d.y1], [d.x1, d.y1]];
      for (const [cx, cz] of corners) {
        const key = `${Math.round(cx)}_${Math.round(cz)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const wx = cx - WORLD_SIZE / 2;
        const wz = cz - WORLD_SIZE / 2;
        const pole = new THREE.Mesh(poleGeom, poleMat);
        pole.position.set(wx, 1.1, wz);
        pole.castShadow = true;
        scene.add(pole);
        const bulb = new THREE.Mesh(bulbGeom, bulbMat);
        bulb.position.set(wx, 2.3, wz);
        scene.add(bulb);
      }
    }
  }

  // -------- Street grid for pedestrian navigation --------
  const CELL = 2;
  const GRID_W = Math.ceil(WORLD_SIZE / CELL);
  const isStreet = new Uint8Array(GRID_W * GRID_W);
  isStreet.fill(1);
  for (const leaf of leaves) {
    const minX = Math.max(0, Math.floor(leaf.x0 / CELL));
    const maxX = Math.min(GRID_W, Math.ceil(leaf.x1 / CELL));
    const minZ = Math.max(0, Math.floor(leaf.y0 / CELL));
    const maxZ = Math.min(GRID_W, Math.ceil(leaf.y1 / CELL));
    for (let iz = minZ; iz < maxZ; iz++) {
      for (let ix = minX; ix < maxX; ix++) {
        isStreet[iz * GRID_W + ix] = 0;
      }
    }
  }

  // Risky cell set — cells adjacent to high-score buildings; pedestrians avoid
  const sortedByScore = leaves.slice().sort((a, b) => (b.data.hotspot_score || 0) - (a.data.hotspot_score || 0));
  const scoreThresh = sortedByScore.length
    ? sortedByScore[Math.floor(sortedByScore.length * 0.1)].data.hotspot_score || 0
    : 0;
  const riskyCells = new Uint8Array(GRID_W * GRID_W);
  for (const leaf of leaves) {
    if ((leaf.data.hotspot_score || 0) < scoreThresh) continue;
    const minX = Math.max(0, Math.floor(leaf.x0 / CELL) - 2);
    const maxX = Math.min(GRID_W - 1, Math.ceil(leaf.x1 / CELL) + 2);
    const minZ = Math.max(0, Math.floor(leaf.y0 / CELL) - 2);
    const maxZ = Math.min(GRID_W - 1, Math.ceil(leaf.y1 / CELL) + 2);
    for (let iz = minZ; iz <= maxZ; iz++) {
      for (let ix = minX; ix <= maxX; ix++) {
        if (isStreet[iz * GRID_W + ix]) riskyCells[iz * GRID_W + ix] = 1;
      }
    }
  }

  // -------- Pedestrians --------
  const PED_COUNT = 180;
  const pedGeom = new THREE.CylinderGeometry(0.2, 0.22, 0.85, 6);
  const pedMat = new THREE.MeshStandardMaterial({ color: 0xcfd8dc, roughness: 0.7 });
  pedestrians = new THREE.InstancedMesh(pedGeom, pedMat, PED_COUNT);
  pedestrians.castShadow = false;
  pedestrians.receiveShadow = false;
  scene.add(pedestrians);

  pedData = new Array(PED_COUNT);
  const dummy = new THREE.Object3D();
  for (let p = 0; p < PED_COUNT; p++) {
    let wx = 0, wz = 0, tries = 30;
    while (tries-- > 0) {
      const ix = Math.floor(Math.random() * GRID_W);
      const iz = Math.floor(Math.random() * GRID_W);
      const idx = iz * GRID_W + ix;
      if (!isStreet[idx]) continue;
      if (riskyCells[idx] && Math.random() > 0.08) continue; // avoid spawning near red
      wx = ix * CELL + CELL / 2 - WORLD_SIZE / 2;
      wz = iz * CELL + CELL / 2 - WORLD_SIZE / 2;
      break;
    }
    pedData[p] = {
      x: wx, z: wz,
      dir: Math.floor(Math.random() * 4),
      speed: 0.06 + Math.random() * 0.08,
    };
    dummy.position.set(wx, 0.42, wz);
    dummy.updateMatrix();
    pedestrians.setMatrixAt(p, dummy.matrix);
  }
  pedestrians.instanceMatrix.needsUpdate = true;

  // -------- Smoke from top hotspots --------
  const smokeSources = sortedByScore.slice(0, 5).filter(l => (l.data.hotspot_score || 0) > 0);
  if (smokeSources.length > 0) {
    const PER_SRC = 40;
    const total = smokeSources.length * PER_SRC;
    const positions = new Float32Array(total * 3);
    const ages = new Float32Array(total);
    const sources = [];
    for (let s = 0; s < smokeSources.length; s++) {
      const src = smokeSources[s];
      const bh = Math.max(1, Math.sqrt((src.data.loc || 0) / maxLoc) * MAX_HEIGHT);
      const cx = (src.x0 + src.x1) / 2 - WORLD_SIZE / 2;
      const cz = (src.y0 + src.y1) / 2 - WORLD_SIZE / 2;
      sources.push({ cx, cz, top: bh });
      for (let i = 0; i < PER_SRC; i++) {
        const k = s * PER_SRC + i;
        positions[k * 3] = cx + (Math.random() - 0.5) * 1.2;
        positions[k * 3 + 1] = bh + Math.random() * 5;
        positions[k * 3 + 2] = cz + (Math.random() - 0.5) * 1.2;
        ages[k] = Math.random();
      }
    }
    const sGeom = new THREE.BufferGeometry();
    sGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const sMat = new THREE.PointsMaterial({
      color: 0x6a5a52,
      size: 3.2,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      sizeAttenuation: true,
    });
    smokeSystem = new THREE.Points(sGeom, sMat);
    smokeSystem.userData = { sources, ages, perSrc: PER_SRC, total };
    scene.add(smokeSystem);
  }

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 20;
  controls.maxDistance = WORLD_SIZE * 6;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.target.set(0, MAX_HEIGHT / 4, 0);
  if (opts.autoRotate) {
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.8;
  }
  controls.update();

  // Raycaster for hover tooltip. Init pointer OUTSIDE valid NDC so first raycast
  // hits nothing; only a real pointermove over the canvas activates the tooltip.
  raycaster = new THREE.Raycaster();
  pointer = new THREE.Vector2(100, 100);
  let mouseInCanvas = false;
  ensureTooltip(container);

  pointerHandler = (ev) => {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    tooltipEl.style.left = (ev.clientX - rect.left + 12) + "px";
    tooltipEl.style.top = (ev.clientY - rect.top + 12) + "px";
  };
  const leaveHandler = () => {
    mouseInCanvas = false;
    pointer.set(100, 100);
    if (tooltipEl) tooltipEl.style.display = "none";
  };
  const enterHandler = () => { mouseInCanvas = true; };
  renderer.domElement.addEventListener("pointermove", pointerHandler);
  renderer.domElement.addEventListener("pointerleave", leaveHandler);
  renderer.domElement.addEventListener("pointerenter", enterHandler);
  // Store ref so we can clean up
  pedData = pedData; // noop just to satisfy linters; actual cleanup below

  // Resize handling
  resizeHandler = () => {
    if (!renderer || !camera) return;
    const w = container.clientWidth;
    camera.aspect = w / height;
    camera.updateProjectionMatrix();
    renderer.setSize(w, height);
  };
  window.addEventListener("resize", resizeHandler);

  // Render loop
  const pedDummy = new THREE.Object3D();
  const DIR_X = [CELL, -CELL, 0, 0];
  const DIR_Z = [0, 0, CELL, -CELL];

  function updatePedestrians() {
    if (!pedestrians || !pedData) return;
    for (let p = 0; p < pedData.length; p++) {
      const d = pedData[p];
      const stepX = DIR_X[d.dir] * d.speed * 0.12;
      const stepZ = DIR_Z[d.dir] * d.speed * 0.12;
      const nx = d.x + stepX;
      const nz = d.z + stepZ;
      const gx = Math.floor((nx + WORLD_SIZE / 2) / CELL);
      const gz = Math.floor((nz + WORLD_SIZE / 2) / CELL);
      let blocked = false;
      if (gx < 0 || gx >= GRID_W || gz < 0 || gz >= GRID_W) blocked = true;
      else if (!isStreet[gz * GRID_W + gx]) blocked = true;
      if (blocked || Math.random() < 0.008) {
        d.dir = (d.dir + 1 + Math.floor(Math.random() * 3)) % 4;
      } else {
        // Bias away from risky cells
        if (riskyCells[gz * GRID_W + gx] && Math.random() < 0.25) {
          d.dir = (d.dir + 2) % 4;
        } else {
          d.x = nx; d.z = nz;
        }
      }
      pedDummy.position.set(d.x, 0.42, d.z);
      pedDummy.updateMatrix();
      pedestrians.setMatrixAt(p, pedDummy.matrix);
    }
    pedestrians.instanceMatrix.needsUpdate = true;
  }

  function updateSmoke() {
    if (!smokeSystem) return;
    const pos = smokeSystem.geometry.attributes.position.array;
    const { sources, ages, perSrc, total } = smokeSystem.userData;
    for (let k = 0; k < total; k++) {
      ages[k] += 0.012;
      if (ages[k] > 1) {
        const s = Math.floor(k / perSrc);
        const src = sources[s];
        pos[k * 3] = src.cx + (Math.random() - 0.5) * 1.6;
        pos[k * 3 + 1] = src.top + 0.3;
        pos[k * 3 + 2] = src.cz + (Math.random() - 0.5) * 1.6;
        ages[k] = 0;
      } else {
        pos[k * 3 + 1] += 0.22;
        pos[k * 3] += (Math.random() - 0.5) * 0.12;
        pos[k * 3 + 2] += (Math.random() - 0.5) * 0.12;
      }
    }
    smokeSystem.geometry.attributes.position.needsUpdate = true;
  }

  function animate() {
    animId = requestAnimationFrame(animate);
    controls.update();
    updatePedestrians();
    updateSmoke();

    // Hover detection — only when mouse is actually over the canvas
    let newHover = null;
    if (mouseInCanvas) {
      raycaster.setFromCamera(pointer, camera);
      const intersects = raycaster.intersectObjects(buildings.map(b => b.mesh), false);
      newHover = intersects.length ? intersects[0].object : null;
    }

    if (hovered && hovered !== newHover && hovered.material) {
      hovered.material.emissive.setHex(0x000000);
    }
    if (newHover && newHover !== hovered) {
      newHover.material.emissive = new THREE.Color(0x333333);
    }
    hovered = newHover;

    if (hovered && mouseInCanvas) {
      const d = hovered.userData;
      tooltipEl.innerHTML = `
        <div style="font-weight:600;word-break:break-all;margin-bottom:4px">${d.id}</div>
        <div>Lines of Code: <b>${(d.loc || 0).toLocaleString()}</b></div>
        <div>Changes: <b>${d.changes || 0}</b></div>
        <div>Risk Score: <b>${(d.hotspot_score || 0).toFixed(2)}</b></div>
        <div>Main Author: <b>${d.primary_author || "Unknown"}</b></div>
      `;
      tooltipEl.style.display = "block";
    } else {
      tooltipEl.style.display = "none";
    }

    renderer.render(scene, camera);
  }
  animate();
}
