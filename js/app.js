import { renderCity, disposeCity } from "./city.js";

// Application State
const state = {
  repos: {}, // Will be loaded from repos.json: {name: [variants]}
  currentRepo: null,
  currentVariant: "clean",
  currentView: "archaeology", // "archaeology" | "hotspot" | "city"
  hotspotBranch: "main", // "main" | "develop" (auto-selects develop if available)
  hotspotScope: "all", // "all" or top-level dir id
  invertLayers: false,
  loadedCharts: {}, // Cache: {repo-variant: vegaSpec}
};

// DOM Elements
let repoSelect;
let showTagsCheckbox;
let invertCheckbox;
let chartContainer;
let granularitySelect;
let regenerateBtn;
let regenerateStatus;
let dateFrom;
let dateTo;
let showDevelopCheckbox;

// ========================================
// URL State Management
// ========================================

/**
 * Parse URL hash to extract repo and variant
 * Format: #repo-name/variant
 * Example: #human-learn/versioned
 */
function repoNames() {
  return Object.keys(state.repos);
}

function parseURL() {
  const hash = window.location.hash.slice(1); // Remove the '#'
  const names = repoNames();
  const defaultRepo = names[0] || "scikit-lego";

  const defaultFor = (repo) => {
    const vs = state.repos[repo] || [];
    if (vs.includes("clean")) return { variant: "clean", view: "archaeology" };
    if (vs.includes("hotspot")) return { variant: "clean", view: "city" };
    return { variant: "clean", view: "archaeology" };
  };

  if (!hash) {
    return { repo: defaultRepo, ...defaultFor(defaultRepo) };
  }

  const parts = hash.split("/");
  const repo = parts[0] || defaultRepo;
  const segment = parts[1];

  const validRepo = names.includes(repo) ? repo : defaultRepo;
  const availableVariants = state.repos[validRepo] || [];

  if (!segment) return { repo: validRepo, ...defaultFor(validRepo) };

  if (segment === "hotspot" || segment === "city") {
    const view = availableVariants.includes("hotspot") ? segment : "archaeology";
    return { repo: validRepo, variant: "clean", view };
  }

  const validVariant = availableVariants.includes(segment) ? segment : "clean";
  return { repo: validRepo, variant: validVariant, view: "archaeology" };
}

/**
 * Update URL hash based on current state
 */
function updateURL() {
  let segment;
  if (state.currentView === "hotspot") segment = "hotspot";
  else if (state.currentView === "city") segment = "city";
  else segment = state.currentVariant;
  const hash = `#${state.currentRepo}/${segment}`;
  if (window.location.hash !== hash) {
    window.history.pushState(null, "", hash);
  }
}

function hasHotspot(repo) {
  return (state.repos[repo] || []).includes("hotspot");
}

function hasHotspotDevelop(repo) {
  return (state.repos[repo] || []).includes("hotspot-develop");
}

function hotspotVariantKey() {
  return state.hotspotBranch === "develop" ? "develop-hotspot" : "hotspot";
}

// ========================================
// Chart Loading & Rendering
// ========================================

/**
 * Load chart JSON from file
 */
async function loadChart(repo, variant) {
  const cacheKey = `${repo}-${variant}`;

  // Check cache first
  if (state.loadedCharts[cacheKey]) {
    return state.loadedCharts[cacheKey];
  }

  try {
    const response = await fetch(`charts/${repo}-${variant}.json?t=${Date.now()}`);

    if (!response.ok) {
      throw new Error(`Chart not found: ${response.status}`);
    }

    const spec = await response.json();

    // Cache the loaded chart
    state.loadedCharts[cacheKey] = spec;

    return spec;
  } catch (error) {
    console.error("Error loading chart:", error);
    throw error;
  }
}

/**
 * Render chart using Vega-Embed
 */
/**
 * Apply invert layers transformation to a spec (deep clone to avoid mutating cache)
 */
function applyTransforms(spec) {
  const copy = JSON.parse(JSON.stringify(spec));

  // Collect all encodings (top-level or per-layer)
  const encodings = [];
  if (copy.encoding) encodings.push(copy.encoding);
  if (copy.layer) copy.layer.forEach(l => { if (l.encoding) encodings.push(l.encoding); });

  // Invert layers — apply to ALL encodings
  const sortOrder = state.invertLayers ? "descending" : "ascending";
  encodings.forEach(enc => {
    if (enc.order) enc.order.sort = sortOrder;
  });

  // Date range filter — filter inline data values directly
  const from = dateFrom.value;
  const to = dateTo.value;
  if (from || to) {
    const filterData = (values) => {
      return values.filter(d => {
        // Support both commit_date (chart data) and datetime (tag data)
        const date = d.commit_date || d.datetime;
        if (!date) return true;
        if (from && date < from) return false;
        if (to && date > to + "T23:59:59") return false;
        return true;
      });
    };

    // Filter inline data (values arrays) in each layer or top-level
    if (copy.layer) {
      copy.layer.forEach(l => {
        if (l.data?.values) {
          l.data.values = filterData(l.data.values);
        }
      });
    }

    // Filter datasets (named data)
    if (copy.datasets) {
      for (const key of Object.keys(copy.datasets)) {
        copy.datasets[key] = filterData(copy.datasets[key]);
      }
    }
  }

  return copy;
}

async function renderChart(spec) {
  const embedOpt = {
    mode: "vega-lite",
    actions: {
      export: true, // Enable PNG download
      source: false, // Disable view source
      compiled: false, // Disable view compiled Vega
      editor: false, // Disable open in editor
    },
  };

  try {
    // Clear container
    chartContainer.innerHTML = "";
    chartContainer.className = "";

    // Embed chart
    await vegaEmbed("#chart-container", spec, embedOpt);
  } catch (error) {
    console.error("Error rendering chart:", error);
    throw error;
  }
}

/**
 * Show loading state
 */
function showLoading() {
  chartContainer.className = "loading";
  chartContainer.innerHTML = "<p>Loading chart...</p>";
}

/**
 * Show error message
 */
function showError(repo, variant) {
  chartContainer.className = "error";

  // Get the repo URL from repos.txt for the error message
  const repoUrls = {
    "human-learn": "https://github.com/koaning/human-learn",
    "scikit-lego": "https://github.com/koaning/scikit-lego",
  };

  const repoUrl = repoUrls[repo] || `https://github.com/${repo}`;

  chartContainer.innerHTML = `
        <div class="w-100">
            <h5 class="text-danger">Chart Not Available</h5>
            <p>The <strong>${variant}</strong> chart for <strong>${repo}</strong> couldn't be loaded.</p>
            <p class="mb-2">To generate it, run:</p>
            <code>uv run git_archaeology.py --repo ${repoUrl} --samples 200</code>
        </div>
    `;
}

/**
 * Load and render chart for current state
 */
/**
 * Load develop branch chart if available
 */
async function loadDevelopChart(repo, variant) {
  const devVariant = variant === "versioned" ? "develop-versioned" : "develop-clean";
  try {
    return await loadChart(repo, devVariant);
  } catch {
    return null;
  }
}

/**
 * Merge develop data as a transparent continuation after main.
 * Only shows develop commits that are NEWER than the last main commit
 * (i.e. unreleased work on develop not yet merged to main).
 */
function mergeWithDevelop(mainSpec, devSpec) {
  const main = JSON.parse(JSON.stringify(mainSpec));
  const dev = JSON.parse(JSON.stringify(devSpec));

  // Extract data key — handle both flat specs (data.name) and layered specs (layer[0].data.name)
  const mainDataKey = main.data?.name || (main.layer?.[0]?.data?.name);
  const devDataKey = dev.data?.name || (dev.layer?.[0]?.data?.name);
  if (!devDataKey || !dev.datasets?.[devDataKey]) return main;

  const mainData = main.datasets?.[mainDataKey] || [];
  const devData = dev.datasets[devDataKey] || [];

  // Find the latest commit_date in main
  const mainDates = mainData.map(d => d.commit_date);
  const lastMainDate = mainDates.sort().pop();
  if (!lastMainDate) return main;

  // Filter develop data to only commits AFTER the last main commit
  const devDelta = devData.filter(d => d.commit_date > lastMainDate);
  if (devDelta.length === 0) return main;

  // Rename period → dev_period so Vega-Lite creates a separate legend
  const devDeltaRenamed = devDelta.map(d => ({
    commit_date: d.commit_date,
    line_count: d.line_count,
    dev_period: d.period,
  }));

  // Dev delta layer — viridis with reduced opacity + separate legend
  const devLayer = {
    data: { values: devDeltaRenamed },
    mark: { type: "area", opacity: 0.4 },
    encoding: {
      x: { field: "commit_date", type: "temporal" },
      y: { field: "line_count", type: "quantitative" },
      color: {
        field: "dev_period",
        type: "ordinal",
        scale: { scheme: "viridis" },
        legend: { title: "Dev Period", symbolOpacity: 0.4 },
      },
      order: { field: "dev_period", sort: "ascending" },
    },
  };

  // Build main layers — handle both flat spec (mark+encoding) and layered spec (versioned)
  // Force opacity: 1 on main area to contrast with semi-transparent develop
  const layers = [];
  if (main.layer) {
    main.layer.forEach(l => {
      const copy = JSON.parse(JSON.stringify(l));
      const markType = typeof copy.mark === "string" ? copy.mark : copy.mark?.type;
      if (markType === "area") {
        if (typeof copy.mark === "string") copy.mark = { type: "area" };
        copy.mark.opacity = 1;
        if (mainDataKey) copy.data = { values: mainData };
      }
      layers.push(copy);
    });
  } else {
    const mainMark = typeof main.mark === "string" ? { type: main.mark } : { ...main.mark };
    mainMark.opacity = 1;
    layers.push({
      data: { values: mainData },
      mark: mainMark,
      encoding: main.encoding,
    });
  }

  // Add dev layer after main layers
  layers.push(devLayer);

  // Collect all datasets needed (main + dev)
  const allDatasets = { ...(main.datasets || {}) };

  // If dev spec is a layered chart (versioned), extract tag lines (rule + text layers)
  if (dev.layer && dev.layer.length > 1) {
    // Copy dev datasets so tag layers can reference them
    Object.assign(allDatasets, dev.datasets || {});
    dev.layer.forEach(l => {
      const markType = typeof l.mark === "string" ? l.mark : l.mark?.type;
      if (markType === "rule" || markType === "text") {
        layers.push(l);
      }
    });
  }

  return {
    $schema: main.$schema,
    config: main.config,
    datasets: allDatasets,
    title: main.title,
    width: main.width,
    height: main.height,
    layer: layers,
    resolve: { scale: { color: "independent" }, legend: { color: "independent" } },
  };
}

async function updateArchaeology() {
  showLoading();

  try {
    let spec = await loadChart(state.currentRepo, state.currentVariant);

    // Merge develop BEFORE transforms so date filters apply to both layers
    if (showDevelopCheckbox.checked) {
      const devVariant = showTagsCheckbox.checked ? "develop-versioned" : "develop-clean";
      try {
        const devSpec = await loadChart(state.currentRepo, devVariant);
        spec = mergeWithDevelop(spec, devSpec);
      } catch {
        // Develop chart not available — silently ignore
      }
    }

    // Apply transforms (invert, date filter) AFTER merge
    spec = applyTransforms(spec);
    await renderChart(spec);
  } catch (error) {
    showError(state.currentRepo, state.currentVariant);
  }
}

async function loadInsights(repo) {
  const suffix = state.hotspotBranch === "develop" ? "-develop" : "";
  try {
    const res = await fetch(`charts/${repo}${suffix}-insights.json?t=${Date.now()}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function extractTopLevelDirs(spec) {
  const nodes = spec?.data?.[0]?.values || [];
  // A node is a directory if at least one other node has it as parent
  const parentIds = new Set(nodes.map(n => n.parent).filter(Boolean));
  const dirs = [];
  const fileCounts = {};
  for (const n of nodes) {
    if (n.parent === "root" && n.id !== "root" && parentIds.has(n.id)) {
      dirs.push(n.id);
    }
  }
  // Count descendant leaf files per top-level dir
  for (const n of nodes) {
    if (n.parent === "root" || !n.parent) continue;
    if (parentIds.has(n.id)) continue; // skip intermediate dirs, count only files
    const top = n.id.split("/")[0];
    fileCounts[top] = (fileCounts[top] || 0) + 1;
  }
  return dirs
    .map(d => ({ id: d, count: fileCounts[d] || 0 }))
    .sort((a, b) => b.count - a.count);
}

function populateScopeDropdown(spec) {
  const sel = document.getElementById("hotspot-scope");
  const dirs = extractTopLevelDirs(spec);
  const prev = state.hotspotScope;
  sel.innerHTML = '<option value="all">All files</option>';
  for (const d of dirs) {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = `${d.id}/ (${d.count})`;
    sel.appendChild(opt);
  }
  // Preserve previous scope if still valid
  if (prev && (prev === "all" || dirs.some(d => d.id === prev))) {
    sel.value = prev;
  } else {
    sel.value = "all";
    state.hotspotScope = "all";
  }
}

function populateBranchDropdown() {
  const sel = document.getElementById("hotspot-branch");
  const hasDev = hasHotspotDevelop(state.currentRepo);
  sel.innerHTML = "";
  const addOpt = (v, label) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  };
  addOpt("main", "main");
  if (hasDev) addOpt("develop", "develop");
  sel.value = state.hotspotBranch;
}

function filterSpecByScope(spec, scope) {
  if (scope === "all") return spec;
  const copy = JSON.parse(JSON.stringify(spec));
  const values = copy.data[0].values || [];
  const filtered = values.filter(n =>
    n.id === "root" ||
    n.id === scope ||
    n.id.startsWith(scope + "/")
  );
  copy.data[0].values = filtered;
  return copy;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function buildRiskBands(scores) {
  if (!scores || scores.length === 0) return null;
  const sorted = scores.slice().sort((a, b) => a - b);
  const pct = p => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)))];
  const fmt = v => v < 10 ? v.toFixed(1) : Math.round(v).toString();
  return {
    p50: pct(0.5), p75: pct(0.75), p90: pct(0.9), max: sorted[sorted.length - 1],
    fmt,
  };
}

function riskBandHTML(b) {
  if (!b) return "";
  const { p50, p75, p90, max, fmt } = b;
  return `
    <div class="mt-2 pt-2 border-top">
      <div class="fw-semibold mb-1 text-body">Risk score ranges <small class="text-body-secondary fw-normal">(this repository)</small></div>
      <div class="d-flex flex-wrap gap-2" style="font-size:0.82rem">
        <span><span class="badge" style="background:#1a9641">0 – ${fmt(p50)}</span> Stable, rarely touched</span>
        <span><span class="badge" style="background:#a6d96a;color:#222">${fmt(p50)} – ${fmt(p75)}</span> Low risk</span>
        <span><span class="badge" style="background:#fdae61;color:#222">${fmt(p75)} – ${fmt(p90)}</span> Elevated — watch it</span>
        <span><span class="badge" style="background:#d7191c">${fmt(p90)} – ${fmt(max)}</span> Critical hotspot</span>
      </div>
      <div class="text-body-secondary mt-1" style="font-size:0.78rem">Bands split at median, 75th, and 90th percentiles of this repo's file scores.</div>
    </div>
  `;
}

function renderInsights(insights, riskScores) {
  const panel = document.getElementById("insights-panel");
  if (!insights) { panel.style.display = "none"; return; }
  panel.style.display = "";

  const bands = buildRiskBands(riskScores);
  const legend = document.getElementById("insights-legend");
  if (legend) {
    const base = state.currentView === "city"
      ? `
        <strong>Height</strong> = lines of code (LOC). Tall tower = big file.<br>
        <strong>Footprint</strong> = number of modifications. Wide base = frequently changed.<br>
        <strong>Color</strong> = risk score (changes &times; log LOC). <span class="text-danger fw-semibold">Red</span> = likely technical debt. <span class="text-success fw-semibold">Green</span> = stable.<br>
        <span class="text-body-secondary">Drag to rotate · scroll to zoom · hover for details.</span>
      `
      : `
        <strong>Size</strong> = lines of code (LOC). Bigger rectangle = bigger file.<br>
        <strong>Color</strong> = risk score (changes &times; log LOC). <span class="text-danger fw-semibold">Red</span> = high change frequency &amp; large file = likely technical debt. <span class="text-success fw-semibold">Green</span> = stable or small.
      `;
    legend.innerHTML = base + riskBandHTML(bands);
  }

  const hotspotsEl = document.getElementById("insights-hotspots");
  if (insights.hotspots?.length) {
    hotspotsEl.innerHTML = insights.hotspots.map(h => `
      <div class="mb-2">
        <div class="fw-semibold"><code>${escapeHTML(h.file)}</code></div>
        <div class="text-muted">${escapeHTML(h.reason)} <span class="text-body-secondary">(main author: ${escapeHTML(h.primary_author)})</span></div>
      </div>
    `).join("");
  } else {
    hotspotsEl.innerHTML = '<span class="text-muted">No hotspots detected.</span>';
  }

  const stableEl = document.getElementById("insights-stable");
  if (insights.stable?.length) {
    stableEl.innerHTML = insights.stable.map(s => `
      <div class="mb-2">
        <div class="fw-semibold"><code>${escapeHTML(s.path)}/</code></div>
        <div class="text-muted">${escapeHTML(s.reason)}</div>
      </div>
    `).join("");
  } else {
    stableEl.innerHTML = '<span class="text-muted">No clearly stable area detected.</span>';
  }

  const warningsEl = document.getElementById("insights-warnings");
  if (insights.warnings?.length) {
    warningsEl.innerHTML = insights.warnings.map(w => `<div class="mb-2">${escapeHTML(w)}</div>`).join("");
  } else {
    warningsEl.innerHTML = '<span class="text-muted">No anomalies detected.</span>';
  }

  const suggestionsEl = document.getElementById("insights-suggestions");
  if (insights.suggestions?.length) {
    suggestionsEl.innerHTML = insights.suggestions.map(s => `<div class="mb-2">${escapeHTML(s)}</div>`).join("");
  } else {
    suggestionsEl.innerHTML = '<span class="text-muted">No specific suggestions.</span>';
  }
}

async function renderHotspotChart(spec) {
  chartContainer.innerHTML = "";
  chartContainer.className = "";
  await vegaEmbed("#chart-container", spec, {
    actions: { export: true, source: false, compiled: false, editor: false },
  });
}

function extractScopedRiskScores(spec) {
  const nodes = spec?.data?.[0]?.values || [];
  return nodes
    .filter(n => n.hotspot_score !== undefined && n.parent && n.parent !== null && n.id !== "root")
    .map(n => n.hotspot_score);
}

async function updateHotspot() {
  showLoading();
  try {
    const spec = await loadChart(state.currentRepo, hotspotVariantKey());
    populateScopeDropdown(spec);
    const scopedSpec = filterSpecByScope(spec, state.hotspotScope);
    await renderHotspotChart(scopedSpec);
    const insights = await loadInsights(state.currentRepo);
    renderInsights(insights, extractScopedRiskScores(scopedSpec));
  } catch (error) {
    showError(state.currentRepo, hotspotVariantKey());
    renderInsights(null);
  }
}

async function updateCity() {
  showLoading();
  try {
    const spec = await loadChart(state.currentRepo, hotspotVariantKey());
    populateScopeDropdown(spec);
    const scopedSpec = filterSpecByScope(spec, state.hotspotScope);
    chartContainer.innerHTML = "";
    chartContainer.className = "";
    renderCity(scopedSpec, chartContainer, {
      repo: state.currentRepo,
      branch: state.hotspotBranch,
      scope: state.hotspotScope,
    });
    const insights = await loadInsights(state.currentRepo);
    renderInsights(insights, extractScopedRiskScores(scopedSpec));
  } catch (error) {
    console.error(error);
    showError(state.currentRepo, hotspotVariantKey());
    renderInsights(null);
  }
}

async function updateChart() {
  // Dispose previous city renderer if leaving city view
  if (state.currentView !== "city") {
    disposeCity();
  }
  if (state.currentView === "hotspot") {
    await updateHotspot();
  } else if (state.currentView === "city") {
    await updateCity();
  } else {
    document.getElementById("insights-panel").style.display = "none";
    await updateArchaeology();
  }
}

// ========================================
// UI Update Functions
// ========================================

/**
 * Update dropdown selection
 */
function updateDropdown() {
  repoSelect.value = state.currentRepo;
}

/**
 * Update toggle selection
 */
function updateToggle() {
  showTagsCheckbox.checked = state.currentVariant === "versioned";
}

/**
 * Update all UI elements to reflect current state
 */
function updateUI() {
  updateDropdown();
  updateToggle();
  updateViewControls();
}

function updateViewControls() {
  const hotspotAvailable = hasHotspot(state.currentRepo);
  const btnArch = document.getElementById("view-btn-archaeology");
  const btnHot = document.getElementById("view-btn-hotspot");
  const btnCity = document.getElementById("view-btn-city");

  // If hotspot/city view requested but not available, fallback to archaeology
  if ((state.currentView === "hotspot" || state.currentView === "city") && !hotspotAvailable) {
    state.currentView = "archaeology";
  }

  btnHot.disabled = !hotspotAvailable;
  btnCity.disabled = !hotspotAvailable;
  const title = hotspotAvailable ? "" : "No hotspot data — regenerate this repo first";
  btnHot.title = title;
  btnCity.title = title;

  btnArch.classList.toggle("active", state.currentView === "archaeology");
  btnHot.classList.toggle("active", state.currentView === "hotspot");
  btnCity.classList.toggle("active", state.currentView === "city");

  const isHotspotLike = state.currentView === "hotspot" || state.currentView === "city";
  document.querySelectorAll(".archaeology-only").forEach(el => {
    el.style.display = isHotspotLike ? "none" : "";
  });
  document.querySelectorAll(".hotspot-only").forEach(el => {
    el.style.display = isHotspotLike ? "" : "none";
  });
  if (!isHotspotLike) {
    document.getElementById("insights-panel").style.display = "none";
  } else {
    if (hasHotspotDevelop(state.currentRepo) && state.hotspotBranch === "main") {
      state.hotspotBranch = "develop";
    }
    if (!hasHotspotDevelop(state.currentRepo)) {
      state.hotspotBranch = "main";
    }
    populateBranchDropdown();
  }
}

function onViewChange(view) {
  if (view === state.currentView) return;
  if ((view === "hotspot" || view === "city") && !hasHotspot(state.currentRepo)) return;
  state.currentView = view;
  updateViewControls();
  updateURL();
  updateChart();
}

// ========================================
// Event Handlers
// ========================================

/**
 * Handle repository dropdown change
 */
function onRepoChange(event) {
  state.currentRepo = event.target.value;
  // Reset scope — dirs differ per repo
  state.hotspotScope = "all";
  // Auto-default branch to develop if available for new repo
  state.hotspotBranch = hasHotspotDevelop(state.currentRepo) ? "develop" : "main";
  // Fallback to archaeology if new repo lacks hotspot
  if (state.currentView === "hotspot" && !hasHotspot(state.currentRepo)) {
    state.currentView = "archaeology";
  }
  updateToggle();
  updateViewControls();
  updateURL();
  updateChart();
}

function onHotspotBranchChange(event) {
  state.hotspotBranch = event.target.value;
  state.hotspotScope = "all"; // reset scope when switching branches
  updateChart();
}

function onHotspotScopeChange(event) {
  state.hotspotScope = event.target.value;
  updateChart();
}

/**
 * Handle variant toggle change
 */
function onVariantChange(event) {
  state.currentVariant = event.target.checked ? "versioned" : "clean";
  updateURL();
  updateChart();
}

/**
 * Handle invert layers toggle
 */
function onInvertChange(event) {
  state.invertLayers = event.target.checked;
  updateChart();
}

/**
 * Handle browser back/forward navigation
 */
function onPopState() {
  const { repo, variant, view } = parseURL();
  state.currentRepo = repo;
  state.currentVariant = variant;
  state.currentView = view;
  updateUI();
  updateChart();
}

// ========================================
// Initialization
// ========================================

/**
 * Load repositories list from repos.json
 */
async function loadRepos() {
  try {
    const response = await fetch("charts/repos.json");
    if (!response.ok) {
      throw new Error(`Failed to load repos: ${response.status}`);
    }
    const data = await response.json();

    // Handle legacy array format: ["repo1", "repo2"]
    if (Array.isArray(data)) {
      const obj = {};
      await Promise.all(
        data.map(async (repo) => {
          const variants = ["clean"];
          const res = await fetch(`charts/${repo}-versioned.json`, { method: "HEAD" });
          if (res.ok) variants.push("versioned");
          obj[repo] = variants;
        })
      );
      return obj;
    }

    return data;
  } catch (error) {
    console.error("Error loading repos:", error);
    return {};
  }
}

/**
 * Populate dropdown with repositories
 */
function populateDropdown() {
  repoSelect.innerHTML = "";

  repoNames().forEach((repo) => {
    const option = document.createElement("option");
    option.value = repo;
    option.textContent = repo;
    repoSelect.appendChild(option);
  });
}

/**
 * Initialize the application
 */
async function init() {
  // Get DOM elements
  repoSelect = document.getElementById("repo-select");
  invertCheckbox = document.getElementById("invert-layers");
  chartContainer = document.getElementById("chart-container");
  granularitySelect = document.getElementById("granularity-select");
  regenerateBtn = document.getElementById("regenerate-btn");
  regenerateStatus = document.getElementById("regenerate-status");
  dateFrom = document.getElementById("date-from");
  dateTo = document.getElementById("date-to");
  showDevelopCheckbox = document.getElementById("show-develop");
  showTagsCheckbox = document.getElementById("show-tags");

  // Load repositories list
  state.repos = await loadRepos();

  // Populate dropdown
  populateDropdown();

  // Parse URL and set initial state
  const { repo, variant, view } = parseURL();
  state.currentRepo = repo;
  state.currentVariant = variant;
  state.currentView = view;
  state.hotspotBranch = hasHotspotDevelop(state.currentRepo) ? "develop" : "main";

  // Update UI to reflect initial state
  updateUI();

  // Settings modal
  settingsModal = new bootstrap.Modal(document.getElementById("settings-modal"));
  document.getElementById("settings-btn").addEventListener("click", openSettings);
  document.getElementById("add-repo-btn").addEventListener("click", addRepoCard);
  document.getElementById("save-config-btn").addEventListener("click", saveConfig);
  document.getElementById("config-editor").addEventListener("click", onEditorClick);

  // Set up event listeners
  repoSelect.addEventListener("change", onRepoChange);
  showTagsCheckbox.addEventListener("change", onVariantChange);
  invertCheckbox.addEventListener("change", onInvertChange);
  regenerateBtn.addEventListener("click", onRegenerate);
  dateFrom.addEventListener("change", updateChart);
  dateTo.addEventListener("change", updateChart);
  showDevelopCheckbox.addEventListener("change", updateChart);
  document.getElementById("reset-dates-btn").addEventListener("click", () => {
    dateFrom.value = "";
    dateTo.value = "";
    updateChart();
  });
  document.getElementById("view-btn-archaeology")
    .addEventListener("click", () => onViewChange("archaeology"));
  document.getElementById("view-btn-hotspot")
    .addEventListener("click", () => onViewChange("hotspot"));
  document.getElementById("view-btn-city")
    .addEventListener("click", () => onViewChange("city"));
  document.getElementById("hotspot-branch")
    .addEventListener("change", onHotspotBranchChange);
  document.getElementById("hotspot-scope")
    .addEventListener("change", onHotspotScopeChange);
  window.addEventListener("popstate", onPopState);

  // Load and render initial chart
  await updateChart();
}

// ========================================
// Regeneration
// ========================================

async function onRegenerate() {
  const granularity = granularitySelect.value;
  const repo = state.currentRepo;
  regenerateBtn.disabled = true;
  regenerateStatus.textContent = `Generating ${repo}...`;

  try {
    const res = await fetch("/api/regenerate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ granularity, repo }),
    });
    const data = await res.json();
    if (data.error) {
      regenerateStatus.textContent = data.error;
      regenerateBtn.disabled = false;
      return;
    }
    pollStatus();
  } catch (e) {
    regenerateStatus.textContent = "Error: " + e.message;
    regenerateBtn.disabled = false;
  }
}

async function pollStatus() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();

    if (data.running) {
      regenerateStatus.textContent = data.repo
        ? `Generating ${data.repo}...`
        : "Starting...";
      setTimeout(pollStatus, 2000);
    } else if (data.error) {
      regenerateStatus.textContent = "Error: " + data.error;
      regenerateBtn.disabled = false;
    } else {
      regenerateStatus.textContent = "Done!";
      regenerateBtn.disabled = false;
      // Clear chart cache and reload repos list (hotspot variant may have appeared)
      state.loadedCharts = {};
      state.repos = await loadRepos();
      updateViewControls();
      await updateChart();
      setTimeout(() => { regenerateStatus.textContent = ""; }, 3000);
    }
  } catch (e) {
    regenerateStatus.textContent = "Error polling status";
    regenerateBtn.disabled = false;
  }
}

// ========================================
// Settings Modal
// ========================================

let settingsModal;

function createRepoCard(name, config, index) {
  return `
    <div class="card mb-3 repo-card" data-index="${index}">
      <div class="card-body">
        <div class="d-flex justify-content-between align-items-start mb-2">
          <h6 class="card-title mb-0">
            <input type="text" class="form-control form-control-sm d-inline-block" style="width:auto"
              value="${name}" data-field="name" placeholder="repo-name">
          </h6>
          <button class="btn btn-outline-danger btn-sm remove-repo-btn" title="Remove">&times;</button>
        </div>
        <div class="mb-2">
          <label class="form-label small mb-1">Repository URL</label>
          <input type="text" class="form-control form-control-sm" value="${config.url}" data-field="url"
            placeholder="https://github.com/user/repo">
        </div>
        <div class="mb-2">
          <label class="form-label small mb-1">File extensions</label>
          <input type="text" class="form-control form-control-sm" value="${config.extensions}" data-field="extensions"
            placeholder=".ts,.js,.py,...">
        </div>
        <div>
          <label class="form-label small mb-1">Max samples</label>
          <input type="number" class="form-control form-control-sm" style="width:120px"
            value="${config.samples}" data-field="samples" min="1">
        </div>
      </div>
    </div>`;
}

async function openSettings() {
  const editor = document.getElementById("config-editor");
  const configStatus = document.getElementById("config-status");
  configStatus.textContent = "Loading...";

  try {
    const res = await fetch("/api/config");
    const config = await res.json();
    const entries = Object.entries(config);

    editor.innerHTML = entries
      .map(([name, cfg], i) => createRepoCard(name, cfg, i))
      .join("");

    configStatus.textContent = "";
  } catch (e) {
    configStatus.textContent = "Error loading config";
  }

  settingsModal.show();
}

function addRepoCard() {
  const editor = document.getElementById("config-editor");
  const index = editor.querySelectorAll(".repo-card").length;
  const defaultExt = ".dart,.swift,.h,.cpp,.cc,.c,.m,.mm,.kts,.kt,.java,.xml,.yaml,.yml,.json,.sql,.mjs,.js,.ts,.tsx,.jsx,.css,.scss,.html,.py,.sh,.bash,.zsh,.rb,.go,.rs,.cs,.csproj,.cshtml,.razor,.r,.lua,.php,.pl,.ex,.exs,.erl,.hs,.scala,.groovy,.gradle,.cmake,.makefile,.dockerfile,.tf,.hcl,.proto,.graphql,.gql,.toml,.ini,.cfg,.conf,.env,.properties,.plist,.entitlements,.pbxproj,.xcconfig,.xcworkspacedata,.storyboard,.xib,.nib,.md,.rst,.txt,.svg,.prisma,.http,.slnx,.sln,.lock";
  editor.insertAdjacentHTML("beforeend", createRepoCard("", { url: "", extensions: defaultExt, samples: 9999 }, index));
}

async function saveConfig() {
  const configStatus = document.getElementById("config-status");
  const cards = document.querySelectorAll(".repo-card");
  const config = {};

  for (const card of cards) {
    const name = card.querySelector('[data-field="name"]').value.trim();
    const url = card.querySelector('[data-field="url"]').value.trim();
    const extensions = card.querySelector('[data-field="extensions"]').value.trim();
    const samples = parseInt(card.querySelector('[data-field="samples"]').value) || 9999;

    if (!name || !url) continue;
    config[name] = { url, extensions, samples };
  }

  configStatus.textContent = "Saving...";

  try {
    const res = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
    const data = await res.json();
    if (data.saved) {
      configStatus.textContent = "Saved!";
      // Reload repos list and dropdown
      state.repos = await loadRepos();
      populateDropdown();
      const { repo, variant } = parseURL();
      state.currentRepo = repo;
      state.currentVariant = variant;
      updateUI();
      setTimeout(() => settingsModal.hide(), 1000);
    }
  } catch (e) {
    configStatus.textContent = "Error saving: " + e.message;
  }
}

function onEditorClick(e) {
  if (e.target.classList.contains("remove-repo-btn")) {
    e.target.closest(".repo-card").remove();
  }
}

// Start the application when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
