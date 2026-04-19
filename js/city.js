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
// Weather — dynamic sky, clouds, rain, lightning mapped to "gravity" score of the repo
let weather = null;  // { enabled, phase, gravity, clouds:[], rain, lightning, sun, rim, hemi, uiBtn }

const WORLD_SIZE = 200;
const MAX_HEIGHT = 80;


// ---------- Weather system ----------

function _gravityFromLeaves(leaves) {
  if (!leaves.length) return 0;
  const scores = leaves.map(l => l.data?.hotspot_score || l.hotspot_score || 0);
  const total = scores.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  const sorted = scores.slice().sort((a, b) => b - a);
  const topK = Math.max(1, Math.floor(scores.length * 0.1));
  const topSum = sorted.slice(0, topK).reduce((a, b) => a + b, 0);
  // Concentration: fraction of total score in top 10% of files
  const conc = topSum / total;
  // Average score normalized to top: rewards repos with many mid-high risk files
  const maxScore = sorted[0] || 1;
  const avgNorm = (total / scores.length) / maxScore;
  // Blend the two signals
  return Math.max(0, Math.min(1, conc * 0.55 + avgNorm * 0.9));
}

function _phaseForGravity(g) {
  if (g < 0.2) return "sunny";
  if (g < 0.4) return "partly_cloudy";
  if (g < 0.6) return "overcast";
  if (g < 0.8) return "storm";
  return "apocalypse";
}

const WEATHER_PRESETS = {
  sunny:         { sky: 0xb7cde6, fog: 0xc6d6e8, sun: 1.10, sunColor: 0xfff6e8, hemi: 0.65, clouds: 2,  rain: 0,    lightning: 0 },
  partly_cloudy: { sky: 0xc2cad6, fog: 0xc2cad6, sun: 0.95, sunColor: 0xfbeed8, hemi: 0.55, clouds: 6,  rain: 0,    lightning: 0 },
  overcast:      { sky: 0xa7adb6, fog: 0xa7adb6, sun: 0.45, sunColor: 0xdde2ea, hemi: 0.40, clouds: 10, rain: 0,    lightning: 0 },
  storm:         { sky: 0x4a5059, fog: 0x4a5059, sun: 0.18, sunColor: 0x9ea6b2, hemi: 0.22, clouds: 12, rain: 900,  lightning: 0.002 },
  apocalypse:    { sky: 0x1f232a, fog: 0x1f232a, sun: 0.08, sunColor: 0x6a7280, hemi: 0.10, clouds: 14, rain: 1600, lightning: 0.01, lightningColor: 0xff3636 },
};

function _createCloudTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d");
  const grad = ctx.createRadialGradient(64, 64, 8, 64, 64, 60);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.55, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function _buildWeather(sceneRef, sunRef, rimRef, hemiRef, initialGravity) {
  const phase = _phaseForGravity(initialGravity);
  const preset = WEATHER_PRESETS[phase];
  const w = {
    enabled: true,
    phase,
    gravity: initialGravity,
    clouds: [],
    rain: null,
    rainVel: null,
    lightningUntil: 0,
    sun: sunRef,
    rim: rimRef,
    hemi: hemiRef,
    cloudTex: _createCloudTexture(),
    preset,
  };
  // Clouds: billboard sprites (always face the camera, no rect edges visible)
  for (let i = 0; i < 14; i++) {
    const sz = 55 + Math.random() * 75;
    const sMat = new THREE.SpriteMaterial({
      map: w.cloudTex,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      color: 0xffffff,
    });
    const spr = new THREE.Sprite(sMat);
    spr.scale.set(sz, sz, 1);
    spr.position.set(
      (Math.random() - 0.5) * WORLD_SIZE * 2.2,
      WORLD_SIZE * 0.78 + Math.random() * 25,
      (Math.random() - 0.5) * WORLD_SIZE * 2.2,
    );
    spr.userData = { speed: 0.035 + Math.random() * 0.045 };
    sceneRef.add(spr);
    w.clouds.push(spr);
  }
  // Rain particles (hidden unless preset.rain > 0)
  const RAIN_COUNT = 1800;
  const rainPos = new Float32Array(RAIN_COUNT * 3);
  const rainVel = new Float32Array(RAIN_COUNT);
  for (let i = 0; i < RAIN_COUNT; i++) {
    rainPos[i * 3] = (Math.random() - 0.5) * WORLD_SIZE * 1.6;
    rainPos[i * 3 + 1] = Math.random() * WORLD_SIZE * 0.8;
    rainPos[i * 3 + 2] = (Math.random() - 0.5) * WORLD_SIZE * 1.6;
    rainVel[i] = 1.8 + Math.random() * 1.5;
  }
  const rGeom = new THREE.BufferGeometry();
  rGeom.setAttribute("position", new THREE.BufferAttribute(rainPos, 3));
  const rMat = new THREE.PointsMaterial({
    color: 0xb8c4d2,
    size: 0.8,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const rainPts = new THREE.Points(rGeom, rMat);
  rainPts.visible = false;
  rainPts.userData = { count: RAIN_COUNT };
  sceneRef.add(rainPts);
  w.rain = rainPts;
  w.rainVel = rainVel;
  _applyWeatherPreset(w, sceneRef);
  return w;
}

function _applyWeatherPreset(w, sceneRef) {
  const p = w.preset;
  if (!w.enabled) {
    // Reset to a clean daylight baseline
    sceneRef.background = new THREE.Color(0xd6dce4);
    if (sceneRef.fog) sceneRef.fog.color.setHex(0xd6dce4);
    w.sun.intensity = 1.05;
    w.sun.color.setHex(0xfff6e8);
    w.hemi.intensity = 0.65;
    if (w.rain) w.rain.visible = false;
    for (const c of w.clouds) c.visible = false;
    return;
  }
  sceneRef.background = new THREE.Color(p.sky);
  if (sceneRef.fog) sceneRef.fog.color.setHex(p.fog);
  w.sun.intensity = p.sun;
  w.sun.color.setHex(p.sunColor);
  w.hemi.intensity = p.hemi;
  // Cloud visibility proportional to preset.clouds
  for (let i = 0; i < w.clouds.length; i++) {
    const on = i < p.clouds;
    w.clouds[i].visible = on;
    if (on) {
      // Darker clouds in bad weather
      const tint = w.phase === "apocalypse" ? 0x333a44
                 : w.phase === "storm"      ? 0x555c68
                 : w.phase === "overcast"   ? 0xbac1ca
                 :                            0xffffff;
      w.clouds[i].material.color.setHex(tint);
      w.clouds[i].material.opacity = w.phase === "sunny" ? 0.55 : 0.85;
    }
  }
  w.rain.visible = p.rain > 0;
  if (p.rain > 0) {
    // Scale visible point count via draw range
    w.rain.geometry.setDrawRange(0, Math.min(p.rain, w.rain.userData.count));
  }
}

function _stepWeather(w, sceneRef, dt) {
  if (!w || !w.enabled) return;
  // Drift clouds
  for (const c of w.clouds) {
    if (!c.visible) continue;
    c.position.x += c.userData.speed * dt * 0.05;
    if (c.position.x > WORLD_SIZE * 1.2) c.position.x = -WORLD_SIZE * 1.2;
  }
  // Rain fall
  if (w.rain && w.rain.visible) {
    const pos = w.rain.geometry.attributes.position.array;
    const n = w.rain.geometry.drawRange.count || w.rain.userData.count;
    for (let i = 0; i < n; i++) {
      pos[i * 3 + 1] -= w.rainVel[i] * dt * 0.06;
      if (pos[i * 3 + 1] < 0) {
        pos[i * 3]     = (Math.random() - 0.5) * WORLD_SIZE * 1.6;
        pos[i * 3 + 1] = WORLD_SIZE * 0.8;
        pos[i * 3 + 2] = (Math.random() - 0.5) * WORLD_SIZE * 1.6;
      }
    }
    w.rain.geometry.attributes.position.needsUpdate = true;
  }
  // Lightning: brief intensity spike on the sun light
  const p = w.preset;
  const now = performance.now();
  if (p.lightning > 0) {
    if (now > w.lightningUntil && Math.random() < p.lightning) {
      const flashMs = 90 + Math.random() * 110;
      w.lightningUntil = now + flashMs;
      w._origSunInt = w.sun.intensity;
      w._origSunCol = w.sun.color.getHex();
      w.sun.intensity = 4.5;
      w.sun.color.setHex(p.lightningColor || 0xffffff);
    } else if (now >= w.lightningUntil && w._origSunInt !== undefined) {
      w.sun.intensity = w._origSunInt;
      w.sun.color.setHex(w._origSunCol);
      w._origSunInt = undefined;
    }
  }
}

function updateWeatherGravity(newGravity) {
  if (!weather) return;
  weather.gravity = newGravity;
  const phase = _phaseForGravity(newGravity);
  if (phase !== weather.phase) {
    weather.phase = phase;
    weather.preset = WEATHER_PRESETS[phase];
    _applyWeatherPreset(weather, scene);
  }
}

function _mountWeatherButton(container) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Weather: auto";
  btn.style.cssText = `
    position: absolute; top: 8px; right: 8px; z-index: 5;
    font: 12px system-ui; padding: 4px 8px; border-radius: 4px;
    border: 1px solid rgba(0,0,0,0.15); background: rgba(255,255,255,0.9);
    cursor: pointer;
  `;
  btn.addEventListener("click", () => {
    if (!weather) return;
    weather.enabled = !weather.enabled;
    btn.textContent = `Weather: ${weather.enabled ? "auto" : "off"}`;
    _applyWeatherPreset(weather, scene);
  });
  container.appendChild(btn);
  return btn;
}

function createAsphaltTexture() {
  // Medium neutral-grey asphalt; clean daylight look, no sepia
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#8b9098";
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1200; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const v = 118 + Math.random() * 32 | 0;
    const a = 0.18 + Math.random() * 0.28;
    ctx.fillStyle = `rgba(${v},${v + 2},${v + 6},${a})`;
    ctx.fillRect(x, y, 1, 1);
  }
  // Subtle lighter speckle for sidewalk-adjacent brightness
  for (let i = 0; i < 260; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    ctx.fillStyle = `rgba(210,215,220,${0.08 + Math.random() * 0.12})`;
    ctx.fillRect(x, y, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(10, 10);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Procedural window-grid texture; mix of lit/dim windows. skyscraper=true for
// denser grid, false for sparse house. Returned as a tileable CanvasTexture.
function createBuildingWindowTexture(skyscraper) {
  const c = document.createElement("canvas");
  c.width = 256; c.height = 256;
  const ctx = c.getContext("2d");
  // Pale wall — windows are subtle
  ctx.fillStyle = "#e6e9ee";
  ctx.fillRect(0, 0, 256, 256);
  const cols = skyscraper ? 5 : 2;
  const rows = skyscraper ? 8 : 2;
  const tileW = 256 / cols;
  const tileH = 256 / rows;
  const padX = tileW * 0.30;
  const padY = tileH * 0.34;
  for (let r = 0; r < rows; r++) {
    for (let co = 0; co < cols; co++) {
      const lit = Math.random() < 0.12;
      // Soft cool-grey panes; lit = warm pale highlight. Less contrast overall.
      const fill = lit ? "#eadcb4" : "#a8b2bf";
      ctx.fillStyle = fill;
      ctx.fillRect(co * tileW + padX, r * tileH + padY, tileW - 2 * padX, tileH - 2 * padY);
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Linear red–yellow–green gradient driven by score / maxScore.
// Caller may pass either a number (maxScore) or a bands object (uses .max).
function colorForScore(score, arg) {
  const maxScore = typeof arg === "number" ? arg : (arg && arg.max) || 0.01;
  const t = maxScore > 0 ? Math.min(1, Math.max(0, (score || 0) / maxScore)) : 0;
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

// Sample the same gradient at a normalized [0,1] position. Used by the legend
// so the color chips match exactly what the city renders at that t.
export function sampleRiskGradient(t) {
  const c = colorForScore(t, 1);
  return `#${c.getHexString()}`;
}

// Compute max-aligned bands for the legend so bands == actual color stops in city.
function computeRiskBands(scores) {
  const arr = (scores || []).filter(s => Number.isFinite(s));
  const max = arr.length ? Math.max(...arr) : 1;
  return { max: max || 1 };
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
  // Treemap mapping (original gitcharts convention, gives the strongest signal
  // for this repo: hotspots become TALL skyscrapers with a small footprint):
  //   tile area  = changes (churn → floor space = how often a file is touched)
  //   height     = LOC       (see renderCity / updateCityMetrics)
  //   color      = risk score (changes * log LOC)
  const h = hierarchy(root)
    .sum(d => (d.children && d.children.length) ? 0 : Math.max(d.changes || 0, 1))
    .sort((a, b) => (b.value || 0) - (a.value || 0));
  const layout = treemap()
    .tile(treemapSquarify.ratio(1.618))
    .size([WORLD_SIZE, WORLD_SIZE])
    .paddingInner(0.9)
    .paddingOuter(1.2)
    .paddingTop(1.2)
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
    if (b.mesh.material) {
      if (Array.isArray(b.mesh.material)) {
        for (const m of b.mesh.material) { if (m.map) m.map.dispose(); m.dispose(); }
      } else {
        if (b.mesh.material.map) b.mesh.material.map.dispose();
        b.mesh.material.dispose();
      }
    }
  }
  if (tooltipEl && tooltipEl.parentNode) {
    tooltipEl.parentNode.removeChild(tooltipEl);
    tooltipEl = null;
  }
  if (smokeSystem) {
    smokeSystem.geometry.dispose();
    smokeSystem.material.dispose();
  }
  if (weather) {
    for (const c of weather.clouds) {
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
    if (weather.rain) {
      weather.rain.geometry.dispose();
      weather.rain.material.dispose();
    }
    if (weather.cloudTex) weather.cloudTex.dispose();
    if (weather.uiBtn && weather.uiBtn.parentNode) {
      weather.uiBtn.parentNode.removeChild(weather.uiBtn);
    }
    weather = null;
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
// the scene. Used by timeline playback. Tweens scale.y and color for smooth growth;
// pass opts.immediate=true to snap (used for fast slider drags).
export function updateCityMetrics(metricsById, opts = {}) {
  if (!scene || buildings.length === 0) return;
  const immediate = !!opts.immediate;
  const duration = opts.tweenMs != null ? opts.tweenMs : 700;
  let maxLoc = 1;
  const vals = Object.values(metricsById);
  for (const m of vals) {
    if (m.loc > maxLoc) maxLoc = m.loc;
  }
  const bands = computeRiskBands(vals.map(m => m.hotspot_score || 0));
  // Recompute gravity from fresh snapshot scores so weather shifts along the timeline
  if (weather) {
    const leafShape = vals
      .filter(m => (m.loc || 0) > 0 || (m.changes || 0) > 0)
      .map(m => ({ data: { hotspot_score: m.hotspot_score || 0 } }));
    updateWeatherGravity(_gravityFromLeaves(leafShape));
  }
  const now = performance.now();
  for (const b of buildings) {
    const m = metricsById[b.mesh.userData.id];
    if (!b.mesh.userData._initH) {
      b.mesh.userData._initH = b.mesh.geometry.parameters.height;
    }
    let targetScaleY = 0.0001;
    let targetVisible = false;
    const targetColor = new THREE.Color();
    if (m) {
      const loc = m.loc || 0;
      const h = Math.max(1, Math.sqrt(loc / maxLoc) * MAX_HEIGHT);
      targetScaleY = h / b.mesh.userData._initH;
      targetVisible = loc > 0 || (m.changes || 0) > 0;
      targetColor.copy(_colorForScore(m.hotspot_score || 0, bands));
      b.mesh.userData.loc = m.loc;
      b.mesh.userData.changes = m.changes;
      b.mesh.userData.hotspot_score = m.hotspot_score;
      b.mesh.userData.primary_author = m.primary_author;
    } else {
      targetColor.copy(_primaryColor(b.mesh.material));
    }

    if (immediate) {
      b.mesh.scale.y = targetVisible ? targetScaleY : 0.0001;
      b.mesh.position.y = (b.mesh.userData._baseY || 0) + (b.mesh.userData._initH * b.mesh.scale.y) / 2;
      _forEachMat(b.mesh.material, mm => mm.color.copy(targetColor));
      b.mesh.visible = targetVisible;
      b.mesh.userData._tween = null;
      continue;
    }

    // Tween from current visual state (if already tweening, take current lerp point)
    const curScaleY = b.mesh.scale.y;
    const curColor = _primaryColor(b.mesh.material).clone();
    let fromScale = curScaleY;
    if (!b.mesh.visible && targetVisible) {
      fromScale = 0.0001;
      b.mesh.visible = true;
      b.mesh.scale.y = fromScale;
      b.mesh.position.y = (b.mesh.userData._initH * fromScale) / 2;
    }
    if (b.curb) b.curb.visible = targetVisible;
    b.mesh.userData._tween = {
      fromScale,
      toScale: targetVisible ? targetScaleY : 0.0001,
      fromColor: curColor,
      toColor: targetColor.clone(),
      start: now,
      duration,
      finalVisible: targetVisible,
    };
  }
}

function _stepTweens(nowMs) {
  for (const b of buildings) {
    const t = b.mesh.userData._tween;
    if (!t) continue;
    const raw = (nowMs - t.start) / t.duration;
    const p = raw >= 1 ? 1 : raw < 0 ? 0 : raw;
    // easeOutCubic
    const e = 1 - Math.pow(1 - p, 3);
    const s = t.fromScale + (t.toScale - t.fromScale) * e;
    b.mesh.scale.y = Math.max(0.0001, s);
    b.mesh.position.y = (b.mesh.userData._initH * b.mesh.scale.y) / 2;
    const tmpC = t.fromColor.clone().lerp(t.toColor, e);
    _forEachMat(b.mesh.material, mm => mm.color.copy(tmpC));
    if (p >= 1) {
      b.mesh.visible = t.finalVisible;
      if (!t.finalVisible) b.mesh.scale.y = 0.0001;
      b.mesh.userData._tween = null;
    }
  }
}

function _colorForScore(score, bandsOrMax) {
  return colorForScore(score, bandsOrMax);
}

function _forEachMat(mat, fn) {
  if (Array.isArray(mat)) for (const m of mat) fn(m);
  else fn(mat);
}

function _primaryColor(mat) {
  return Array.isArray(mat) ? mat[0].color : mat.color;
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
  let leaves, topDistricts, layoutRoot = null;
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
    layoutRoot = buildTreemap(nodes);
    if (!layoutRoot) {
      container.innerHTML = '<p class="text-danger">Invalid tree structure.</p>';
      return;
    }
    leaves = layoutRoot.leaves().filter(d => d.data.id !== "root");
    topDistricts = layoutRoot.descendants().filter(d =>
      d.depth === 1 && d.children && d.data.id !== "root"
    );
  }
  const renderBands = computeRiskBands(leaves.map(d => d.data.hotspot_score || 0));
  const maxLoc = Math.max(...leaves.map(d => d.data.loc || 0), 1);

  // Scene setup
  const width = container.clientWidth || 900;
  const height = 600;

  scene = new THREE.Scene();
  // Soft blue-hour / overcast daylight — clean, neutral, not sepia
  scene.background = new THREE.Color(0xd6dce4);
  scene.fog = new THREE.Fog(0xd6dce4, WORLD_SIZE * 2.2, WORLD_SIZE * 5.5);

  camera = new THREE.PerspectiveCamera(48, width / height, 0.1, WORLD_SIZE * 8);
  camera.position.set(WORLD_SIZE * 0.6, WORLD_SIZE * 0.55, WORLD_SIZE * 0.75);
  camera.lookAt(0, MAX_HEIGHT / 5, 0);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  // Daylight rig: cool sky-blue hemisphere + neutral ambient + crisp white sun
  scene.add(new THREE.HemisphereLight(0xcfdceb, 0x7d8590, 0.65));
  scene.add(new THREE.AmbientLight(0xeef1f5, 0.25));

  const sun = new THREE.DirectionalLight(0xfff6e8, 1.05);
  sun.position.set(WORLD_SIZE * 0.55, WORLD_SIZE * 0.95, WORLD_SIZE * 0.3);
  sun.castShadow = true;
  sun.shadow.mapSize.width = 2048;
  sun.shadow.mapSize.height = 2048;
  sun.shadow.radius = 2.4;
  sun.shadow.camera.left = -WORLD_SIZE * 0.65;
  sun.shadow.camera.right = WORLD_SIZE * 0.65;
  sun.shadow.camera.top = WORLD_SIZE * 0.65;
  sun.shadow.camera.bottom = -WORLD_SIZE * 0.65;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = WORLD_SIZE * 4;
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  // Cool sky-fill from the opposite side to lift shadow cores
  const rim = new THREE.DirectionalLight(0xa9c0da, 0.35);
  rim.position.set(-WORLD_SIZE * 0.5, WORLD_SIZE * 0.6, -WORLD_SIZE * 0.4);
  scene.add(rim);

  // Weather rig — keep hemi/sun/rim references so presets can tune them
  const hemi = scene.children.find(c => c.isHemisphereLight);
  const initialGravity = _gravityFromLeaves(leaves);
  weather = _buildWeather(scene, sun, rim, hemi, initialGravity);
  weather.uiBtn = _mountWeatherButton(container);

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

  // Folder boundaries rendered as flat lines on the ground (no 3D platforms).
  // Line tint shades with folder depth — darker for outer, lighter for inner.
  const internalNodes = [];
  const leafIdSet = new Set(leaves.map(l => l.data.id));
  if (opts.layoutMap) {
    opts.layoutMap.forEach((pos, id) => {
      if (id !== "root" && pos.depth >= 1 && !leafIdSet.has(id)) {
        internalNodes.push({ id, ...pos });
      }
    });
  } else {
    for (const d of layoutRoot.descendants()) {
      if (d.data.id === "root" || d.depth < 1) continue;
      if (!d.children || d.children.length === 0) continue;
      internalNodes.push({ id: d.data.id, x0: d.x0, y0: d.y0, x1: d.x1, y1: d.y1, depth: d.depth });
    }
  }
  // Buildings sit flush on the ground — no tiered platform base.
  const maxTier = 0;

  const LINE_BASE = 0x5c636d;     // folder-line base color (dark grey)
  internalNodes.sort((a, b) => a.depth - b.depth);
  for (const n of internalNodes) {
    const w = n.x1 - n.x0;
    const depth = n.y1 - n.y0;
    if (w < 0.6 || depth < 0.6) continue;
    const cx = n.x0 + w / 2 - WORLD_SIZE / 2;
    const cz = n.y0 + depth / 2 - WORLD_SIZE / 2;
    // Fade line toward the asphalt tone as depth grows (inner folders fade out)
    const fade = Math.min(0.75, 0.15 + n.depth * 0.18);
    const lineCol = new THREE.Color(LINE_BASE).lerp(new THREE.Color(0x8b9098), fade);
    const lineMat = new THREE.LineBasicMaterial({
      color: lineCol,
      transparent: true,
      opacity: Math.max(0.25, 0.75 - n.depth * 0.12),
    });
    const hx = w / 2, hz = depth / 2;
    const pts = [
      new THREE.Vector3(cx - hx, 0.01, cz - hz),
      new THREE.Vector3(cx + hx, 0.01, cz - hz),
      new THREE.Vector3(cx + hx, 0.01, cz + hz),
      new THREE.Vector3(cx - hx, 0.01, cz + hz),
      new THREE.Vector3(cx - hx, 0.01, cz - hz),
    ];
    const geom = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.Line(geom, lineMat);
    scene.add(line);
  }

  // Buildings (leaf files)
  const WINDOW_M = 1.5; // target physical width/height per window cell
  for (const leaf of leaves) {
    const w = leaf.x1 - leaf.x0;
    const depth = leaf.y1 - leaf.y0;
    // Render every file: degenerate tiles get a minimum footprint so no file disappears.
    if ((w <= 0 && depth <= 0)) continue;

    const loc = leaf.data.loc || 0;
    // Height: sqrt-scaled so huge files don't dominate
    const h = Math.max(1, Math.sqrt(loc / maxLoc) * MAX_HEIGHT);

    const color = colorForScore(leaf.data.hotspot_score || 0, renderBands);

    const MIN_BOX = 0.22;
    const bw = Math.max(MIN_BOX, w * 0.92);
    const bd = Math.max(MIN_BOX, depth * 0.92);
    const geom = new THREE.BoxGeometry(bw, h, bd);

    let mesh;
    // Window textures only on clearly-tall buildings where windows read.
    // Raise threshold so short/medium buildings stay plain — less visual noise.
    if (h > 8 && bw > 2.0 && bd > 2.0) {
      const skyscraper = h > MAX_HEIGHT * 0.35;
      const winTex = createBuildingWindowTexture(skyscraper);
      const texX = winTex.clone();
      texX.needsUpdate = true;
      texX.repeat.set(Math.max(1, bd / WINDOW_M / (skyscraper ? 5 : 2)), Math.max(1, h / WINDOW_M / (skyscraper ? 8 : 2)));
      const texZ = winTex.clone();
      texZ.needsUpdate = true;
      texZ.repeat.set(Math.max(1, bw / WINDOW_M / (skyscraper ? 5 : 2)), Math.max(1, h / WINDOW_M / (skyscraper ? 8 : 2)));
      const baseOpts = { color, roughness: 0.72, metalness: 0.05 };
      const matXp = new THREE.MeshStandardMaterial({ ...baseOpts, map: texX });
      const matXn = new THREE.MeshStandardMaterial({ ...baseOpts, map: texX });
      const matZp = new THREE.MeshStandardMaterial({ ...baseOpts, map: texZ });
      const matZn = new THREE.MeshStandardMaterial({ ...baseOpts, map: texZ });
      const matTop = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 });
      const matBot = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0 });
      // BoxGeometry groups order: +X, -X, +Y, -Y, +Z, -Z
      mesh = new THREE.Mesh(geom, [matXp, matXn, matTop, matBot, matZp, matZn]);
    } else {
      const mat = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.7,
        metalness: 0.04,
      });
      mesh = new THREE.Mesh(geom, mat);
    }
    // Buildings sit on top of their deepest folder platform
    const baseY = 0;
    mesh.position.set(
      leaf.x0 + w / 2 - WORLD_SIZE / 2,
      baseY + h / 2,
      leaf.y0 + depth / 2 - WORLD_SIZE / 2,
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = leaf.data;
    mesh.userData._baseY = baseY;
    scene.add(mesh);

    buildings.push({ mesh, baseColor: color.clone() });
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
  const PED_COUNT = 70;
  const pedGeom = new THREE.CylinderGeometry(0.2, 0.22, 0.85, 6);
  const pedMat = new THREE.MeshStandardMaterial({ color: 0x2e3742, roughness: 0.7 });
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
    const PER_SRC = 90;
    const total = smokeSources.length * PER_SRC;
    const positions = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3);
    const ages = new Float32Array(total);
    const lifes = new Float32Array(total);
    const drifts = new Float32Array(total * 2);
    const sources = [];
    for (let s = 0; s < smokeSources.length; s++) {
      const src = smokeSources[s];
      const bh = Math.max(1, Math.sqrt((src.data.loc || 0) / maxLoc) * MAX_HEIGHT);
      const bw = (src.x1 - src.x0) * 0.9;
      const bd = (src.y1 - src.y0) * 0.9;
      const cx = (src.x0 + src.x1) / 2 - WORLD_SIZE / 2;
      const cz = (src.y0 + src.y1) / 2 - WORLD_SIZE / 2;
      // Bind source to its building mesh so emission height follows real-time scale
      const boundBuilding = buildings.find(b => b.mesh.userData.id === src.data.id);
      // 3-5 vents scattered on the rooftop per source
      const ventCount = 3 + Math.floor(Math.random() * 3);
      const vents = [];
      for (let v = 0; v < ventCount; v++) {
        vents.push({
          dx: (Math.random() - 0.5) * bw,
          dz: (Math.random() - 0.5) * bd,
        });
      }
      sources.push({ cx, cz, top: bh, vents, building: boundBuilding || null });
      for (let i = 0; i < PER_SRC; i++) {
        const k = s * PER_SRC + i;
        const v = vents[Math.floor(Math.random() * vents.length)];
        positions[k * 3] = cx + v.dx + (Math.random() - 0.5) * 0.6;
        positions[k * 3 + 1] = bh + Math.random() * 6;
        positions[k * 3 + 2] = cz + v.dz + (Math.random() - 0.5) * 0.6;
        // Cool grey base tint, slight variation
        const g = 0.56 + Math.random() * 0.15;
        colors[k * 3] = g * 0.96;
        colors[k * 3 + 1] = g * 0.98;
        colors[k * 3 + 2] = g * 1.02;
        ages[k] = Math.random();
        lifes[k] = 0.85 + Math.random() * 0.35;
        // Constant wind + per-particle wobble
        drifts[k * 2] = 0.02 + Math.random() * 0.03;
        drifts[k * 2 + 1] = (Math.random() - 0.5) * 0.02;
      }
    }
    const sGeom = new THREE.BufferGeometry();
    sGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    sGeom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const sMat = new THREE.PointsMaterial({
      size: 3.6,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      sizeAttenuation: true,
      vertexColors: true,
    });
    smokeSystem = new THREE.Points(sGeom, sMat);
    smokeSystem.userData = { sources, ages, lifes, drifts, colors, perSrc: PER_SRC, total };
    scene.add(smokeSystem);
  }

  // Controls
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 20;
  controls.maxDistance = WORLD_SIZE * 6;
  controls.maxPolarAngle = Math.PI / 2 - 0.05;
  controls.target.set(0, MAX_HEIGHT / 6, 0);
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
    const col = smokeSystem.geometry.attributes.color.array;
    const { sources, ages, lifes, drifts, colors, perSrc, total } = smokeSystem.userData;
    for (let k = 0; k < total; k++) {
      ages[k] += 0.005;
      if (ages[k] > lifes[k]) {
        const s = Math.floor(k / perSrc);
        const src = sources[s];
        // Live rooftop height: follow current building scale so smoke doesn't
        // float above shrunken buildings after updateCityMetrics.
        let top = src.top;
        if (src.building && src.building.mesh) {
          const m = src.building.mesh;
          if (!m.visible) { ages[k] = 0; continue; }
          const initH = m.userData._initH || 1;
          top = m.position.y + (initH * m.scale.y) / 2;
        }
        const v = src.vents[Math.floor(Math.random() * src.vents.length)];
        pos[k * 3] = src.cx + v.dx + (Math.random() - 0.5) * 0.5;
        pos[k * 3 + 1] = top + 0.3;
        pos[k * 3 + 2] = src.cz + v.dz + (Math.random() - 0.5) * 0.5;
        ages[k] = 0;
        lifes[k] = 0.85 + Math.random() * 0.35;
      } else {
        // Gentle rise + constant wind drift on X, subtle wobble on Z
        pos[k * 3 + 1] += 0.085;
        pos[k * 3] += drifts[k * 2] + (Math.random() - 0.5) * 0.04;
        pos[k * 3 + 2] += drifts[k * 2 + 1] + (Math.random() - 0.5) * 0.04;
      }
      // Fade color toward background as particle ages — cheap alpha proxy
      const t = ages[k] / lifes[k];
      const fade = 1 - t * 0.85;
      col[k * 3] = colors[k * 3] * fade + 0.84 * (1 - fade);
      col[k * 3 + 1] = colors[k * 3 + 1] * fade + 0.86 * (1 - fade);
      col[k * 3 + 2] = colors[k * 3 + 2] * fade + 0.89 * (1 - fade);
    }
    smokeSystem.geometry.attributes.position.needsUpdate = true;
    smokeSystem.geometry.attributes.color.needsUpdate = true;
  }

  let _lastT = performance.now();
  function animate() {
    animId = requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min(50, now - _lastT);
    _lastT = now;
    controls.update();
    _stepTweens(now);
    _stepWeather(weather, scene, dt);
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
      _forEachMat(hovered.material, mm => { if (mm.emissive) mm.emissive.setHex(0x000000); });
    }
    if (newHover && newHover !== hovered) {
      _forEachMat(newHover.material, mm => { mm.emissive = new THREE.Color(0x333333); });
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
