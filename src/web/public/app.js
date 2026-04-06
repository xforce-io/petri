// Petri Dashboard — Frontend Application

// ── State ──
let currentRunId = null;
let currentRunData = null;
let currentStageIndex = -1;
let eventSource = null;
let currentConfigPath = null;

// ── API Helper ──
async function api(path, opts = {}) {
  try {
    const res = await fetch(path, {
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

function formatCost(usd) {
  if (usd == null) return "-";
  return "$" + usd.toFixed(4);
}

function $(sel) {
  return document.querySelector(sel);
}

function $$(sel) {
  return document.querySelectorAll(sel);
}

// ── Tab Switching ──
document.addEventListener("DOMContentLoaded", () => {
  const tabs = $$(".tab");
  const contents = $$(".tab-content");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.remove("active"));
      contents.forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("tab-" + target)?.classList.add("active");

      // Load data on tab activation
      if (target === "runs") loadRunsTab();
      if (target === "config") loadConfigTab();
    });
  });

  // Sub-tab switching
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

  // Load dashboard on startup
  loadDashboard();
});

// ── Dashboard Tab ──

async function loadDashboard(runId) {
  if (runId) {
    await loadRun(runId);
    return;
  }

  // Load latest run
  const res = await api("/api/runs");
  if (res.status === 200 && Array.isArray(res.data) && res.data.length > 0) {
    // Sort by startedAt descending, pick latest
    const sorted = res.data.sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
    await loadRun(sorted[0].runId);
  } else {
    $("#stage-list").innerHTML = '<p class="empty-state">No runs found. Start one from the Runs tab.</p>';
    $("#run-summary").innerHTML = "";
    $("#log-output").textContent = "No run loaded.";
  }
}

async function loadRun(runId) {
  currentRunId = runId;

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

  // Connect SSE if run is active
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
    return `
      <div class="stage-item${i === currentStageIndex ? " active" : ""}" data-index="${i}">
        <div class="stage-dot ${dotClass}"></div>
        <div class="stage-info">
          <div class="stage-name">${escHtml(s.stage)}</div>
          <div class="stage-meta">${escHtml(s.role || "")} &middot; ${formatDuration(s.durationMs)}</div>
        </div>
      </div>
    `;
  }).join("");

  list.querySelectorAll(".stage-item").forEach((el) => {
    el.addEventListener("click", () => {
      selectStage(parseInt(el.dataset.index, 10));
    });
  });
}

function renderRunSummary() {
  const r = currentRunData;
  const usage = r.totalUsage || {};
  $("#run-summary").innerHTML = `
    <div><span class="label">Run:</span> ${escHtml(r.runId)}</div>
    <div><span class="label">Pipeline:</span> ${escHtml(r.pipeline)}</div>
    <div><span class="label">Status:</span> ${escHtml(r.status)}</div>
    <div><span class="label">Started:</span> ${formatTime(r.startedAt)}</div>
    <div><span class="label">Duration:</span> ${formatDuration(r.durationMs)}</div>
    <div><span class="label">Tokens:</span> ${(usage.inputTokens || 0) + (usage.outputTokens || 0)}</div>
    <div><span class="label">Cost:</span> ${formatCost(usage.costUsd)}</div>
  `;
}

function selectStage(index) {
  currentStageIndex = index;

  // Update active highlight
  $$(".stage-item").forEach((el, i) => {
    el.classList.toggle("active", i === index);
  });

  loadRunLog();
  loadStageArtifacts();
  renderGateDetail();
}

async function loadRunLog() {
  const res = await api("/api/runs/" + currentRunId + "/log");
  if (res.status === 200) {
    $("#log-output").textContent = res.data;
  } else {
    $("#log-output").textContent = "Failed to load log.";
  }
}

async function loadStageArtifacts() {
  const container = $("#artifacts-list");
  $("#artifact-preview").textContent = "";

  const res = await api("/api/runs/" + currentRunId + "/artifacts");
  if (res.status !== 200 || !Array.isArray(res.data) || res.data.length === 0) {
    container.innerHTML = '<p class="empty-state">No artifacts.</p>';
    return;
  }

  // Filter artifacts for current stage if possible
  const stage = currentRunData.stages[currentStageIndex];
  let artifacts = res.data;
  if (stage && stage.artifacts && stage.artifacts.length > 0) {
    const stageArtifactSet = new Set(stage.artifacts);
    const filtered = artifacts.filter((a) => stageArtifactSet.has(a.path));
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

  gate.innerHTML = `
    <div class="gate-card">
      <div class="gate-status ${statusClass}">${statusText}</div>
      <div><strong>Stage:</strong> ${escHtml(stage.stage)}</div>
      <div><strong>Role:</strong> ${escHtml(stage.role || "-")}</div>
      ${stage.gateReason ? `<div class="gate-reason">${escHtml(stage.gateReason)}</div>` : ""}
    </div>
  `;
}

function connectSSE(runId) {
  // Close any existing connection
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }

  // Only connect if run might be active
  if (currentRunData && (currentRunData.status === "done" || currentRunData.status === "blocked")) {
    return;
  }

  eventSource = new EventSource("/api/events/" + runId);
  const logEl = $("#log-output");

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const line = formatSSEEvent(data);
      if (line) {
        logEl.textContent += "\n" + line;
        logEl.scrollTop = logEl.scrollHeight;
      }

      // Refresh run data on run-end
      if (data.type === "run-end") {
        eventSource.close();
        eventSource = null;
        loadRun(runId);
      }
    } catch (e) {
      // ignore parse errors
    }
  };

  eventSource.onerror = () => {
    eventSource.close();
    eventSource = null;
  };
}

function formatSSEEvent(data) {
  switch (data.type) {
    case "stage-start":
      return `[Stage] ${data.stage} started`;
    case "role-start":
      return `[Role] ${data.role} started (model: ${data.model || "?"})`;
    case "role-end":
      return `[Role] ${data.role} finished (${formatDuration(data.durationMs)})`;
    case "gate-result":
      return `[Gate] ${data.stage}: ${data.passed ? "PASSED" : "FAILED"} — ${data.reason || ""}`;
    case "run-end":
      return `[Run] Finished — ${data.status}`;
    default:
      return `[${data.type}] ${JSON.stringify(data)}`;
  }
}

// ── Runs Tab ──

async function loadRunsTab() {
  // Populate pipeline dropdown
  const configRes = await api("/api/config/files");
  const pipelineSelect = $("#run-pipeline");

  if (configRes.status === 200 && Array.isArray(configRes.data)) {
    const pipelineFiles = configRes.data.filter((f) =>
      typeof f === "string" ? f.match(/pipeline.*\.yaml$/i) : (f.path || "").match(/pipeline.*\.yaml$/i)
    );
    pipelineSelect.innerHTML = pipelineFiles.map((f) => {
      const path = typeof f === "string" ? f : f.path;
      return `<option value="${escAttr(path)}">${escHtml(path)}</option>`;
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

    tbody.innerHTML = runs.map((r) => {
      const usage = r.totalUsage || {};
      return `
        <tr data-runid="${escAttr(r.runId)}">
          <td>${escHtml(r.runId)}</td>
          <td>${escHtml(r.pipeline)}</td>
          <td><span class="status-badge ${r.status}">${escHtml(r.status)}</span></td>
          <td>${formatTime(r.startedAt)}</td>
          <td>${formatDuration(r.durationMs)}</td>
          <td>${formatCost(usage.costUsd)}</td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll("tr").forEach((row) => {
      row.addEventListener("click", () => {
        switchToTab("dashboard");
        loadDashboard(row.dataset.runid);
      });
    });
  } else {
    emptyMsg.style.display = "block";
    $("#runs-table").style.display = "none";
    tbody.innerHTML = "";
  }
}

async function startNewRun() {
  const btn = $("#run-start-btn");
  const errorEl = $("#run-error");
  const pipeline = $("#run-pipeline").value;
  const input = $("#run-input").value.trim();

  errorEl.textContent = "";

  if (!input) {
    errorEl.textContent = "Input is required.";
    return;
  }

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
    switchToTab("dashboard");
    loadDashboard(res.data.runId);
  } else {
    errorEl.textContent = res.data.error || "Failed to start run.";
  }
}

// ── Config Tab ──

async function loadConfigTab() {
  const res = await api("/api/config/files");
  const tree = $("#file-tree");

  if (res.status !== 200 || !Array.isArray(res.data)) {
    tree.innerHTML = '<p class="empty-state">Failed to load files.</p>';
    return;
  }

  const files = res.data.map((f) => (typeof f === "string" ? f : f.path));

  // Group by directory
  const groups = {};
  files.forEach((f) => {
    const parts = f.split("/");
    const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
    if (!groups[dir]) groups[dir] = [];
    groups[dir].push(f);
  });

  // Sort directories: root first, then alphabetically
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

// ── Utilities ──

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

function escAttr(str) {
  return escHtml(str);
}
