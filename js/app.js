import { renderCity, disposeCity, updateCityMetrics, setAutoRotate, buildLayoutMap, sampleRiskGradient } from "./city.js";
import { renderCompare, disposeCompare } from "./compare.js";


// ========================================
// API helpers
// ========================================

/**
 * Build an API URL relative to the page's directory, regardless of whether
 * the page was loaded with a trailing slash. Without this, accessing the app
 * at `/gitcharts` (no slash) resolves `api/...` to `/api/...` and bypasses
 * the reverse-proxy route, returning an HTML 404 page.
 */
function apiUrl(path) {
  let dir = window.location.pathname;
  if (!dir.endsWith("/")) dir += "/";
  return dir + path.replace(/^\//, "");
}

/**
 * Fetch wrapper that surfaces non-JSON responses (e.g. HTML 404 pages from a
 * reverse proxy) as readable errors instead of letting `response.json()` blow
 * up with "unexpected token '<'".
 */
async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const snippet = text.slice(0, 500);
    throw new Error(
      `Server returned non-JSON response (HTTP ${res.status}) for ${url}\n\n${snippet}`
    );
  }
  if (!res.ok) {
    const msg = data.error || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

/**
 * Show a Bootstrap modal popup with a full, scrollable error message.
 */
function showErrorPopup(title, message) {
  let modalEl = document.getElementById("error-popup-modal");
  if (!modalEl) {
    modalEl = document.createElement("div");
    modalEl.id = "error-popup-modal";
    modalEl.className = "modal fade";
    modalEl.tabIndex = -1;
    modalEl.innerHTML = `
      <div class="modal-dialog modal-lg modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title text-danger" id="error-popup-title">Error</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body">
            <pre id="error-popup-body" style="white-space: pre-wrap; word-break: break-word; margin: 0;"></pre>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(modalEl);
  }
  modalEl.querySelector("#error-popup-title").textContent = title;
  modalEl.querySelector("#error-popup-body").textContent = message;
  bootstrap.Modal.getOrCreateInstance(modalEl).show();
}

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
  timeline: null, // { snapshots: [...], index: 0, playing: false, playTimer: null }
  playbackSpeed: 1,
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
let showCoverageCheckbox;

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
  if (segment === "compare") {
    return { repo: validRepo, variant: "clean", view: "compare" };
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
  else if (state.currentView === "compare") segment = "compare";
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
  if (state.hotspotBranch === "develop") return "develop-hotspot";
  if (state.hotspotBranch && state.hotspotBranch !== "main") {
    return `${state.hotspotBranch}-hotspot`;
  }
  return "hotspot";
}

function hotspotBranchSuffix() {
  if (state.hotspotBranch === "develop") return "-develop";
  if (state.hotspotBranch && state.hotspotBranch !== "main") return `-${state.hotspotBranch}`;
  return "";
}

function availableHotspotBranches(repo) {
  const vs = state.repos[repo] || [];
  const out = [];
  if (vs.includes("hotspot")) out.push("main");
  if (vs.includes("hotspot-develop")) out.push("develop");
  for (const v of vs) {
    if (v.startsWith("hotspot-") && v !== "hotspot-develop") {
      out.push(v.slice("hotspot-".length));
    }
  }
  return out;
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

  // Recursively collect all layers (handles nested layer groups)
  function collectLayers(node, out) {
    if (node.encoding) out.push(node);
    if (node.layer) node.layer.forEach(l => collectLayers(l, out));
  }
  const allLayers = [];
  collectLayers(copy, allLayers);

  // Invert layers — apply to ALL encodings
  const sortOrder = state.invertLayers ? "descending" : "ascending";
  allLayers.forEach(l => {
    if (l.encoding?.order) l.encoding.order.sort = sortOrder;
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

    // Filter inline data in all layers (including nested)
    allLayers.forEach(l => {
      if (l.data?.values) {
        l.data.values = filterData(l.data.values);
      }
    });

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

    // Make chart responsive: use container width instead of hardcoded value
    const containerWidth = chartContainer.clientWidth - 32; // account for padding
    if (containerWidth > 0 && containerWidth < (spec.width || 800)) {
      spec = { ...spec, width: containerWidth, height: Math.round(containerWidth * 0.6) };
    }

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

/**
 * Load coverage data JSON for a repo (not a Vega-Lite spec, just data)
 */
async function loadCoverageData(repo) {
  const cacheKey = `${repo}-coverage`;
  if (state.loadedCharts[cacheKey]) return state.loadedCharts[cacheKey];
  try {
    const response = await fetch(`charts/${repo}-coverage.json?t=${Date.now()}`);
    if (!response.ok) return null;
    const data = await response.json();
    state.loadedCharts[cacheKey] = data;
    return data;
  } catch {
    return null;
  }
}

/**
 * Merge coverage data: transforms the chart into covered (viridis) + uncovered (gray)
 * with a dashed red line showing global coverage %.
 * coverageData format: { global_rate: 0.69, rates: { "2025-11-03": 0.42, ... } }
 */
function mergeWithCoverage(spec, coverageData) {
  if (!coverageData || !coverageData.rates) return spec;
  const copy = JSON.parse(JSON.stringify(spec));
  const rates = coverageData.rates;
  const globalRate = coverageData.global_rate;

  // Helper: split data rows into covered + uncovered aggregates
  function splitData(rows, periodField) {
    const coveredRows = [];
    const totals = {}; // commit_date → {covered, total}
    for (const d of rows) {
      const period = d[periodField];
      const rate = rates[period] ?? globalRate;
      const cov = Math.round(d.line_count * rate);
      const row = { commit_date: d.commit_date, line_count: cov };
      row[periodField] = period;
      coveredRows.push(row);
      if (!totals[d.commit_date]) totals[d.commit_date] = { covered: 0, total: 0 };
      totals[d.commit_date].covered += cov;
      totals[d.commit_date].total += d.line_count;
    }
    const uncovAgg = Object.entries(totals)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cd, v]) => ({
        commit_date: cd,
        covered_total: v.covered,
        total: v.total,
        coverage_pct: v.total > 0 ? Math.round(v.covered / v.total * 1000) / 10 : 0,
      }));
    return { coveredRows, uncovAgg };
  }

  // Collect layers and data sources
  const newLayers = [];
  const allUncovAgg = []; // for the red dashed line

  // Process each area layer (main + develop)
  const layers = copy.layer || [{
    data: copy.data, mark: copy.mark, encoding: copy.encoding,
  }];

  for (const layer of layers) {
    const markType = typeof layer.mark === "string" ? layer.mark : layer.mark?.type;

    // Keep non-area layers (tags: rule + text) as-is
    if (markType !== "area") {
      newLayers.push(layer);
      continue;
    }

    // Get data for this area layer
    let rows = [];
    const dataName = layer.data?.name;
    if (dataName && copy.datasets?.[dataName]) {
      rows = copy.datasets[dataName];
    } else if (layer.data?.values) {
      rows = layer.data.values;
    }
    if (rows.length === 0) continue;

    // Detect period field (main uses "period", develop uses "dev_period")
    const periodField = rows[0].dev_period !== undefined ? "dev_period" : "period";
    const isDev = periodField === "dev_period";
    const opacity = isDev ? 0.4 : (typeof layer.mark === "object" ? (layer.mark.opacity ?? 1) : 1);

    const { coveredRows, uncovAgg } = splitData(rows, periodField);
    allUncovAgg.push(...uncovAgg);

    // Covered area layer (viridis colors)
    const colorEnc = layer.encoding?.color ? { ...layer.encoding.color } : {
      field: periodField, type: "ordinal", scale: { scheme: "viridis" },
    };
    newLayers.push({
      data: { values: coveredRows },
      mark: { type: "area", opacity },
      encoding: {
        x: { field: "commit_date", type: "temporal", title: "Date" },
        y: { field: "line_count", type: "quantitative", title: "Lines of Code", stack: true },
        color: colorEnc,
        order: { field: periodField, sort: "ascending" },
      },
    });

    // Uncovered gray area (y to y2) — hide axis to avoid clutter on right
    newLayers.push({
      data: { values: uncovAgg },
      mark: { type: "area", color: "#d5d5d5", opacity },
      encoding: {
        x: { field: "commit_date", type: "temporal" },
        y: { field: "covered_total", type: "quantitative", axis: null },
        y2: { field: "total" },
        tooltip: [
          { field: "commit_date", type: "temporal", title: "Date" },
          { field: "coverage_pct", type: "quantitative", title: "Coverage %" },
          { field: "covered_total", type: "quantitative", title: "Covered" },
          { field: "total", type: "quantitative", title: "Total" },
        ],
      },
    });
  }

  // Red dashed horizontal line with right y-axis (0-100%)
  const covPct = Math.round(globalRate * 1000) / 10;
  const ruleLayer = {
    data: { values: [{ coverage_pct: covPct }] },
    mark: {
      type: "rule",
      color: "#e45756",
      strokeWidth: 2,
      strokeDash: [6, 4],
    },
    encoding: {
      y: {
        field: "coverage_pct",
        type: "quantitative",
        scale: { domain: [0, 100] },
        axis: { orient: "right", title: "Coverage %", titleColor: "#e45756", grid: false },
      },
      tooltip: [
        { field: "coverage_pct", type: "quantitative", title: "Global Coverage %" },
      ],
    },
  };

  // Build final spec — nest area layers in one group, rule in another,
  // so resolve.scale.y: "independent" only separates areas vs rule (not each area from each other)
  const resolve = copy.resolve ? { ...copy.resolve } : {};
  resolve.scale = { ...(resolve.scale || {}), y: "independent" };
  resolve.axis = { ...(resolve.axis || {}), y: "independent" };

  const result = {
    $schema: copy.$schema,
    config: copy.config,
    title: copy.title,
    width: copy.width,
    height: copy.height,
    layer: [
      { layer: newLayers },
      ruleLayer,
    ],
    resolve,
  };

  return result;
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

    // Merge coverage line overlay
    if (showCoverageCheckbox.checked) {
      const coverageData = await loadCoverageData(state.currentRepo);
      if (coverageData) {
        spec = mergeWithCoverage(spec, coverageData);
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
  const suffix = hotspotBranchSuffix();
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
  sel.innerHTML = "";
  const addOpt = (v, label) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = label;
    sel.appendChild(o);
  };
  const branches = availableHotspotBranches(state.currentRepo);
  if (branches.length === 0) branches.push("main");
  for (const b of branches) addOpt(b, b);
  if (!branches.includes(state.hotspotBranch)) {
    state.hotspotBranch = branches[0];
  }
  sel.value = state.hotspotBranch;
}

function scopeFilterNodes(nodes, scope) {
  if (!scope || scope === "all") return nodes;
  return nodes.filter(n =>
    n.id === "root" ||
    n.id === scope ||
    n.id.startsWith(scope + "/")
  );
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
  const max = Math.max(...scores);
  const fmt = v => v < 10 ? v.toFixed(1) : Math.round(v).toString();
  return { max: max || 1, fmt };
}

function cityReadingGuideHTML() {
  const rows = [
    ["Tall + wide + red",      "Big file touched often — classic critical hotspot",            "Split / refactor priority"],
    ["Narrow + tall + red",    "Small file churned constantly (bootstrap, routing, config)",   "Often OK; watch if it grows"],
    ["Wide + short + green",   "Big stable file (DTO, constants, migration)",                  "Ignore"],
    ["Yellow / orange wide",   "Mid-size file touched moderately",                             "Monitor"],
    ["Small + green",          "Small untouched file (utility, enum, interface)",              "Healthy"],
    ["Smoke on roof",          "One of the top 5 risk-score files in the repo",                "Look here first"],
    ["Overcast / storm sky",   "High gravity: many concentrated hotspots",                     "Significant debt in repo"],
  ];
  const body = rows.map(r => `
    <tr>
      <td class="fw-semibold" style="white-space:nowrap">${r[0]}</td>
      <td>${r[1]}</td>
      <td class="text-body-secondary">${r[2]}</td>
    </tr>
  `).join("");
  return `
    <div class="mt-3 pt-2 border-top">
      <div class="fw-semibold mb-2 text-body">How to read the city</div>
      <div class="table-responsive">
        <table class="table table-sm table-borderless mb-1" style="font-size:0.82rem">
          <thead class="text-body-secondary">
            <tr><th>What you see</th><th>Meaning</th><th>Action</th></tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
      <div class="text-body-secondary" style="font-size:0.78rem">
        Rule of thumb: same height &rarr; redder = more urgent. Same color &rarr; taller + wider = bigger refactor payoff.
      </div>
    </div>
  `;
}

function riskBandHTML(b) {
  if (!b) return "";
  const { max, fmt } = b;
  // Bands aligned to the city's linear gradient stops (quartiles of max score).
  // Color chips sampled from the exact same gradient the city renders.
  const stops = [
    { lo: 0,         hi: max * 0.25, label: "Stable, rarely touched",  mid: 0.125 },
    { lo: max*0.25,  hi: max * 0.5,  label: "Low risk",                mid: 0.375 },
    { lo: max*0.5,   hi: max * 0.75, label: "Elevated — watch it",     mid: 0.625 },
    { lo: max*0.75,  hi: max,        label: "Critical hotspot",        mid: 0.9  },
  ];
  const chips = stops.map(s => {
    const col = sampleRiskGradient(s.mid);
    const dark = s.mid > 0.5;
    return `<span><span class="badge" style="background:${col};${dark ? "" : "color:#222"}">${fmt(s.lo)} – ${fmt(s.hi)}</span> ${s.label}</span>`;
  }).join("");
  return `
    <div class="mt-2 pt-2 border-top">
      <div class="fw-semibold mb-1 text-body">Risk score ranges <small class="text-body-secondary fw-normal">(this repository)</small></div>
      <div class="d-flex flex-wrap gap-2" style="font-size:0.82rem">${chips}</div>
      <div class="text-body-secondary mt-1" style="font-size:0.78rem">Bands split by quartile of max score — color chip shows the exact gradient tone in the 3D city at that range.</div>
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
    const readingGuide = state.currentView === "city" ? cityReadingGuideHTML() : "";
    legend.innerHTML = base + riskBandHTML(bands) + readingGuide;
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
    await loadTimeline();
  } catch (error) {
    showError(state.currentRepo, hotspotVariantKey());
    renderInsights(null);
  }
}

function buildUnionMasterNodes(snapshots) {
  const byId = new Map();
  for (const snap of snapshots) {
    for (const n of snap.nodes) {
      if (!byId.has(n.id)) {
        byId.set(n.id, { ...n });
      } else {
        const m = byId.get(n.id);
        m.loc = Math.max(m.loc || 0, n.loc || 0);
        m.changes = Math.max(m.changes || 0, n.changes || 0);
        m.hotspot_score = Math.max(m.hotspot_score || 0, n.hotspot_score || 0);
        if (!m.primary_author && n.primary_author) m.primary_author = n.primary_author;
      }
    }
  }
  return Array.from(byId.values());
}

function snapshotMetricsMap(snap) {
  const map = {};
  for (const n of snap.nodes) {
    if (n.id !== "root") {
      map[n.id] = {
        loc: n.loc || 0,
        changes: n.changes || 0,
        hotspot_score: n.hotspot_score || 0,
        primary_author: n.primary_author || "Unknown",
      };
    }
  }
  return map;
}

async function loadTimeline() {
  if (state.timeline?.playTimer) clearInterval(state.timeline.playTimer);
  state.timeline = null;
  const row = document.getElementById("timeline-row");
  row.style.display = "none";

  const suffix = hotspotBranchSuffix();
  try {
    const res = await fetch(`charts/${state.currentRepo}${suffix}-timeline.json?t=${Date.now()}`);
    if (!res.ok) return false;
    const data = await res.json();
    if (!data.snapshots || data.snapshots.length === 0) return false;
    // Build stable master layout from union of all snapshots, prune files that
    // are dead in the latest snapshot (renamed / deleted), then apply scope.
    const fullMasterNodes = buildUnionMasterNodes(data.snapshots);
    const latest = data.snapshots[data.snapshots.length - 1];
    const liveIds = new Set(
      (latest.nodes || [])
        .filter(n => (n.loc || 0) > 0 || (n.changes || 0) > 0)
        .map(n => n.id)
    );
    const pruned = fullMasterNodes.filter(n => {
      if (n.id === "root") return true;
      // A node survives if it's a live leaf OR a folder with a live descendant
      if (liveIds.has(n.id)) return true;
      for (const id of liveIds) if (id.startsWith(n.id + "/")) return true;
      return false;
    });
    const masterNodes = scopeFilterNodes(pruned, state.hotspotScope);
    const layoutMap = buildLayoutMap(masterNodes);
    state.timeline = {
      snapshots: data.snapshots,
      index: data.snapshots.length - 1,
      playing: false, playTimer: null,
      masterNodes,
      layoutMap,
      scope: state.hotspotScope,
    };
    const slider = document.getElementById("timeline-slider");
    slider.min = 0;
    slider.max = data.snapshots.length - 1;
    slider.value = state.timeline.index;
    row.style.display = "";
    updateTimelineLabel();

    // In city view, render master layout so subsequent snapshots just update metrics in-place
    if (state.currentView === "city" && layoutMap) {
      const baseSpec = state.loadedCharts[`${state.currentRepo}-${hotspotVariantKey()}`]
        || { data: [{ values: masterNodes }] };
      const masterSpec = JSON.parse(JSON.stringify(baseSpec));
      masterSpec.data[0].values = masterNodes;
      renderCity(masterSpec, chartContainer, {
        repo: state.currentRepo,
        branch: state.hotspotBranch,
        scope: state.hotspotScope,
      }, { layoutMap });
      // Apply initial snapshot metrics
      updateCityMetrics(snapshotMetricsMap(data.snapshots[state.timeline.index]), { immediate: true });
      return true;
    }
    return false;
  } catch { return false; }
}

function updateTimelineLabel() {
  if (!state.timeline) return;
  const s = state.timeline.snapshots[state.timeline.index];
  const el = document.getElementById("timeline-label");
  const scope = state.hotspotScope;
  const pos = `${state.timeline.index + 1}/${state.timeline.snapshots.length}`;
  if (scope && scope !== "all") {
    const inScope = s.nodes.filter(n =>
      n.id === scope || n.id.startsWith(scope + "/"),
    );
    const files = inScope.filter(n => (n.loc || 0) > 0 || (n.changes || 0) > 0).length;
    const changes = inScope.reduce((acc, n) => acc + (n.changes || 0), 0);
    el.textContent = `[${pos}] ${s.date} — ${files} files, ${changes} changes (scope: ${scope})`;
  } else {
    el.textContent = `[${pos}] ${s.date} — ${s.file_count} files, ${s.total_changes} changes`;
  }
}

function applyTimelineSnapshot(opts = {}) {
  if (!state.timeline) return;
  const snap = state.timeline.snapshots[state.timeline.index];
  if (state.currentView === "city") {
    // Fast path: update existing buildings in-place (preserves camera + positions)
    updateCityMetrics(snapshotMetricsMap(snap), opts);
  } else {
    // 2D treemap: positions will still shift (Vega recomputes) — acceptable for now
    const baseSpec = state.loadedCharts[`${state.currentRepo}-${hotspotVariantKey()}`];
    if (baseSpec) {
      const overlay = JSON.parse(JSON.stringify(baseSpec));
      overlay.data[0].values = snap.nodes;
      const scoped = filterSpecByScope(overlay, state.hotspotScope);
      renderHotspotChart(scoped);
    }
  }
  renderInsights(
    { hotspots: [], stable: [], warnings: [], suggestions: [], total_files: snap.file_count, total_changes: snap.total_changes, repo: state.currentRepo },
    snap.nodes.filter(n => n.hotspot_score !== undefined).map(n => n.hotspot_score),
  );
  updateTimelineLabel();
}

function onTimelineSliderInput(e) {
  if (!state.timeline) return;
  state.timeline.index = parseInt(e.target.value);
  // Slider drag: snap immediately (user is scrubbing fast, tween would lag behind)
  applyTimelineSnapshot({ immediate: true });
}

function onTimelinePlayToggle() {
  if (!state.timeline) return;
  const btn = document.getElementById("timeline-play-btn");
  if (state.timeline.playing) {
    clearInterval(state.timeline.playTimer);
    state.timeline.playTimer = null;
    state.timeline.playing = false;
    btn.innerHTML = "&#9658;";
    setAutoRotate(false);
    return;
  }
  if (state.timeline.index >= state.timeline.snapshots.length - 1) {
    state.timeline.index = 0;
    document.getElementById("timeline-slider").value = 0;
    applyTimelineSnapshot({ immediate: true });
  }
  state.timeline.playing = true;
  btn.innerHTML = "&#10074;&#10074;";
  setAutoRotate(true);
  state.timeline.playTimer = setInterval(() => {
    const next = state.timeline.index + 1;
    if (next > state.timeline.snapshots.length - 1) {
      clearInterval(state.timeline.playTimer);
      state.timeline.playTimer = null;
      state.timeline.playing = false;
      btn.innerHTML = "&#9658;";
      setAutoRotate(false);
      return;
    }
    state.timeline.index = next;
    document.getElementById("timeline-slider").value = next;
    applyTimelineSnapshot({ tweenMs: 1600 / state.playbackSpeed });
  }, 1300 / state.playbackSpeed);
}

function setPlaybackSpeed(speed) {
  state.playbackSpeed = speed;
  document.querySelectorAll(".timeline-speed-btn").forEach(b => {
    b.classList.toggle("active", parseFloat(b.dataset.speed) === speed);
  });
  // Restart interval with new speed if currently playing
  if (state.timeline?.playing) {
    clearInterval(state.timeline.playTimer);
    state.timeline.playing = false;
    onTimelinePlayToggle();
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
    // Try timeline first; it will render the master layout and apply the latest
    // snapshot in one shot (no double-render flash). Fallback to static spec if
    // this repo has no timeline file.
    const didRender = await loadTimeline();
    if (!didRender) {
      renderCity(scopedSpec, chartContainer, {
        repo: state.currentRepo,
        branch: state.hotspotBranch,
        scope: state.hotspotScope,
      });
    }
    const insights = await loadInsights(state.currentRepo);
    renderInsights(insights, extractScopedRiskScores(scopedSpec));
  } catch (error) {
    console.error(error);
    showError(state.currentRepo, hotspotVariantKey());
    renderInsights(null);
  }
}

async function updateChart() {
  // Dispose previous city/compare renderer if leaving those views
  if (state.currentView !== "city") disposeCity();
  if (state.currentView !== "compare") disposeCompare();
  if (state.currentView === "hotspot") {
    await updateHotspot();
  } else if (state.currentView === "city") {
    await updateCity();
  } else if (state.currentView === "compare") {
    await updateCompare();
  } else {
    document.getElementById("insights-panel").style.display = "none";
    await updateArchaeology();
  }
}

async function updateCompare() {
  showLoading();
  try {
    const branches = availableHotspotBranches(state.currentRepo);
    if (branches.length < 2) {
      chartContainer.innerHTML = '<p class="text-muted">Compare needs at least two branches (main + develop). Regenerate another branch first.</p>';
      document.getElementById("insights-panel").style.display = "none";
      return;
    }
    const specMain = await loadChart(state.currentRepo, "hotspot");
    const second = branches.find(b => b !== "main") || "develop";
    const devKey = second === "develop" ? "develop-hotspot" : `${second}-hotspot`;
    const specDev = await loadChart(state.currentRepo, devKey);
    chartContainer.innerHTML = "";
    chartContainer.className = "";
    renderCompare(chartContainer, specMain, specDev);
    document.getElementById("insights-panel").style.display = "none";
  } catch (error) {
    console.error(error);
    showError(state.currentRepo, "compare");
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
  const btnCompare = document.getElementById("view-btn-compare");
  const compareAvailable = availableHotspotBranches(state.currentRepo).length >= 2;

  // If hotspot/city/compare view requested but not available, fallback
  if ((state.currentView === "hotspot" || state.currentView === "city") && !hotspotAvailable) {
    state.currentView = "archaeology";
  }
  if (state.currentView === "compare" && !compareAvailable) {
    state.currentView = "archaeology";
  }

  btnHot.disabled = !hotspotAvailable;
  btnCity.disabled = !hotspotAvailable;
  if (btnCompare) {
    btnCompare.disabled = !compareAvailable;
    btnCompare.title = compareAvailable ? "" : "Compare needs at least two branches generated";
  }
  const title = hotspotAvailable ? "" : "No hotspot data — regenerate this repo first";
  btnHot.title = title;
  btnCity.title = title;

  btnArch.classList.toggle("active", state.currentView === "archaeology");
  btnHot.classList.toggle("active", state.currentView === "hotspot");
  btnCity.classList.toggle("active", state.currentView === "city");
  if (btnCompare) btnCompare.classList.toggle("active", state.currentView === "compare");

  const isHotspotLike = state.currentView === "hotspot" || state.currentView === "city" || state.currentView === "compare";
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
  if (view === "compare" && availableHotspotBranches(state.currentRepo).length < 2) return;
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
  showCoverageCheckbox = document.getElementById("show-coverage");
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
  showCoverageCheckbox.addEventListener("change", updateChart);
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
  const cmpBtn = document.getElementById("view-btn-compare");
  if (cmpBtn) cmpBtn.addEventListener("click", () => onViewChange("compare"));
  document.getElementById("timeline-slider")
    .addEventListener("input", onTimelineSliderInput);
  document.getElementById("timeline-play-btn")
    .addEventListener("click", onTimelinePlayToggle);
  document.querySelectorAll(".timeline-speed-btn").forEach(btn => {
    btn.addEventListener("click", () => setPlaybackSpeed(parseFloat(btn.dataset.speed)));
  });
  setPlaybackSpeed(1);
  regenerateModal = new bootstrap.Modal(document.getElementById("regenerate-modal"));
  document.getElementById("regen-run-btn").addEventListener("click", runRegenerate);
  document.getElementById("cancel-regenerate-btn").addEventListener("click", onCancelRegenerate);
  document.getElementById("regen-timeline-granularity").addEventListener("change", toggleTimelineCountRow);
  document.getElementById("hotspot-branch")
    .addEventListener("change", onHotspotBranchChange);
  document.getElementById("hotspot-scope")
    .addEventListener("change", onHotspotScopeChange);
  window.addEventListener("popstate", onPopState);

  // Re-render chart on window resize (debounced)
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateChart, 300);
  });

  // Load and render initial chart
  await updateChart();
}

// ========================================
// Regeneration
// ========================================

let regenerateModal;

function onRegenerate() {
  document.getElementById("regen-repo-name").textContent = state.currentRepo;
  document.getElementById("regen-path-prefix").value = "";
  document.getElementById("regen-timeline").value = "0";
  document.getElementById("regen-timeline-granularity").value = "snapshot";
  const branchSel = document.getElementById("regen-branch");
  branchSel.innerHTML = '<option value="">auto (main + develop)</option><option value="" disabled>loading…</option>';
  toggleTimelineCountRow();
  regenerateModal.show();
  // Populate available branches async
  fetch(`/api/branches?repo=${encodeURIComponent(state.currentRepo)}`)
    .then(r => r.json())
    .then(d => {
      const branches = d.branches || [];
      branchSel.innerHTML = '<option value="">auto (main + develop)</option>' +
        branches.map(b => `<option value="${b}">${b}</option>`).join("");
    })
    .catch(() => {
      branchSel.innerHTML = '<option value="">auto (main + develop)</option>';
    });
}

function toggleTimelineCountRow() {
  const gran = document.getElementById("regen-timeline-granularity").value;
  document.getElementById("regen-timeline-count-row").style.display =
    gran === "snapshot" ? "" : "none";
}

async function runRegenerate() {
  const granularity = granularitySelect.value;
  const repo = state.currentRepo;
  const pathPrefix = document.getElementById("regen-path-prefix").value.trim();
  const tlGran = document.getElementById("regen-timeline-granularity").value;
  const timeline = tlGran === "snapshot"
    ? (parseInt(document.getElementById("regen-timeline").value) || 0)
    : 0;
  regenerateModal.hide();
  regenerateBtn.disabled = true;
  document.getElementById("cancel-regenerate-btn").style.display = "";
  regenerateStatus.textContent = `Generating ${repo}...`;
  document.getElementById("progress-row").style.display = "";

  try {
    await fetchJson(apiUrl("api/regenerate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        granularity, repo,
        path_prefix: pathPrefix,
        timeline,
        timeline_granularity: tlGran,
        branch: document.getElementById("regen-branch").value || "",
      }),
    });
    pollStatus();
  } catch (e) {
    regenerateStatus.textContent = "Error (click for details)";
    regenerateBtn.disabled = false;
    document.getElementById("cancel-regenerate-btn").style.display = "none";
    document.getElementById("progress-row").style.display = "none";
    showErrorPopup("Regenerate failed", e.message);
  }
}

function formatETA(sec) {
  if (sec == null || !isFinite(sec)) return "";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

function updateProgressBar(detail) {
  const bar = document.getElementById("progress-bar");
  const label = document.getElementById("progress-label");
  const eta = document.getElementById("progress-eta");
  if (!detail) {
    bar.style.width = "0%";
    bar.textContent = "0%";
    label.textContent = "";
    eta.textContent = "";
    return;
  }
  // Prefer global_pct (bar fills continuously across phases); fallback to stage ratio
  const pct = detail.global_pct != null
    ? detail.global_pct
    : (detail.total ? (detail.current / detail.total) * 100 : 0);
  const clamped = Math.max(0, Math.min(100, pct));
  bar.style.width = clamped.toFixed(1) + "%";
  bar.textContent = clamped.toFixed(0) + "%";
  const stageTxt = detail.stage ? `${detail.stage} — ` : "";
  const subTxt = detail.label ? detail.label : "";
  const ratio = detail.total ? ` (${detail.current}/${detail.total})` : "";
  label.textContent = `${stageTxt}${subTxt}${ratio}`;
  const etaStr = detail.eta != null ? ` · ETA ${formatETA(detail.eta)}` : "";
  eta.textContent = `elapsed ${formatETA(detail.elapsed)}${etaStr}`;
}

async function onCancelRegenerate() {
  try {
    await fetch(apiUrl("api/cancel"), { method: "POST" });
    regenerateStatus.textContent = "Cancelling...";
  } catch (e) {
    regenerateStatus.textContent = "Cancel error (click for details)";
    showErrorPopup("Cancel failed", e.message);
  }
}

async function pollStatus() {
  try {
    const data = await fetchJson(apiUrl("api/status"));

    updateProgressBar(data.detail);

    if (data.running) {
      regenerateStatus.textContent = data.repo
        ? `Generating ${data.repo}...`
        : "Starting...";
      setTimeout(pollStatus, 1000);
    } else if (data.error) {
      regenerateStatus.textContent = "Error (click for details)";
      regenerateBtn.disabled = false;
      document.getElementById("cancel-regenerate-btn").style.display = "none";
      document.getElementById("progress-row").style.display = "none";
      showErrorPopup("Regeneration error", data.error);
    } else {
      regenerateStatus.textContent = "Done!";
      regenerateBtn.disabled = false;
      document.getElementById("cancel-regenerate-btn").style.display = "none";
      document.getElementById("progress-row").style.display = "none";
      state.loadedCharts = {};
      state.repos = await loadRepos();
      updateViewControls();
      await updateChart();
      setTimeout(() => { regenerateStatus.textContent = ""; }, 3000);
    }
  } catch (e) {
    regenerateStatus.textContent = "Error polling status (click for details)";
    regenerateBtn.disabled = false;
    document.getElementById("progress-row").style.display = "none";
    showErrorPopup("Status poll failed", e.message);
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
    const config = await fetchJson(apiUrl("api/config"));
    const entries = Object.entries(config);

    editor.innerHTML = entries
      .map(([name, cfg], i) => createRepoCard(name, cfg, i))
      .join("");

    configStatus.textContent = "";
  } catch (e) {
    configStatus.textContent = "Error loading config (click for details)";
    showErrorPopup("Failed to load config", e.message);
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
    const data = await fetchJson(apiUrl("api/config"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    });
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
    configStatus.textContent = "Error saving (click for details)";
    showErrorPopup("Failed to save config", e.message);
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
