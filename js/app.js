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

  if (!hash) {
    return {
      repo: defaultRepo,
      variant: "clean",
    };
  }

  const parts = hash.split("/");
  const repo = parts[0] || defaultRepo;
  const variant = parts[1] || "clean";

  // Validate repo exists in loaded repos
  const validRepo = names.includes(repo) ? repo : defaultRepo;

  // Validate variant is available for this repo
  const availableVariants = state.repos[validRepo] || ["clean"];
  const validVariant = availableVariants.includes(variant) ? variant : "clean";

  return {
    repo: validRepo,
    variant: validVariant,
  };
}

/**
 * Update URL hash based on current state
 */
function updateURL() {
  const hash = `#${state.currentRepo}/${state.currentVariant}`;
  if (window.location.hash !== hash) {
    window.history.pushState(null, "", hash);
  }
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

async function updateChart() {
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
}

// ========================================
// Event Handlers
// ========================================

/**
 * Handle repository dropdown change
 */
function onRepoChange(event) {
  state.currentRepo = event.target.value;
  updateToggle();
  updateURL();
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
  const { repo, variant } = parseURL();
  state.currentRepo = repo;
  state.currentVariant = variant;
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
  const { repo, variant } = parseURL();
  state.currentRepo = repo;
  state.currentVariant = variant;

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

async function onRegenerate() {
  const granularity = granularitySelect.value;
  const repo = state.currentRepo;
  regenerateBtn.disabled = true;
  regenerateStatus.textContent = `Generating ${repo}...`;

  try {
    await fetchJson(apiUrl("api/regenerate"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ granularity, repo }),
    });
    pollStatus();
  } catch (e) {
    regenerateStatus.textContent = "Error (click for details)";
    regenerateBtn.disabled = false;
    showErrorPopup("Regenerate failed", e.message);
  }
}

async function pollStatus() {
  try {
    const data = await fetchJson(apiUrl("api/status"));

    if (data.running) {
      regenerateStatus.textContent = data.repo
        ? `Generating ${data.repo}...`
        : "Starting...";
      setTimeout(pollStatus, 2000);
    } else if (data.error) {
      regenerateStatus.textContent = "Error (click for details)";
      regenerateBtn.disabled = false;
      showErrorPopup("Regeneration error", data.error);
    } else {
      regenerateStatus.textContent = "Done!";
      regenerateBtn.disabled = false;
      // Clear chart cache and force reload from server
      state.loadedCharts = {};
      await updateChart();
      setTimeout(() => { regenerateStatus.textContent = ""; }, 3000);
    }
  } catch (e) {
    regenerateStatus.textContent = "Error polling status (click for details)";
    regenerateBtn.disabled = false;
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
