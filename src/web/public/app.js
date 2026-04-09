// Petri Dashboard — Frontend Application

// ── State ──
let currentProject = null;
let projects = [];
let currentRunId = null;
let currentRunData = null;
let currentStageIndex = -1;
let eventSource = null;
let currentConfigPath = null;

// Create tab state
let generateDescription = null;
let generatedFiles = [];
let generatedStatus = null;
let generatedErrors = [];
let selectedGeneratedFile = null;

// ── API Helper ──
function apiUrl(urlPath) {
  if (!currentProject) return urlPath;
  const sep = urlPath.includes("?") ? "&" : "?";
  return urlPath + sep + "project=" + encodeURIComponent(currentProject);
}

async function api(urlPath, opts = {}) {
  try {
    const res = await fetch(apiUrl(urlPath), {
      headers: opts.body ? { "Content-Type": "application/json" } : {},
      ...opts,
    });
    const contentType = res.headers.get("content-type") || "";
    let data;
    if (contentType.includes("application/json")) {
      data = await res.json();
    } else {
      data = await res.text();
    }
    return { status: res.status, data };
  } catch (err) {
    return { status: 0, data: { error: err.message } };
  }
}

// ── Helpers ──
function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function formatDuration(ms) {
  if (ms == null) return "-";
  if (ms < 1000) return ms + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return (ms / 60000).toFixed(1) + "m";
}

function formatTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDate(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatCost(usd) {
  if (usd == null) return "-";
  return "$" + usd.toFixed(4);
}

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

// ── Init ──
document.addEventListener("DOMContentLoaded", () => {
  // Main tab switching
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      $$(".tab").forEach((t) => t.classList.remove("active"));
      $$(".tab-content").forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + target)?.classList.add("active");

      if (target === "dashboard") loadDashboard();
      if (target === "runs") loadRunsTab();
      if (target === "config") loadConfigTab();
      if (target === "create") loadCreateTab();
    });
  });

  // Sub-tab switching (detail panel)
  $$(".sub-tab").forEach((st) => {
    st.addEventListener("click", () => {
      const target = st.dataset.subtab;
      $$(".sub-tab").forEach((s) => s.classList.remove("active"));
      $$(".sub-tab-content").forEach((c) => c.classList.remove("active"));
      st.classList.add("active");
      document.getElementById("subtab-" + target)?.classList.add("active");
    });
  });

  // Run button
  $("#run-start-btn").addEventListener("click", startNewRun);

  // Save button
  $("#editor-save-btn").addEventListener("click", saveConfigFile);

  // Back to runs list
  $("#back-to-runs").addEventListener("click", showRunsList);

  // Create tab buttons
  $("#create-generate-btn").addEventListener("click", startGenerate);
  $("#gen-editor-save-btn").addEventListener("click", saveGeneratedFile);
  $("#create-validate-btn").addEventListener("click", validateGenerated);
  $("#create-confirm-btn").addEventListener("click", confirmAndRun);
  $("#create-regen-btn").addEventListener("click", showCreateInput);

  // Prompt toggle (collapse/expand)
  document.addEventListener("click", (e) => {
    if (e.target.closest("#io-prompt-toggle")) {
      const el = $("#io-prompt");
      el.classList.toggle("collapsed");
      const toggle = e.target.closest("#io-prompt-toggle").querySelector(".io-toggle");
      if (toggle) toggle.textContent = el.classList.contains("collapsed") ? "\u25B6" : "\u25BC";
    }
  });

  // Load projects then dashboard
  loadProjects();
});

// ── Project Selector ──
async function loadProjects() {
  const res = await fetch("/api/projects");
  if (res.ok) projects = await res.json();

  if (projects.length > 1) {
    const selector = $("#project-selector");
    const select = $("#project-select");
    selector.style.display = "";
    select.innerHTML = projects.map((p) =>
      `<option value="${escAttr(p)}">${escHtml(p)}</option>`
    ).join("");
    currentProject = projects[0];
    select.addEventListener("change", () => {
      currentProject = select.value;
      resetState();
      loadDashboard();
    });
  } else if (projects.length === 1) {
    currentProject = projects[0];
  }

  loadDashboard();
}

function resetState() {
  currentRunId = null;
  currentRunData = null;
  currentStageIndex = -1;
  currentConfigPath = null;
  if (eventSource) { eventSource.close(); eventSource = null; }
}

// ══════════════════════════════════════
// ── Dashboard Tab: Overview
// ══════════════════════════════════════

async function loadDashboard() {
  const res = await api("/api/runs");
  const runs = (res.status === 200 && Array.isArray(res.data)) ? res.data : [];

  // Stats cards
  const total = runs.length;
  const done = runs.filter((r) => r.status === "done").length;
  const blocked = runs.filter((r) => r.status === "blocked").length;
  const running = runs.filter((r) => r.status === "running").length;
  const totalCost = runs.reduce((sum, r) => sum + (r.totalUsage?.costUsd || 0), 0);
  const successRate = total > 0 ? Math.round((done / total) * 100) : 0;

  $("#stats-cards").innerHTML = `
    <div class="stat-card">
      <div class="stat-value">${total}</div>
      <div class="stat-label">Total Runs</div>
    </div>
    <div class="stat-card">
      <div class="stat-value stat-success">${successRate}%</div>
      <div class="stat-label">Success Rate</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${running}</div>
      <div class="stat-label">Running</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">${formatCost(totalCost)}</div>
      <div class="stat-label">Total Cost</div>
    </div>
  `;

  // Recent runs table (latest 10)
  const sorted = runs.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  const recent = sorted.slice(0, 10);
  const tbody = $("#overview-runs-tbody");
  const emptyMsg = $("#overview-runs-empty");

  if (recent.length > 0) {
    emptyMsg.style.display = "none";
    $("#overview-runs-table").style.display = "table";
    tbody.innerHTML = recent.map((r) => renderRunRow(r)).join("");
    tbody.querySelectorAll("tr").forEach((row) => {
      row.addEventListener("click", () => openRunDetail(row.dataset.runid));
    });
  } else {
    emptyMsg.style.display = "block";
    $("#overview-runs-table").style.display = "none";
    tbody.innerHTML = "";
  }
}

// ══════════════════════════════════════
// ── Runs Tab: List + Detail
// ══════════════════════════════════════

function showRunsList() {
  currentRunId = null;
  currentRunData = null;
  currentStageIndex = -1;
  if (eventSource) { eventSource.close(); eventSource = null; }
  $("#runs-list-view").style.display = "";
  $("#runs-detail-view").style.display = "none";
  loadRunsTab();
}

function openRunDetail(runId) {
  // Switch to Runs tab if not already there
  switchToTab("runs");
  $("#runs-list-view").style.display = "none";
  $("#runs-detail-view").style.display = "";
  loadRun(runId);
}

async function loadRunsTab() {
  // Make sure we're on list view
  if (currentRunId) return; // detail view is showing, don't overwrite

  // Populate pipeline dropdown
  const configRes = await api("/api/config/files");
  const pipelineSelect = $("#run-pipeline");
  if (configRes.status === 200 && Array.isArray(configRes.data)) {
    const pipelineFiles = configRes.data.filter((f) =>
      typeof f === "string" ? f.match(/pipeline.*\.yaml$/i) : (f.path || "").match(/pipeline.*\.yaml$/i)
    );
    pipelineSelect.innerHTML = pipelineFiles.map((f) => {
      const p = typeof f === "string" ? f : f.path;
      return `<option value="${escAttr(p)}">${escHtml(p)}</option>`;
    }).join("");
    if (pipelineFiles.length === 0) {
      pipelineSelect.innerHTML = '<option value="">No pipelines found</option>';
    }
  }

  // Load run history
  const runsRes = await api("/api/runs");
  const tbody = $("#runs-tbody");
  const emptyMsg = $("#runs-empty");

  if (runsRes.status === 200 && Array.isArray(runsRes.data) && runsRes.data.length > 0) {
    const runs = runsRes.data.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    emptyMsg.style.display = "none";
    $("#runs-table").style.display = "table";
    tbody.innerHTML = runs.map((r) => renderRunRow(r)).join("");
    tbody.querySelectorAll("tr").forEach((row) => {
      row.addEventListener("click", () => openRunDetail(row.dataset.runid));
    });
  } else {
    emptyMsg.style.display = "block";
    $("#runs-table").style.display = "none";
    tbody.innerHTML = "";
  }
}

function renderRunRow(r) {
  const usage = r.totalUsage || {};
  return `
    <tr data-runid="${escAttr(r.runId)}">
      <td>run-${escHtml(r.runId)}</td>
      <td>${escHtml(r.pipeline)}</td>
      <td><span class="status-badge ${r.status}">${escHtml(r.status)}</span></td>
      <td>${formatDate(r.startedAt)}</td>
      <td>${formatDuration(r.durationMs)}</td>
      <td>${formatCost(usage.costUsd)}</td>
    </tr>
  `;
}

async function startNewRun() {
  const btn = $("#run-start-btn");
  const errorEl = $("#run-error");
  const pipeline = $("#run-pipeline").value;
  const input = $("#run-input").value.trim();

  errorEl.textContent = "";
  if (!input) { errorEl.textContent = "Input is required."; return; }

  btn.disabled = true;
  btn.textContent = "Starting...";

  const body = { input };
  if (pipeline) body.pipeline = pipeline;

  const res = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify(body),
  });

  btn.disabled = false;
  btn.textContent = "Run";

  if (res.status === 200 && res.data.runId) {
    $("#run-input").value = "";
    openRunDetail(res.data.runId);
  } else {
    errorEl.textContent = res.data.error || "Failed to start run.";
  }
}

// ══════════════════════════════════════
// ── Run Detail (inside Runs tab)
// ══════════════════════════════════════

async function loadRun(runId) {
  currentRunId = runId;

  // Update breadcrumb
  $("#breadcrumb-run").textContent = `run-${runId}`;

  const res = await api("/api/runs/" + runId);
  if (res.status !== 200) {
    $("#stage-list").innerHTML = '<p class="empty-state">Failed to load run.</p>';
    return;
  }

  currentRunData = res.data;
  renderStageList();
  renderRunSummary();

  // Select first stage by default
  if (currentRunData.stages && currentRunData.stages.length > 0) {
    selectStage(0);
  } else {
    currentStageIndex = -1;
    loadRunLog();
  }

  connectSSE(runId);
}

function renderStageList() {
  const list = $("#stage-list");
  const stages = currentRunData.stages || [];

  if (stages.length === 0) {
    list.innerHTML = '<p class="empty-state">No stages in this run.</p>';
    return;
  }

  list.innerHTML = stages.map((s, i) => {
    const dotClass = s.gatePassed === true ? "passed" : s.gatePassed === false ? "failed" : "pending";
    const usage = s.usage || {};
    const costStr = usage.costUsd ? ` · ${formatCost(usage.costUsd)}` : "";
    const modelStr = s.model ? ` · ${s.model}` : "";
    return `
      <div class="stage-item${i === currentStageIndex ? " active" : ""}" data-index="${i}">
        <div class="stage-dot ${dotClass}"></div>
        <div class="stage-info">
          <div class="stage-name">${escHtml(s.stage)}</div>
          <div class="stage-meta">${escHtml(s.role || "")}${modelStr} · ${formatDuration(s.durationMs)}${costStr}</div>
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".stage-item").forEach((el) => {
    el.addEventListener("click", () => selectStage(parseInt(el.dataset.index, 10)));
  });
}

function renderRunSummary() {
  const r = currentRunData;
  const usage = r.totalUsage || {};
  const statusClass = r.status === "done" ? "stat-success" : r.status === "blocked" ? "stat-danger" : "";
  $("#run-summary").innerHTML = `
    <div><span class="label">Pipeline:</span> ${escHtml(r.pipeline)}</div>
    <div><span class="label">Status:</span> <span class="${statusClass}">${escHtml(r.status)}</span></div>
    <div><span class="label">Started:</span> ${formatDate(r.startedAt)}</div>
    <div><span class="label">Duration:</span> ${formatDuration(r.durationMs)}</div>
    <div><span class="label">Tokens:</span> ${(usage.inputTokens || 0) + (usage.outputTokens || 0)}</div>
    <div><span class="label">Cost:</span> ${formatCost(usage.costUsd)}</div>
  `;
}

function selectStage(index) {
  currentStageIndex = index;
  $$(".stage-item").forEach((el, i) => el.classList.toggle("active", i === index));
  loadStageIO();
  loadRunLog();
  loadStageArtifacts();
  renderGateDetail();
}

async function loadStageIO() {
  const promptEl = $("#io-prompt");
  const resultEl = $("#io-result");

  const stage = currentRunData.stages?.[currentStageIndex];
  if (!stage) {
    promptEl.textContent = "Select a stage to view agent I/O.";
    resultEl.textContent = "";
    return;
  }

  const prefix = stage.stage + "/" + (stage.role || "");

  // Load prompt (_prompt.md)
  const promptRes = await api("/api/runs/" + currentRunId + "/artifacts/" + prefix + "/_prompt.md");
  if (promptRes.status === 200 && promptRes.data) {
    promptEl.textContent = promptRes.data;
    promptEl.classList.add("collapsed");
  } else {
    promptEl.textContent = "(No prompt saved for this stage — available in future runs)";
    promptEl.classList.remove("collapsed");
  }

  // Load result (_result.md)
  const resultRes = await api("/api/runs/" + currentRunId + "/artifacts/" + prefix + "/_result.md");
  if (resultRes.status === 200 && resultRes.data) {
    resultEl.textContent = resultRes.data;
  } else {
    resultEl.textContent = "(No result saved for this stage — available in future runs)";
  }
}

async function loadRunLog() {
  const res = await api("/api/runs/" + currentRunId + "/log");
  if (res.status !== 200) {
    $("#log-output").textContent = "Failed to load log.";
    return;
  }

  const stage = currentRunData.stages?.[currentStageIndex];
  if (!stage) {
    $("#log-output").textContent = res.data;
    return;
  }

  // Filter log lines relevant to the selected stage
  const lines = res.data.split("\n");
  const filtered = [];
  let inStage = false;
  const stageHeader = `Stage "${stage.stage}"`;
  const stagePrefix = `  ${stage.stage}/`;

  for (const line of lines) {
    if (line.includes(stageHeader)) {
      inStage = true;
      filtered.push(line);
    } else if (inStage && (line.includes(stagePrefix) || line.includes("  Gate [") || line.includes("  artifacts:"))) {
      filtered.push(line);
    } else if (inStage && line.match(/\] Stage "/) && !line.includes(stageHeader)) {
      inStage = false;
    }
  }

  $("#log-output").textContent = filtered.length > 0 ? filtered.join("\n") : `No log entries for stage "${stage.stage}".`;
}

async function loadStageArtifacts() {
  const container = $("#artifacts-list");
  $("#artifact-preview").textContent = "";

  const res = await api("/api/runs/" + currentRunId + "/artifacts");
  if (res.status !== 200 || !Array.isArray(res.data) || res.data.length === 0) {
    container.innerHTML = '<p class="empty-state">No artifacts.</p>';
    return;
  }

  const stage = currentRunData.stages?.[currentStageIndex];
  let artifacts = res.data;
  if (stage) {
    const prefix = stage.stage + "/" + (stage.role || "");
    const filtered = artifacts.filter((a) => a.path.startsWith(prefix));
    if (filtered.length > 0) artifacts = filtered;
  }

  container.innerHTML = artifacts.map((a) => `
    <div class="artifact-item" data-path="${escAttr(a.path)}">
      <span>${escHtml(a.path)}</span>
      <span class="artifact-size">${formatSize(a.size)}</span>
    </div>
  `).join("");

  container.querySelectorAll(".artifact-item").forEach((el) => {
    el.addEventListener("click", async () => {
      container.querySelectorAll(".artifact-item").forEach((e) => e.classList.remove("active"));
      el.classList.add("active");
      const aRes = await api("/api/runs/" + currentRunId + "/artifacts/" + el.dataset.path);
      $("#artifact-preview").textContent = aRes.status === 200 ? aRes.data : "Failed to load artifact.";
    });
  });
}

function renderGateDetail() {
  const gate = $("#gate-detail");
  if (currentStageIndex < 0 || !currentRunData.stages[currentStageIndex]) {
    gate.innerHTML = '<p class="empty-state">Select a stage to view gate results.</p>';
    return;
  }

  const stage = currentRunData.stages[currentStageIndex];
  const passed = stage.gatePassed;
  const statusClass = passed === true ? "passed" : passed === false ? "failed" : "pending";
  const statusText = passed === true ? "Passed" : passed === false ? "Failed" : "Pending";

  const usage = stage.usage || {};
  const tokenTotal = (usage.inputTokens || 0) + (usage.outputTokens || 0);

  gate.innerHTML = `
    <div class="gate-card">
      <div class="gate-status ${statusClass}">${statusText}</div>
      <div><strong>Stage:</strong> ${escHtml(stage.stage)}</div>
      <div><strong>Role:</strong> ${escHtml(stage.role || "-")}</div>
      <div><strong>Model:</strong> ${escHtml(stage.model || "-")}</div>
      <div><strong>Duration:</strong> ${formatDuration(stage.durationMs)}</div>
      <div><strong>Tokens:</strong> ${usage.inputTokens || 0} in + ${usage.outputTokens || 0} out = ${tokenTotal}</div>
      <div><strong>Cost:</strong> ${formatCost(usage.costUsd)}</div>
      ${stage.gateReason ? `<div class="gate-reason">${escHtml(stage.gateReason)}</div>` : ""}
    </div>
  `;
}

function connectSSE(runId) {
  if (eventSource) { eventSource.close(); eventSource = null; }
  if (currentRunData && (currentRunData.status === "done" || currentRunData.status === "blocked")) return;

  eventSource = new EventSource(apiUrl("/api/events/" + runId));
  const logEl = $("#log-output");

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const line = formatSSEEvent(data);
      if (line) {
        logEl.textContent += "\n" + line;
        logEl.scrollTop = logEl.scrollHeight;
      }
      if (data.type === "run-end") {
        eventSource.close();
        eventSource = null;
        loadRun(runId);
      }
    } catch (e) { /* ignore */ }
  };

  eventSource.onerror = () => { eventSource.close(); eventSource = null; };
}

function formatSSEEvent(data) {
  const ts = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  switch (data.type) {
    case "stage-start": return `[${ts}] Stage "${data.stage}" attempt ${data.attempt}/${data.max}`;
    case "role-start": return `[${ts}] ${data.stage}/${data.role} — model: ${data.model || "?"}`;
    case "role-end": return `[${ts}] ${data.stage}/${data.role} done (${formatDuration(data.durationMs)})`;
    case "gate-result": return `[${ts}] Gate [${data.passed ? "PASS" : "FAIL"}]: ${data.reason || ""}`;
    case "run-end": return `[${ts}] Run finished — ${data.status}`;
    default: return null;
  }
}

// ══════════════════════════════════════
// ── Config Tab
// ══════════════════════════════════════

async function loadConfigTab() {
  const res = await api("/api/config/files");
  const tree = $("#file-tree");

  if (res.status !== 200 || !Array.isArray(res.data)) {
    tree.innerHTML = '<p class="empty-state">Failed to load files.</p>';
    return;
  }

  const files = res.data.map((f) => (typeof f === "string" ? f : f.path));
  const groups = {};
  files.forEach((f) => {
    const parts = f.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    if (!groups[dir]) groups[dir] = [];
    groups[dir].push(f);
  });

  const sortedDirs = Object.keys(groups).sort((a, b) => {
    if (a === ".") return -1;
    if (b === ".") return 1;
    return a.localeCompare(b);
  });

  let html = "";
  for (const dir of sortedDirs) {
    const label = dir === "." ? "Project Root" : dir;
    html += `<div class="file-group-label">${escHtml(label)}</div>`;
    groups[dir].sort().forEach((f) => {
      const name = f.split("/").pop();
      const activeClass = f === currentConfigPath ? " active" : "";
      html += `<div class="file-item${activeClass}" data-path="${escAttr(f)}">${escHtml(name)}</div>`;
    });
  }

  tree.innerHTML = html;
  tree.querySelectorAll(".file-item").forEach((el) => {
    el.addEventListener("click", () => {
      loadConfigFile(el.dataset.path);
      tree.querySelectorAll(".file-item").forEach((e) => e.classList.remove("active"));
      el.classList.add("active");
    });
  });
}

async function loadConfigFile(filePath) {
  currentConfigPath = filePath;
  const editor = $("#editor-content");
  const filenameEl = $("#editor-filename");
  const saveBtn = $("#editor-save-btn");
  const statusEl = $("#editor-status");

  filenameEl.textContent = filePath;
  statusEl.textContent = "";
  statusEl.className = "editor-status";
  editor.disabled = true;
  saveBtn.disabled = true;

  const res = await api("/api/config/file?path=" + encodeURIComponent(filePath));
  if (res.status === 200) {
    editor.value = typeof res.data === "string" ? res.data : res.data.content || "";
    editor.disabled = false;
    saveBtn.disabled = false;
  } else {
    editor.value = "Failed to load file.";
  }
}

async function saveConfigFile() {
  if (!currentConfigPath) return;
  const saveBtn = $("#editor-save-btn");
  const statusEl = $("#editor-status");
  const content = $("#editor-content").value;

  saveBtn.disabled = true;
  statusEl.textContent = "Saving...";
  statusEl.className = "editor-status";

  const res = await api("/api/config/file?path=" + encodeURIComponent(currentConfigPath), {
    method: "PUT",
    body: JSON.stringify({ content }),
  });

  saveBtn.disabled = false;
  if (res.status === 200) {
    statusEl.textContent = "Saved";
    statusEl.className = "editor-status success";
  } else {
    statusEl.textContent = (res.data && res.data.error) || "Save failed.";
    statusEl.className = "editor-status error";
  }
}

// ══════════════════════════════════════
// ── Create Tab
// ══════════════════════════════════════

function loadCreateTab() {
  if (generatedFiles.length > 0) {
    showCreateReview();
  } else {
    showCreateInput();
  }
}

function showCreateInput() {
  $("#create-input-view").style.display = "";
  $("#create-review-view").style.display = "none";
  if (generateDescription) {
    $("#create-description").value = generateDescription;
  }
}

function showCreateReview() {
  $("#create-input-view").style.display = "none";
  $("#create-review-view").style.display = "";
  renderGeneratedFileTree();
  renderStatusBanner();
}

async function startGenerate() {
  const btn = $("#create-generate-btn");
  const errorEl = $("#create-error");
  const loadingEl = $("#create-loading");
  const description = $("#create-description").value.trim();

  errorEl.textContent = "";
  if (!description) {
    errorEl.textContent = "Please enter a description.";
    return;
  }

  generateDescription = description;
  btn.disabled = true;
  loadingEl.style.display = "flex";

  const res = await api("/api/generate", {
    method: "POST",
    body: JSON.stringify({ description }),
  });

  btn.disabled = false;
  loadingEl.style.display = "none";

  if (res.status === 200 && res.data.files) {
    generatedFiles = res.data.files;
    generatedStatus = res.data.status;
    generatedErrors = res.data.errors || [];
    selectedGeneratedFile = null;
    showCreateReview();
  } else {
    errorEl.textContent = (res.data && res.data.error) || "Generation failed.";
  }
}

function renderStatusBanner() {
  const banner = $("#create-status-banner");
  if (generatedStatus === "ok") {
    banner.className = "create-status-banner success";
    banner.textContent = "Pipeline generated successfully. Review the files below, then confirm to run.";
  } else if (generatedStatus === "validation_failed") {
    banner.className = "create-status-banner warning";
    banner.textContent = "Generated with validation errors: " + generatedErrors.join("; ");
  }
}

function renderGeneratedFileTree() {
  const tree = $("#gen-file-tree");
  const files = generatedFiles;

  const groups = {};
  files.forEach((f) => {
    const parts = f.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    if (!groups[dir]) groups[dir] = [];
    groups[dir].push(f);
  });

  const sortedDirs = Object.keys(groups).sort((a, b) => {
    if (a === ".") return -1;
    if (b === ".") return 1;
    return a.localeCompare(b);
  });

  let html = "";
  for (const dir of sortedDirs) {
    const label = dir === "." ? "Project Root" : dir;
    html += `<div class="file-group-label">${escHtml(label)}</div>`;
    groups[dir].sort().forEach((f) => {
      const name = f.split("/").pop();
      const activeClass = f === selectedGeneratedFile ? " active" : "";
      html += `<div class="file-item${activeClass}" data-path="${escAttr(f)}">${escHtml(name)}</div>`;
    });
  }

  tree.innerHTML = html;
  tree.querySelectorAll(".file-item").forEach((el) => {
    el.addEventListener("click", () => {
      loadGeneratedFile(el.dataset.path);
      tree.querySelectorAll(".file-item").forEach((e) => e.classList.remove("active"));
      el.classList.add("active");
    });
  });

  // Auto-select first file
  if (files.length > 0 && !selectedGeneratedFile) {
    loadGeneratedFile(files[0]);
    tree.querySelector(".file-item")?.classList.add("active");
  }
}

async function loadGeneratedFile(filePath) {
  selectedGeneratedFile = filePath;
  const editor = $("#gen-editor-content");
  const filenameEl = $("#gen-editor-filename");
  const saveBtn = $("#gen-editor-save-btn");
  const statusEl = $("#gen-editor-status");

  filenameEl.textContent = filePath;
  statusEl.textContent = "";
  statusEl.className = "editor-status";
  editor.disabled = true;
  saveBtn.disabled = true;

  const res = await api("/api/generate/file?path=" + encodeURIComponent(filePath));
  if (res.status === 200) {
    editor.value = typeof res.data === "string" ? res.data : res.data.content || "";
    editor.disabled = false;
    saveBtn.disabled = false;
  } else {
    editor.value = "Failed to load file.";
  }
}

async function saveGeneratedFile() {
  if (!selectedGeneratedFile) return;
  const saveBtn = $("#gen-editor-save-btn");
  const statusEl = $("#gen-editor-status");
  const content = $("#gen-editor-content").value;

  saveBtn.disabled = true;
  statusEl.textContent = "Saving...";
  statusEl.className = "editor-status";

  const res = await api("/api/generate/file?path=" + encodeURIComponent(selectedGeneratedFile), {
    method: "PUT",
    body: JSON.stringify({ content }),
  });

  saveBtn.disabled = false;
  if (res.status === 200) {
    statusEl.textContent = "Saved";
    statusEl.className = "editor-status success";
  } else {
    statusEl.textContent = (res.data && res.data.error) || "Save failed.";
    statusEl.className = "editor-status error";
  }
}

async function validateGenerated() {
  const btn = $("#create-validate-btn");
  btn.disabled = true;
  btn.textContent = "Validating...";

  const res = await api("/api/generate/validate", { method: "POST" });

  btn.disabled = false;
  btn.textContent = "Validate";

  if (res.status === 200) {
    if (res.data.valid) {
      generatedStatus = "ok";
      generatedErrors = [];
    } else {
      generatedStatus = "validation_failed";
      generatedErrors = res.data.errors || [];
    }
    renderStatusBanner();
  }
}

async function confirmAndRun() {
  const btn = $("#create-confirm-btn");
  btn.disabled = true;
  btn.textContent = "Promoting...";

  // 1. Promote files
  const promoteRes = await api("/api/generate/promote", { method: "POST" });
  if (promoteRes.status !== 200) {
    btn.disabled = false;
    btn.textContent = "Confirm & Run";
    return;
  }

  // 2. Start a run with the generated pipeline
  btn.textContent = "Starting run...";
  const input = generateDescription || "";
  const runRes = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify({ input }),
  });

  btn.disabled = false;
  btn.textContent = "Confirm & Run";

  if (runRes.status === 200 && runRes.data.runId) {
    // Reset create state
    generatedFiles = [];
    generatedStatus = null;
    generatedErrors = [];
    selectedGeneratedFile = null;
    // Navigate to run detail
    openRunDetail(runRes.data.runId);
  }
}

// ══════════════════════════════════════
// ── Utilities
// ══════════════════════════════════════

function switchToTab(tabName) {
  $$(".tab").forEach((t) => t.classList.remove("active"));
  $$(".tab-content").forEach((c) => c.classList.remove("active"));
  document.querySelector(`.tab[data-tab="${tabName}"]`)?.classList.add("active");
  document.getElementById("tab-" + tabName)?.classList.add("active");
}

function escHtml(str) {
  if (str == null) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escAttr(str) { return escHtml(str); }
