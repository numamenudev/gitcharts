// Side-by-side "main vs develop" comparison — two small 3D city panels with
// synced orbit cameras and per-file diff highlighting.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";

const WORLD = 160;
const MAX_H = 64;

let instances = [];  // { scene, camera, renderer, controls, animId, resizeHandler }
let topContainer = null;

function disposePanel(p) {
  if (p.animId) cancelAnimationFrame(p.animId);
  if (p.resizeHandler) window.removeEventListener("resize", p.resizeHandler);
  p.renderer.dispose();
  if (p.renderer.domElement.parentNode) {
    p.renderer.domElement.parentNode.removeChild(p.renderer.domElement);
  }
  p.scene.traverse(obj => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
      else obj.material.dispose();
    }
  });
}

export function disposeCompare() {
  for (const p of instances) disposePanel(p);
  instances = [];
  if (topContainer && topContainer.parentNode) {
    topContainer.parentNode.removeChild(topContainer);
  }
  topContainer = null;
}

function buildLayout(nodes) {
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
  return treemap()
    .tile(treemapSquarify.ratio(1.618))
    .size([WORLD, WORLD])
    .paddingInner(2.2)
    .paddingOuter(3)
    .paddingTop(3)
    .round(false)(h);
}

function unionNodes(specA, specB) {
  const a = specA?.data?.[0]?.values || [];
  const b = specB?.data?.[0]?.values || [];
  const byId = new Map();
  for (const n of a) byId.set(n.id, { ...n });
  for (const n of b) {
    if (!byId.has(n.id)) byId.set(n.id, { ...n });
    else {
      const prev = byId.get(n.id);
      byId.set(n.id, {
        ...prev,
        changes: Math.max(prev.changes || 0, n.changes || 0),
        loc: Math.max(prev.loc || 0, n.loc || 0),
      });
    }
  }
  return [...byId.values()];
}

function buildIdIndex(spec) {
  const map = new Map();
  for (const n of spec?.data?.[0]?.values || []) {
    map.set(n.id, n);
  }
  return map;
}

// Build one panel — half-width renderer with simplified scene
function buildPanel(container, label, leaves, colorFor, maxLoc) {
  const holder = document.createElement("div");
  holder.style.cssText = "flex:1; display:flex; flex-direction:column; min-width:0;";
  const title = document.createElement("div");
  title.textContent = label;
  title.style.cssText = "font:600 13px system-ui; padding:4px 8px; background:#eef1f5; border-bottom:1px solid #d7dbe2;";
  holder.appendChild(title);
  const canvasHost = document.createElement("div");
  canvasHost.style.cssText = "flex:1; min-height:500px; position:relative;";
  holder.appendChild(canvasHost);
  container.appendChild(holder);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xd6dce4);
  scene.fog = new THREE.Fog(0xd6dce4, WORLD * 2, WORLD * 5);

  const width = canvasHost.clientWidth || 600;
  const height = 500;
  const camera = new THREE.PerspectiveCamera(48, width / height, 0.1, WORLD * 8);
  camera.position.set(WORLD * 0.6, WORLD * 0.55, WORLD * 0.75);
  camera.lookAt(0, MAX_H / 5, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  canvasHost.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xcfdceb, 0x7d8590, 0.65));
  scene.add(new THREE.AmbientLight(0xeef1f5, 0.25));
  const sun = new THREE.DirectionalLight(0xfff6e8, 1.05);
  sun.position.set(WORLD * 0.55, WORLD * 0.95, WORLD * 0.3);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 1024;
  sun.shadow.mapSize.height = 1024;
  sun.shadow.camera.left = -WORLD * 0.65;
  sun.shadow.camera.right = WORLD * 0.65;
  sun.shadow.camera.top = WORLD * 0.65;
  sun.shadow.camera.bottom = -WORLD * 0.65;
  scene.add(sun);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD * 1.1, WORLD * 1.1),
    new THREE.MeshStandardMaterial({ color: 0x8b9098, roughness: 0.95 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Ghost footprints first — every leaf in the union layout gets a flat grey
  // plinth so the two panels frame the same urban shape even when one branch
  // has many fewer files than the other.
  const ghostMat = new THREE.MeshStandardMaterial({
    color: 0xb8bdc5,
    roughness: 0.95,
    transparent: true,
    opacity: 0.55,
  });
  for (const leaf of leaves) {
    const w = leaf.x1 - leaf.x0;
    const depth = leaf.y1 - leaf.y0;
    if (w < 0.3 || depth < 0.3) continue;
    const bw = w * 0.9, bd = depth * 0.9;
    const gm = new THREE.Mesh(new THREE.BoxGeometry(bw, 0.35, bd), ghostMat);
    gm.position.set(leaf.x0 + w / 2 - WORLD / 2, 0.18, leaf.y0 + depth / 2 - WORLD / 2);
    gm.receiveShadow = true;
    scene.add(gm);
  }

  for (const leaf of leaves) {
    const w = leaf.x1 - leaf.x0;
    const depth = leaf.y1 - leaf.y0;
    if (w < 0.3 || depth < 0.3) continue;
    const info = colorFor(leaf.data);
    if (!info) continue;
    const { color, loc, emissive, halo } = info;
    if (loc <= 0) continue;
    const h = Math.max(1, Math.sqrt(loc / maxLoc) * MAX_H);
    const bw = w * 0.92, bd = depth * 0.92;
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: emissive || 0x000000,
      emissiveIntensity: emissive ? 0.35 : 0,
      roughness: 0.65,
      metalness: 0.05,
    });
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw, h, bd), mat);
    mesh.position.set(leaf.x0 + w / 2 - WORLD / 2, h / 2, leaf.y0 + depth / 2 - WORLD / 2);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (halo) {
      const haloMat = new THREE.MeshBasicMaterial({ color: halo, transparent: true, opacity: 0.28, side: THREE.BackSide });
      const haloMesh = new THREE.Mesh(new THREE.BoxGeometry(bw * 1.12, h * 1.04, bd * 1.12), haloMat);
      haloMesh.position.copy(mesh.position);
      scene.add(haloMesh);
    }
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 20;
  controls.maxDistance = WORLD * 6;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.target.set(0, MAX_H / 4, 0);
  controls.update();

  const resizeHandler = () => {
    const w = canvasHost.clientWidth;
    camera.aspect = w / height;
    camera.updateProjectionMatrix();
    renderer.setSize(w, height);
  };
  window.addEventListener("resize", resizeHandler);

  const panel = { scene, camera, renderer, controls, resizeHandler, animId: null };
  function animate() {
    panel.animId = requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();
  return panel;
}

export function renderCompare(container, specMain, specDev) {
  disposeCompare();
  if (!specMain || !specDev) {
    container.innerHTML = '<p class="text-muted">Need both main and a second-branch hotspot chart.</p>';
    return;
  }
  container.innerHTML = "";
  topContainer = document.createElement("div");
  topContainer.style.cssText = "display:flex; gap:8px; width:100%; border:1px solid #d7dbe2; border-radius:6px; overflow:hidden; background:#fff;";
  container.appendChild(topContainer);

  const unionLayout = buildLayout(unionNodes(specMain, specDev));
  if (!unionLayout) {
    container.innerHTML = '<p class="text-danger">Invalid tree.</p>';
    return;
  }
  const leaves = unionLayout.leaves().filter(d => d.data.id !== "root");
  const maxLoc = Math.max(...leaves.map(d => d.data.loc || 0), 1);

  const mainById = buildIdIndex(specMain);
  const devById = buildIdIndex(specDev);

  const colorForMain = (data) => {
    const m = mainById.get(data.id);
    const d = devById.get(data.id);
    if (!m) return null;
    const loc = m.loc || 0;
    const changes = m.changes || 0;
    const sM = m.hotspot_score || 0;
    const t = Math.min(1, sM / 25);
    const col = new THREE.Color().setHSL(0.33 - 0.33 * t, 0.55, 0.5);
    let halo = null;
    if (!d) halo = 0xff6b4a;
    return { color: col, loc, changes, halo };
  };
  const colorForDev = (data) => {
    const m = mainById.get(data.id);
    const d = devById.get(data.id);
    if (!d) return null;
    const loc = d.loc || 0;
    const changes = d.changes || 0;
    const sM = m?.hotspot_score || 0;
    const sD = d.hotspot_score || 0;
    const t = Math.min(1, sD / 25);
    const col = new THREE.Color().setHSL(0.33 - 0.33 * t, 0.55, 0.5);
    let halo = null;
    let emissive = null;
    if (!m) halo = 0x4acb72;
    else if (sD > sM * 1.3) halo = 0xff4a4a;
    else if (sD < sM * 0.7) halo = 0x4acb72;
    return { color: col, loc, changes, halo, emissive };
  };

  const pMain = buildPanel(topContainer, "main", leaves, colorForMain, maxLoc);
  const pDev  = buildPanel(topContainer, "develop (or selected)", leaves, colorForDev, maxLoc);
  instances = [pMain, pDev];

  // Sync cameras bidirectionally: when user drags one, mirror transform to the other
  let syncing = false;
  const sync = (src, dst) => {
    if (syncing) return;
    syncing = true;
    dst.camera.position.copy(src.camera.position);
    dst.controls.target.copy(src.controls.target);
    dst.controls.update();
    syncing = false;
  };
  pMain.controls.addEventListener("change", () => sync(pMain, pDev));
  pDev.controls.addEventListener("change",  () => sync(pDev, pMain));
}
