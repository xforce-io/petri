// Petri Dashboard — Frontend Application

// ── State ──
let currentProject = null;
let projects = [];
let currentRunId = null;
let currentRunData = null;
let currentStageIndex = -1;
let expandedStageKey = null;
let eventSource = null;
let currentConfigPath = null;
let currentBranch = ""; // empty = project default runs
let runsSplitterPointerId = null;
let runsSplitWidth = 360;
let timelineSplitterPointerId = null;
let runSummaryHeight = 260;
let ioSplitterPointerId = null;
let ioPromptHeight = 320;

const RUNS_SPLIT_MIN = 280;
const RUNS_SPLIT_MAX = 560;
const RUNS_DETAIL_MIN = 420;
const RUNS_SPLIT_STEP = 16;
const RUNS_SPLITTER_SIZE = 12;
const TIMELINE_SUMMARY_MIN = 160;
const TIMELINE_STAGE_MIN = 180;
const TIMELINE_SPLITTER_SIZE = 12;
const IO_PROMPT_MIN = 160;
const IO_RESULT_MIN = 140;
const IO_SPLITTER_SIZE = 12;

// Create tab wizard state
let wizard = {
  step: 1,
  description: "",
  templateId: null,
  generateResult: null,
  selectedFile: null,
  validationPassed: false,
  templates: [],
};

// ── Execution vs quality status (issue #17) ──
function computeRunStatuses(run) {
  const st = run && run.status;
  let executionStatus = "unknown";
  if (st === "running") executionStatus = "running";
  else if (st === "done" || st === "blocked") executionStatus = "completed";

  let qualityStatus = "unknown";
  if (st === "running") qualityStatus = "pending";
  else if (st === "blocked") qualityStatus = "failed";
  else if (st === "done") {
    const reqs = run.requirements;
    if (Array.isArray(reqs) && reqs.length > 0) {
      qualityStatus = reqs.every((r) => r.met) ? "passed" : "failed";
    } else {
      qualityStatus = "passed";
    }
  }
  return {
    executionStatus,
    qualityStatus,
    qualityPassed: qualityStatus === "passed",
  };
}

function computeSuccessRate(runs) {
  if (!runs.length) return 0;
  const passed = runs.filter((r) => computeRunStatuses(r).qualityPassed).length;
  return Math.round((passed / runs.length) * 100);
}

// ── API Helper ──
function apiUrl(urlPath) {
  let out = urlPath;
  if (currentProject) {
    const sep = out.includes("?") ? "&" : "?";
    out = out + sep + "project=" + encodeURIComponent(currentProject);
  }
  if (currentBranch) {
    const sep = out.includes("?") ? "&" : "?";
    out = out + sep + "branch=" + encodeURIComponent(currentBranch);
  }
  return out;
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

function runsSplitMax(layout) {
  return Math.max(
    RUNS_SPLIT_MIN,
    Math.min(RUNS_SPLIT_MAX, layout.clientWidth - RUNS_DETAIL_MIN - RUNS_SPLITTER_SIZE),
  );
}

function setRunsSplitWidth(requestedWidth) {
  const layout = $(".dashboard-layout");
  const splitter = $("#runs-splitter");
  if (!layout || !splitter) return RUNS_SPLIT_MIN;
  // Runs detail starts hidden. Do not clamp the remembered default against a
  // zero-width layout before the detail view becomes visible.
  if (layout.clientWidth <= 0) return runsSplitWidth;

  const max = runsSplitMax(layout);
  const width = Math.round(Math.max(RUNS_SPLIT_MIN, Math.min(max, requestedWidth)));
  runsSplitWidth = width;
  layout.style.setProperty("--timeline-width", `${width}px`);
  splitter.setAttribute("aria-valuemin", String(RUNS_SPLIT_MIN));
  splitter.setAttribute("aria-valuemax", String(max));
  splitter.setAttribute("aria-valuenow", String(width));
  splitter.setAttribute("aria-valuetext", `阶段导航宽度 ${width} 像素`);
  return width;
}

function setupRunsSplitter() {
  const layout = $(".dashboard-layout");
  const splitter = $("#runs-splitter");
  if (!layout || !splitter || splitter.dataset.bound) return;
  splitter.dataset.bound = "1";

  const widthFromPointer = (event) => event.clientX - layout.getBoundingClientRect().left;
  const stopDragging = (event) => {
    if (runsSplitterPointerId !== event.pointerId) return;
    splitter.releasePointerCapture?.(event.pointerId);
    runsSplitterPointerId = null;
    delete splitter.dataset.dragging;
  };

  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || window.matchMedia("(max-width: 800px)").matches) return;
    event.preventDefault();
    runsSplitterPointerId = event.pointerId;
    splitter.dataset.dragging = "true";
    splitter.setPointerCapture?.(event.pointerId);
    setRunsSplitWidth(widthFromPointer(event));
  });
  splitter.addEventListener("pointermove", (event) => {
    if (runsSplitterPointerId === event.pointerId) setRunsSplitWidth(widthFromPointer(event));
  });
  splitter.addEventListener("pointerup", stopDragging);
  splitter.addEventListener("pointercancel", stopDragging);
  splitter.addEventListener("keydown", (event) => {
    const current = Number(splitter.getAttribute("aria-valuenow")) || RUNS_SPLIT_MIN;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setRunsSplitWidth(current - RUNS_SPLIT_STEP);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setRunsSplitWidth(current + RUNS_SPLIT_STEP);
    } else if (event.key === "Home") {
      event.preventDefault();
      setRunsSplitWidth(RUNS_SPLIT_MIN);
    } else if (event.key === "End") {
      event.preventDefault();
      setRunsSplitWidth(runsSplitMax(layout));
    }
  });
  window.addEventListener("resize", () => {
    const current = Number(splitter.getAttribute("aria-valuenow")) || RUNS_SPLIT_MIN;
    setRunsSplitWidth(current);
  });
  setRunsSplitWidth(Number(splitter.getAttribute("aria-valuenow")) || 360);
}

function timelineSummaryMax(panel) {
  const headingHeight = panel.querySelector("h3")?.offsetHeight || 0;
  return Math.max(
    TIMELINE_SUMMARY_MIN,
    panel.clientHeight - headingHeight - TIMELINE_STAGE_MIN - TIMELINE_SPLITTER_SIZE,
  );
}

function setTimelineSummaryHeight(requestedHeight) {
  const panel = $(".timeline-panel");
  const splitter = $("#timeline-splitter");
  if (!panel || !splitter) return TIMELINE_SUMMARY_MIN;
  // Runs detail starts hidden. Keep the remembered value until the panel has
  // a usable height, then apply the same bounded layout once it is visible.
  if (panel.clientHeight <= 0) return runSummaryHeight;

  const max = timelineSummaryMax(panel);
  const height = Math.round(Math.max(TIMELINE_SUMMARY_MIN, Math.min(max, requestedHeight)));
  runSummaryHeight = height;
  panel.style.setProperty("--run-summary-height", `${height}px`);
  splitter.setAttribute("aria-valuemin", String(TIMELINE_SUMMARY_MIN));
  splitter.setAttribute("aria-valuemax", String(max));
  splitter.setAttribute("aria-valuenow", String(height));
  splitter.setAttribute("aria-valuetext", `运行摘要高度 ${height} 像素`);
  return height;
}

function setupTimelineSplitter() {
  const panel = $(".timeline-panel");
  const splitter = $("#timeline-splitter");
  if (!panel || !splitter || splitter.dataset.bound) return;
  splitter.dataset.bound = "1";

  const heightFromPointer = (event) => panel.getBoundingClientRect().bottom - event.clientY;
  const stopDragging = (event) => {
    if (timelineSplitterPointerId !== event.pointerId) return;
    splitter.releasePointerCapture?.(event.pointerId);
    timelineSplitterPointerId = null;
    delete splitter.dataset.dragging;
  };

  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    timelineSplitterPointerId = event.pointerId;
    splitter.dataset.dragging = "true";
    splitter.setPointerCapture?.(event.pointerId);
    setTimelineSummaryHeight(heightFromPointer(event));
  });
  splitter.addEventListener("pointermove", (event) => {
    if (timelineSplitterPointerId === event.pointerId) setTimelineSummaryHeight(heightFromPointer(event));
  });
  splitter.addEventListener("pointerup", stopDragging);
  splitter.addEventListener("pointercancel", stopDragging);
  splitter.addEventListener("keydown", (event) => {
    const current = Number(splitter.getAttribute("aria-valuenow")) || runSummaryHeight;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setTimelineSummaryHeight(current + RUNS_SPLIT_STEP);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setTimelineSummaryHeight(current - RUNS_SPLIT_STEP);
    } else if (event.key === "Home") {
      event.preventDefault();
      setTimelineSummaryHeight(TIMELINE_SUMMARY_MIN);
    } else if (event.key === "End") {
      event.preventDefault();
      setTimelineSummaryHeight(timelineSummaryMax(panel));
    }
  });
  window.addEventListener("resize", () => setTimelineSummaryHeight(runSummaryHeight));
  setTimelineSummaryHeight(runSummaryHeight);
}

function ioPromptMax(section) {
  return Math.max(IO_PROMPT_MIN, section.clientHeight - IO_RESULT_MIN - IO_SPLITTER_SIZE);
}

function setIoPromptHeight(requestedHeight) {
  const section = $(".io-section");
  const splitter = $("#io-splitter");
  if (!section || !splitter) return IO_PROMPT_MIN;
  if (section.clientHeight <= 0) return ioPromptHeight;

  const max = ioPromptMax(section);
  const height = Math.round(Math.max(IO_PROMPT_MIN, Math.min(max, requestedHeight)));
  ioPromptHeight = height;
  section.style.setProperty("--io-prompt-height", `${height}px`);
  splitter.setAttribute("aria-valuemin", String(IO_PROMPT_MIN));
  splitter.setAttribute("aria-valuemax", String(max));
  splitter.setAttribute("aria-valuenow", String(height));
  splitter.setAttribute("aria-valuetext", `输入区域高度 ${height} 像素`);
  return height;
}

function syncIoSplitter() {
  const prompt = $("#io-prompt");
  const promptBlock = $(".io-prompt-block");
  const splitter = $("#io-splitter");
  if (!prompt || !promptBlock || !splitter) return;
  const collapsed = prompt.classList.contains("collapsed");
  promptBlock.classList.toggle("is-collapsed", collapsed);
  splitter.hidden = collapsed;
  if (!collapsed) setIoPromptHeight(ioPromptHeight);
}

function setIoPromptCollapsed(collapsed) {
  const prompt = $("#io-prompt");
  const button = $("#io-prompt-toggle");
  if (!prompt) return;

  prompt.classList.toggle("collapsed", collapsed);
  if (button) {
    button.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const toggle = button.querySelector(".io-toggle");
    if (toggle) toggle.textContent = collapsed ? "\u25B6" : "\u25BC";
  }
  syncIoSplitter();
}

function setupIoSplitter() {
  const section = $(".io-section");
  const splitter = $("#io-splitter");
  if (!section || !splitter || splitter.dataset.bound) return;
  splitter.dataset.bound = "1";

  const heightFromPointer = (event) => event.clientY - section.getBoundingClientRect().top;
  const stopDragging = (event) => {
    if (ioSplitterPointerId !== event.pointerId) return;
    splitter.releasePointerCapture?.(event.pointerId);
    ioSplitterPointerId = null;
    delete splitter.dataset.dragging;
  };

  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || splitter.hidden) return;
    event.preventDefault();
    ioSplitterPointerId = event.pointerId;
    splitter.dataset.dragging = "true";
    splitter.setPointerCapture?.(event.pointerId);
    setIoPromptHeight(heightFromPointer(event));
  });
  splitter.addEventListener("pointermove", (event) => {
    if (ioSplitterPointerId === event.pointerId) setIoPromptHeight(heightFromPointer(event));
  });
  splitter.addEventListener("pointerup", stopDragging);
  splitter.addEventListener("pointercancel", stopDragging);
  splitter.addEventListener("keydown", (event) => {
    const current = Number(splitter.getAttribute("aria-valuenow")) || ioPromptHeight;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setIoPromptHeight(current + RUNS_SPLIT_STEP);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setIoPromptHeight(current - RUNS_SPLIT_STEP);
    } else if (event.key === "Home") {
      event.preventDefault();
      setIoPromptHeight(IO_PROMPT_MIN);
    } else if (event.key === "End") {
      event.preventDefault();
      setIoPromptHeight(ioPromptMax(section));
    }
  });
  window.addEventListener("resize", () => setIoPromptHeight(ioPromptHeight));
  syncIoSplitter();
}

// ── Init ──
document.addEventListener("DOMContentLoaded", () => {
  setupRunsSplitter();
  setupTimelineSplitter();
  setupIoSplitter();

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

      if (target === "io") loadStageIO();
      if (target === "log") loadRunLog();
      if (target === "artifacts") loadStageArtifacts();
      if (target === "gate") renderGateDetail();
    });
  });

  // Run button
  $("#run-start-btn").addEventListener("click", startNewRun);
  const runInput = $("#run-input");
  if (runInput && !runInput.dataset.errorClearBound) {
    runInput.dataset.errorClearBound = "1";
    runInput.addEventListener("input", syncRunInputError);
  }

  // Save button
  $("#editor-save-btn").addEventListener("click", saveConfigFile);

  // Back to runs list
  $("#back-to-runs").addEventListener("click", showRunsList);

  // Wizard: step navigation
  $("#wizard-next-1").addEventListener("click", () => wizardGoTo(2));
  $("#wizard-back-2").addEventListener("click", () => wizardGoTo(1));
  $("#wizard-retry").addEventListener("click", () => wizardGoTo(2));
  $("#wizard-back-3").addEventListener("click", () => wizardGoTo(1));
  $("#wizard-next-3").addEventListener("click", () => wizardGoTo(4));
  $("#wizard-back-4").addEventListener("click", () => wizardGoTo(3));

  // Wizard: actions
  $("#create-description").addEventListener("input", onDescriptionInput);
  $("#gen-editor-save-btn").addEventListener("click", saveGeneratedFile);
  $("#create-validate-btn").addEventListener("click", validateGenerated);
  $("#create-confirm-btn").addEventListener("click", confirmAndRun);

  // Wizard: review sub-tabs
  $$(".review-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.reviewTab;
      $$(".review-tab").forEach((t) => t.classList.remove("active"));
      $$(".review-tab-content").forEach((c) => c.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById("review-" + target)?.classList.add("active");
    });
  });

  // Wizard: step bar click navigation
  $$(".step-item").forEach((el) => {
    el.addEventListener("click", () => {
      if (el.classList.contains("completed")) {
        wizardGoTo(parseInt(el.dataset.step, 10));
      }
    });
  });

  // Prompt toggle (collapse/expand)
  document.addEventListener("click", (e) => {
    if (e.target.closest("#io-prompt-toggle")) {
      const el = $("#io-prompt");
      setIoPromptCollapsed(!el.classList.contains("collapsed"));
    }
  });

  // New project from preset template
  const newBtn = $("#new-project-btn");
  if (newBtn) newBtn.addEventListener("click", createProjectFromTemplate);
  const headerNewBtn = $("#header-new-project-btn");
  if (headerNewBtn) headerNewBtn.addEventListener("click", openGlobalNewProjectPanel);
  const globalSubmit = $("#global-new-project-submit");
  if (globalSubmit) globalSubmit.addEventListener("click", createProjectFromGlobalPanel);
  const globalCancel = $("#global-new-project-cancel");
  if (globalCancel) globalCancel.addEventListener("click", () => {
    const p = $("#global-new-project-panel");
    if (p) p.style.display = "none";
  });

  // Config validate — include unsaved editor draft so illegal YAML cannot show success
  const validateBtn = $("#config-validate-btn");
  if (validateBtn) {
    validateBtn.addEventListener("click", validateConfigDraft);
  }
  const editorEl = $("#editor-content");
  if (editorEl) {
    editorEl.addEventListener("input", clearConfigValidateResult);
  }

  // Load projects then dashboard
  loadProjects();
});

// ── Project Selector ──
function normalizeProjects(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => (typeof p === "string" ? p : p.name)).filter(Boolean);
}

async function loadProjects() {
  const res = await fetch("/api/projects");
  if (res.ok) {
    projects = normalizeProjects(await res.json());
  } else {
    projects = [];
    showBanner("Cannot reach Petri server. Restart with: petri web", "error");
  }

  const selector = $("#project-selector");
  const select = $("#project-select");
  if (projects.length >= 1) {
    selector.style.display = "";
    select.innerHTML = projects.map((p) =>
      `<option value="${escAttr(p)}">${escHtml(p)}</option>`
    ).join("");
    if (!currentProject || !projects.includes(currentProject)) {
      currentProject = projects[0];
    }
    select.value = currentProject;
    select.onchange = () => {
      currentProject = select.value;
      resetState();
      loadDashboard();
    };
  } else {
    selector.style.display = "none";
    currentProject = null;
  }

  loadDashboard();
}

function showBanner(msg, kind) {
  const el = $("#global-banner");
  if (!el) return;
  el.style.display = msg ? "" : "none";
  el.className = "global-banner" + (kind ? " banner-" + kind : "");
  el.textContent = msg || "";
}

async function openGlobalNewProjectPanel() {
  const panel = $("#global-new-project-panel");
  if (!panel) return;
  panel.style.display = "";
  // Populate presets
  const sel = $("#global-new-project-template");
  if (sel && sel.options.length === 0) {
    const res = await api("/api/templates");
    if (res.status === 200 && Array.isArray(res.data)) {
      sel.innerHTML = res.data
        .map((t) => {
          const id = typeof t === "string" ? t : t.id || t.name;
          const label = typeof t === "string" ? t : t.name || t.id;
          return `<option value="${escAttr(id)}">${escHtml(label)}</option>`;
        })
        .join("");
    }
  }
  $("#global-new-project-name")?.focus();
}

async function createProjectFromGlobalPanel() {
  const name = ($("#global-new-project-name")?.value || "").trim();
  const template = $("#global-new-project-template")?.value || "code-dev";
  const errEl = $("#global-new-project-error");
  if (errEl) errEl.textContent = "";
  if (!name) {
    if (errEl) errEl.textContent = "Project name is required.";
    return;
  }
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, template }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== 201) {
    // Keep panel open and show error on the global form (issue #26)
    if (errEl) errEl.textContent = data.error || "Failed to create project";
    return;
  }
  const panel = $("#global-new-project-panel");
  if (panel) panel.style.display = "none";
  currentProject = data.name;
  await loadProjects();
  switchToTab("runs");
  loadRunsTab();
}

async function createProjectFromTemplate() {
  const name = ($("#new-project-name")?.value || "").trim();
  const template = $("#new-project-template")?.value || "code-dev";
  const errEl = $("#new-project-error");
  if (errEl) errEl.textContent = "";
  if (!name) {
    if (errEl) errEl.textContent = "Enter a project name (letters, numbers, _ or -).";
    return;
  }
  const res = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, template }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status !== 201) {
    if (errEl) errEl.textContent = data.error || "Failed to create project";
    return;
  }
  currentProject = data.name;
  await loadProjects();
  switchToTab("runs");
  loadRunsTab();
}

function resetState() {
  currentRunId = null;
  currentRunData = null;
  currentStageIndex = -1;
  currentConfigPath = null;
  if (eventSource) { eventSource.close(); eventSource = null; }
}

// ══════════════════════════════════════
// ── Dashboard Tab: Overview (#45 next-action workbench)
// ══════════════════════════════════════

/** Navigate to Runs start form and focus input (≤2 steps from Home empty). */
function goToStartRun() {
  switchToTab("runs");
  showRunsList();
  // Focus after tab paint so the control is visible and submittable
  requestAnimationFrame(() => {
    const input = $("#run-input");
    const startBtn = $("#run-start-btn");
    if (input) {
      input.focus();
      return;
    }
    if (startBtn) startBtn.focus();
  });
}

async function loadDashboard() {
  const onboarding = $("#onboarding");
  const overview = $("#overview-page");

  // Zero projects → product onboarding (single primary create CTA)
  if (!projects.length) {
    if (onboarding) onboarding.style.display = "";
    if (overview) overview.style.display = "none";
    await populateTemplateSelect();
    return;
  }

  if (onboarding) onboarding.style.display = "none";
  if (overview) overview.style.display = "";

  const res = await api("/api/runs");
  if (res.status === 0) {
    showBanner(res.data?.error || "Server unreachable. Run: petri web", "error");
  } else if (res.status === 400 && res.data?.code === "NO_PROJECT") {
    showBanner(res.data.error, "error");
  } else {
    showBanner("");
  }
  const runs = (res.status === 200 && Array.isArray(res.data)) ? res.data : [];

  const sorted = runs.slice().sort((a, b) => (b.startedAt || "").localeCompare(a.startedAt || ""));
  const total = sorted.length;
  const activeRun = sorted.find((r) => r.status === "running" && r.runId);
  const running = sorted.filter((r) => r.status === "running").length;
  const totalCost = runs.reduce((sum, r) => sum + (r.totalUsage?.costUsd || 0), 0);
  const successRate = computeSuccessRate(runs);
  const completed = runs.filter((r) => computeRunStatuses(r).executionStatus === "completed").length;
  const actionLabel = activeRun ? "View current run" : total > 0 ? "Start another run" : "Start a run";

  // Primary next-action hero (not peer of KPI cards)
  const workbench = $("#home-workbench");
  if (workbench) {
    workbench.innerHTML = `
      <div id="home-next-action" class="home-next-action">
        <div class="home-project-context">
          <span class="home-project-label">Project</span>
          <strong class="home-project-name">${escHtml(currentProject || "—")}</strong>
        </div>
        <p class="home-next-hint">Describe a goal and run the pipeline — watch stages, gates, and retries evolve.</p>
        <button type="button" class="btn-primary btn-large" id="home-start-run-btn">${escHtml(actionLabel)}</button>
      </div>
    `;
    const startRunBtn = $("#home-start-run-btn");
    if (startRunBtn) {
      startRunBtn.addEventListener("click", () => {
        if (activeRun) openRunDetail(activeRun.runId);
        else goToStartRun();
      });
    }
  }

  // Keep operational metrics secondary. A brand-new project has no useful metrics yet.
  const metrics = $("#stats-cards");
  if (metrics) {
    metrics.className = "home-metrics";
    metrics.style.display = total ? "" : "none";
    metrics.innerHTML = total ? `
      <p class="home-metrics-summary" aria-label="Run metrics">
        <span>${total} total runs</span>
        <span>${successRate}% quality passed · ${completed} completed</span>
        <span>${running} running</span>
        <span>${formatCost(totalCost)} total cost</span>
      </p>
    ` : "";
  }

  const recent = sorted.slice(0, 5);
  const tbody = $("#overview-runs-tbody");
  const emptyMsg = $("#overview-runs-empty");

  if (recent.length > 0) {
    if (emptyMsg) emptyMsg.style.display = "none";
    $("#overview-runs-table").style.display = "table";
    tbody.innerHTML = recent.map((r) => renderRunRow(r)).join("");
    tbody.querySelectorAll("tr").forEach((row) => {
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", "Open run " + row.dataset.runid);
      const open = () => openRunDetail(row.dataset.runid);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          open();
        }
      });
    });
  } else {
    if (emptyMsg) emptyMsg.style.display = "";
    $("#overview-runs-table").style.display = "none";
    tbody.innerHTML = "";
  }
}

async function populateTemplateSelect() {
  const sel = $("#new-project-template");
  if (!sel) return;
  const res = await fetch("/api/templates");
  if (!res.ok) {
    sel.innerHTML = '<option value="code-dev">code-dev</option>';
    return;
  }
  const templates = await res.json();
  if (!Array.isArray(templates) || templates.length === 0) {
    sel.innerHTML = '<option value="code-dev">code-dev</option>';
    return;
  }
  sel.innerHTML = templates.map((t) =>
    `<option value="${escAttr(t.id)}">${escHtml(t.name || t.id)}${t.description ? " — " + escHtml(t.description.slice(0, 60)) : ""}</option>`
  ).join("");
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
  // Detail was display:none during init; re-apply clamps now that the layout
  // has a real size so I/O / timeline / runs splitters can redistribute space.
  setRunsSplitWidth(runsSplitWidth);
  setTimelineSummaryHeight(runSummaryHeight);
  syncIoSplitter();
  loadRun(runId);
}

async function loadBranches() {
  const sel = $("#run-branch");
  if (!sel) return;
  const res = await api("/api/branches");
  const prev = currentBranch;
  sel.innerHTML = '<option value="">(default project runs)</option>';
  if (res.status === 200 && Array.isArray(res.data)) {
    for (const b of res.data) {
      const id = b.branch_id || b.id;
      sel.innerHTML += `<option value="${escAttr(id)}">${escHtml(id)}</option>`;
    }
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  else sel.value = "";
  currentBranch = sel.value || "";
  updateBranchMeta();
  if (!sel.dataset.bound) {
    sel.dataset.bound = "1";
    sel.addEventListener("change", () => {
      currentBranch = sel.value || "";
      updateBranchMeta();
      // reload run list for this branch context
      if (!currentRunId) loadRunsTab();
    });
  }
}

function updateBranchMeta() {
  const meta = $("#run-branch-meta");
  if (!meta) return;
  if (!currentBranch) {
    meta.textContent = "Runs use project .petri/runs (no branch).";
    return;
  }
  // Fetch branches again for meta - cache from options only
  meta.textContent = "Branch: " + currentBranch + " · runs under .petri/branches/" + currentBranch + "/runs";
  api("/api/branches").then((res) => {
    if (res.status !== 200 || !Array.isArray(res.data)) return;
    const b = res.data.find((x) => x.branch_id === currentBranch);
    if (!b) return;
    const parts = [`Branch: ${b.branch_id}`];
    if (b.objective) parts.push("objective: " + b.objective);
    if (b.baseline) parts.push("baseline: " + b.baseline);
    meta.textContent = parts.join(" · ");
  });
}

async function loadRunsTab() {
  clearRunFormErrorsOnEnter();
  await loadBranches();

  // Make sure we're on list view
  if (currentRunId) return; // detail view is showing, don't overwrite

  // Populate pipeline dropdown from GET /api/pipelines:
  // value = file path (engine), label = logical name (YAML name:)
  const pipelineSelect = $("#run-pipeline");
  // Ensure input hint container exists (issue #23)
  let inputHint = $("#run-input-hint");
  if (!inputHint && $("#run-input")) {
    inputHint = document.createElement("p");
    inputHint.id = "run-input-hint";
    inputHint.className = "config-nav-sub";
    $("#run-input").parentElement?.insertBefore(inputHint, $("#run-input").nextSibling);
  }

  const pipesRes = await api("/api/pipelines");
  if (pipesRes.status === 200 && Array.isArray(pipesRes.data) && pipesRes.data.length > 0) {
    const pipes = pipesRes.data;
    runPipelineMeta = pipes;
    const nameCount = {};
    for (const p of pipes) nameCount[p.name] = (nameCount[p.name] || 0) + 1;
    pipelineSelect.innerHTML = pipes
      .map((pipe) => {
        let label = pipe.name || pipe.file;
        if (nameCount[pipe.name] > 1 && pipe.name !== pipe.file) {
          label = `${pipe.name} (${pipe.file})`;
        }
        return `<option value="${escAttr(pipe.file)}">${escHtml(label)}</option>`;
      })
      .join("");
  } else {
    pipelineSelect.innerHTML = '<option value="">No pipelines found</option>';
  }
  updateRunInputHint();
  if (!pipelineSelect.dataset.hintBound) {
    pipelineSelect.dataset.hintBound = "1";
    pipelineSelect.addEventListener("change", updateRunInputHint);
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
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", "Open run " + row.dataset.runid);
      const open = () => openRunDetail(row.dataset.runid);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter" || ev.key === " ") {
          ev.preventDefault();
          open();
        }
      });
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

let runPipelineMeta = [];

function updateRunInputHint() {
  const hint = $("#run-input-hint");
  const sel = $("#run-pipeline");
  if (!hint || !sel) return;
  const meta = runPipelineMeta.find((p) => p.file === sel.value) || runPipelineMeta[0];
  if (!meta) {
    hint.textContent = "Input priority: explicit Input → .petri/goal.md → pipeline.goal";
    return;
  }
  const parts = [];
  if (meta.inputDescription) parts.push("Input: " + meta.inputDescription);
  if (meta.goal) parts.push("Pipeline goal available (used if Input empty)");
  parts.push("Priority: explicit Input → .petri/goal.md → pipeline.goal");
  hint.textContent = parts.join(" · ");
}

function syncRunInputError() {
  const errorEl = $("#run-error");
  const inputEl = $("#run-input");
  if (!errorEl || !inputEl) return;
  const val = inputEl.value.trim();
  // Clear stale required error once input is non-empty (issue #20)
  if (val && errorEl.textContent.includes("required")) {
    errorEl.textContent = "";
  }
  // When empty, do not show error until user submits — keep consistent re-entry
  if (!val && errorEl.textContent.includes("required")) {
    // leave until submit; re-entry clears below
  }
}

function clearRunFormErrorsOnEnter() {
  const errorEl = $("#run-error");
  const inputEl = $("#run-input");
  if (!errorEl || !inputEl) return;
  // Re-entering Runs: error must match current value
  if (inputEl.value.trim()) errorEl.textContent = "";
  else errorEl.textContent = ""; // never keep stale error from prior visit
}

async function startNewRun() {
  const btn = $("#run-start-btn");
  const errorEl = $("#run-error");
  const pipeline = $("#run-pipeline").value;
  const input = $("#run-input").value.trim();

  errorEl.textContent = "";
  // Explicit input optional when goal.md or pipeline.goal exists (issue #23)
  btn.disabled = true;
  btn.textContent = "Starting...";

  const body = { input: input || "" };
  if (pipeline) body.pipeline = pipeline;
  if (currentBranch) body.branch = currentBranch;

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
  currentStageIndex = -1;

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
  renderRunLineage();

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
  // The default is a human-readable workbench. Raw trace remains available
  // only inside an explicitly expanded stage detail.
  const trace = currentRunData.trace;
  if (trace && Array.isArray(trace.root) && trace.root.length > 0) {
    renderWorkbenchStages(list, trace);
    return;
  }

  // Prefer evolution view (stage → attempts) when present
  const evolution = currentRunData.evolution;
  if (Array.isArray(evolution) && evolution.length > 0) {
    const flat = [];
    for (const e of evolution) {
      for (const a of e.attempts || []) {
        flat.push({
          stage: e.stage,
          role: a.role,
          attempt: a.attempt,
          model: a.model,
          provider: a.provider,
          durationMs: a.durationMs,
          gatePassed: a.gatePassed,
          gateReason: a.gateReason,
          artifacts: a.artifacts,
        });
      }
    }
    currentRunData._flatStages = flat;
    if (flat.length === 0) {
      list.innerHTML = '<p class="empty-state">No stage attempts yet.</p>';
      return;
    }
    list.innerHTML = flat.map((s, i) => {
      const dotClass = s.gatePassed === true ? "passed" : s.gatePassed === false ? "failed" : "pending";
      const attemptStr = s.attempt ? ` · attempt ${s.attempt}` : "";
      return `
      <button type="button" class="stage-item${i === currentStageIndex ? " active" : ""}" data-index="${i}">
        <div class="stage-dot ${dotClass}"></div>
        <div class="stage-info">
          <div class="stage-name">${escHtml(s.stage)}${attemptStr}</div>
          <div class="stage-meta">${escHtml(s.role === "command" ? "Command Stage" : (s.role || ""))}${s.role === "command" ? "" : (s.provider ? " · " + escHtml(s.provider) : "")}${s.role === "command" ? "" : (s.model ? " · " + escHtml(s.model) : "")} · ${formatDuration(s.durationMs)}</div>
          ${s.gatePassed === false && s.gateReason ? `<div class="stage-fail-reason">${escHtml(s.gateReason)}</div>` : ""}
        </div>
      </button>`;
    }).join("");
    list.querySelectorAll(".stage-item").forEach((el) => {
      el.addEventListener("click", () => selectStage(parseInt(el.dataset.index, 10)));
    });
    return;
  }

  const stages = currentRunData.stages || [];
  currentRunData._flatStages = stages;

  if (stages.length === 0) {
    list.innerHTML = '<p class="empty-state">No stages in this run yet. Waiting for attempts…</p>';
    return;
  }

  list.innerHTML = stages.map((s, i) => {
    const dotClass = s.gatePassed === true ? "passed" : s.gatePassed === false ? "failed" : "pending";
    const usage = s.usage || {};
    const costStr = usage.costUsd ? ` · ${formatCost(usage.costUsd)}` : "";
    const providerStr = s.provider ? ` · ${s.provider}` : "";
    const modelStr = s.model ? ` · ${s.model}` : "";
    const attemptStr = s.attempt ? ` · attempt ${s.attempt}` : "";
    return `
      <button type="button" class="stage-item${i === currentStageIndex ? " active" : ""}" data-index="${i}">
        <div class="stage-dot ${dotClass}"></div>
        <div class="stage-info">
          <div class="stage-name">${escHtml(s.stage)}${attemptStr}</div>
          <div class="stage-meta">${escHtml(s.role === "command" ? "Command Stage" : (s.role || ""))}${s.role === "command" ? "" : providerStr + modelStr} · ${formatDuration(s.durationMs)}${costStr}</div>
        </div>
      </button>
    `;
  }).join("");

  list.querySelectorAll(".stage-item").forEach((el) => {
    el.addEventListener("click", () => selectStage(parseInt(el.dataset.index, 10)));
  });
}

function buildStageSummaries(trace) {
  const attempts = [];
  const visit = (nodes) => (nodes || []).forEach((node) => {
    if (node.kind === "repeat_iteration") return visit(node.children);
    if (node.kind === "stage_attempt") attempts.push(node);
  });
  visit(trace.root);
  const stageLogs = currentRunData?.stages || [];
  return attempts.map((node) => {
    const matching = stageLogs.filter((s) => s.stage === node.stage && String(s.attempt) === String(node.attempt));
    const gatePassed = node.stageGate?.passed ?? (matching.length ? matching.every((s) => s.gatePassed !== false) : undefined);
    const status = gatePassed === true ? "passed" : gatePassed === false ? "failed" : node.status === "running" ? "running" : "pending";
    const start = node.startedAt ? new Date(node.startedAt).getTime() : NaN;
    const end = node.finishedAt ? new Date(node.finishedAt).getTime() : NaN;
    return {
      key: `${node.stage}:${node.iteration ?? 0}:${node.attempt}`,
      stage: node.stage,
      attempt: node.attempt,
      iteration: node.iteration,
      repeatName: node.repeatName,
      status,
      reason: gatePassed === false ? (node.stageGate?.reason || matching.find((s) => s.gatePassed === false)?.gateReason || "Stage gate failed") : "",
      durationMs: Number.isFinite(start) && Number.isFinite(end) ? end - start : undefined,
      roles: node.roles || matching.map((s) => ({
        role: s.role,
        model: s.model,
        provider: s.provider,
        gatePassed: s.gatePassed,
        gateReason: s.gateReason,
        artifacts: s.artifacts,
      })),
      rawId: node.id,
    };
  });
}

function formatStageLabel(stage) {
  const labels = { issue: "Issue", design: "Design", develop: "Develop", unit_test: "Test", review: "Review" };
  return labels[stage] || String(stage).replace(/[_-]+/g, " ").replace(/\b\w/g, (x) => x.toUpperCase());
}

function formatStageStatus(status) {
  return { passed: "通过", failed: "失败", running: "进行中", pending: "等待中" }[status] || "等待中";
}

function summarizeStageReason(reason, stage) {
  const text = String(reason || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/command failed/i.test(text)) {
    return `${formatStageLabel(stage)} 命令失败；在 Gate 或 Log 查看完整输出`;
  }
  return text.length > 110 ? `${text.slice(0, 107)}…` : text;
}

/**
 * Map workbench selection → run.stages[] index (issue #55).
 * Same algorithm as src/web/stage-index.ts (inlined for static public UI).
 * Prefer artifactHint so sparse stages[] (ghost timed-out attempts only in
 * trace) do not shift later iteration I/O bindings.
 */
function extractArtifactHint(paths) {
  if (!paths || paths.length === 0) return null;
  for (const raw of paths) {
    const p = String(raw).replace(/\\/g, "/");
    const idx = p.lastIndexOf("/artifacts/");
    const rel = idx >= 0 ? p.slice(idx + "/artifacts/".length) : p;
    const m = rel.match(/^(\d+-[^/]+\/[^/]+)/);
    if (m) return m[1];
    const m2 = rel.match(/^(\d+-[^/]+)\//);
    if (m2) return m2[1];
  }
  return null;
}

function artifactHintFromRoles(roles) {
  if (!roles) return null;
  for (const r of roles) {
    const hint = extractArtifactHint(r.artifacts || undefined);
    if (hint) return hint;
  }
  return null;
}

function rolesHaveArtifacts(roles) {
  return (roles || []).some((r) => (r.artifacts || []).length > 0);
}

function resolveStageLogIndex(stages, query) {
  if (!stages || stages.length === 0 || !query?.stage) return -1;
  if (query.hasRoleArtifacts === false) return -1;

  const hint = query.artifactHint ? String(query.artifactHint).replace(/\\/g, "/") : "";
  if (hint) {
    for (let i = 0; i < stages.length; i++) {
      const s = stages[i];
      if (s.stage !== query.stage) continue;
      if (
        query.attempt != null
        && query.attempt !== ""
        && String(s.attempt ?? "") !== String(query.attempt)
      ) {
        continue;
      }
      if (query.role && s.role && s.role !== query.role) continue;
      const arts = s.artifacts || [];
      if (arts.some((a) => String(a).replace(/\\/g, "/").includes(hint))) return i;
    }
    return -1;
  }

  const matches = [];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    if (s.stage !== query.stage) continue;
    if (String(s.attempt ?? "") !== String(query.attempt ?? "")) continue;
    if (query.role && s.role !== query.role) continue;
    matches.push(i);
  }
  if (matches.length === 0) return -1;
  const occ = query.occurrence ?? 0;
  if (occ < 0) return matches[0];
  if (occ >= matches.length) return matches[matches.length - 1];
  return matches[occ];
}

function occurrenceAmongMatches(items, index, eligible) {
  const cur = items[index];
  if (!cur) return 0;
  let occ = 0;
  for (let i = 0; i < index; i++) {
    if (eligible && !eligible(items[i], i)) continue;
    const s = items[i];
    if (s.stage === cur.stage && String(s.attempt ?? "") === String(cur.attempt ?? "")) occ += 1;
  }
  return occ;
}

function stageSummaryIndex(summary, role, summaries) {
  const list = summaries || [];
  const hasArts = rolesHaveArtifacts(summary.roles);
  const artifactHint = artifactHintFromRoles(summary.roles);
  const si = list.findIndex((s) => s.key === summary.key);
  const occurrence =
    si >= 0
      ? occurrenceAmongMatches(list, si, (_item, i) => rolesHaveArtifacts(list[i].roles))
      : 0;
  return resolveStageLogIndex(currentRunData?.stages || [], {
    stage: summary.stage,
    attempt: summary.attempt,
    role,
    occurrence: hasArts ? occurrence : 0,
    artifactHint,
    hasRoleArtifacts: hasArts,
  });
}

function renderWorkbenchStages(list, trace) {
  const summaries = buildStageSummaries(trace);
  if (summaries.length === 0) {
    list.innerHTML = '<p class="empty-state">No stages yet.</p>';
    return;
  }
  list.innerHTML = summaries.map((summary, summaryIndex) => {
    const selected = stageSummaryIndex(summary, null, summaries) === currentStageIndex;
    const expanded = expandedStageKey === summary.key;
    const cycle = summary.repeatName ? `第 ${summary.iteration || 1} 轮` : "";
    const meta = [cycle, summary.durationMs != null ? formatDuration(summary.durationMs) : ""].filter(Boolean).join(" · ");
    const detailId = `stage-detail-${summary.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const occurrence = occurrenceAmongMatches(summaries, summaryIndex);
    const roles = summary.roles.map((role) => `<button type="button" class="stage-role-row" data-key="${escAttr(summary.key)}" data-stage="${escAttr(summary.stage)}" data-attempt="${escAttr(String(summary.attempt))}" data-role="${escAttr(role.role)}" data-occurrence="${occurrence}">
      <span class="stage-dot ${role.gatePassed === true ? "passed" : role.gatePassed === false ? "failed" : "pending"}"></span>
      <span>${escHtml(role.role === "command" ? "测试命令" : role.role)}</span>
    </button>`).join("");
    return `<div class="stage-workbench">
      <button type="button" class="stage-workbench-card${selected ? " active" : ""}" data-key="${escAttr(summary.key)}" data-stage="${escAttr(summary.stage)}" data-attempt="${escAttr(String(summary.attempt))}" data-occurrence="${occurrence}" aria-pressed="${selected ? "true" : "false"}">
        <span class="stage-dot ${summary.status === "passed" ? "passed" : summary.status === "failed" ? "failed" : "pending"}"></span>
        <span class="stage-card-copy"><span class="stage-card-title">${escHtml(formatStageLabel(summary.stage))}</span><span class="stage-card-meta">${escHtml(meta || "—")}</span></span>
        <span class="stage-status ${summary.status}">${formatStageStatus(summary.status)}</span>
      </button>
      ${summary.reason ? `<div class="stage-card-reason">${escHtml(summarizeStageReason(summary.reason, summary.stage))}</div>` : ""}
      <button type="button" class="stage-detail-toggle" data-key="${escAttr(summary.key)}" aria-expanded="${expanded ? "true" : "false"}" aria-controls="${detailId}">执行详情 ${expanded ? "−" : "+"}</button>
      <div id="${detailId}" class="stage-execution-detail" ${expanded ? "" : "hidden"}>
        ${roles || '<span class="stage-meta">等待角色执行</span>'}
        <div class="stage-gate-summary">Gate：${formatStageStatus(summary.status)}</div>
        <details class="trace-debug"><summary>Debug metadata</summary><code>${escHtml(summary.rawId)}</code></details>
      </div>
    </div>`;
  }).join("");
  list.querySelectorAll(".stage-workbench-card").forEach((el) => {
    el.addEventListener("click", () => {
      const summary = summaries.find((s) => s.key === el.dataset.key);
      const idx = summary ? stageSummaryIndex(summary, null, summaries) : -1;
      if (idx >= 0) selectStage(idx);
    });
  });
  list.querySelectorAll(".stage-detail-toggle").forEach((el) => {
    el.addEventListener("click", () => {
      expandedStageKey = expandedStageKey === el.dataset.key ? null : el.dataset.key;
      renderWorkbenchStages(list, trace);
    });
  });
  list.querySelectorAll(".stage-role-row").forEach((el) => {
    el.addEventListener("click", () => {
      const summary = summaries.find((s) => s.key === el.dataset.key);
      const idx = summary ? stageSummaryIndex(summary, el.dataset.role, summaries) : -1;
      if (idx >= 0) selectStage(idx);
    });
  });
}

function renderRunSummary() {
  const r = currentRunData;
  const usage = r.totalUsage || {};
  const { executionStatus, qualityStatus } = computeRunStatuses(r);
  const execClass = executionStatus === "completed" ? "" : executionStatus === "running" ? "stat-pending" : "";
  const qualityClass =
    qualityStatus === "passed" ? "stat-success" : qualityStatus === "failed" ? "stat-danger" : "";
  const blockedHtml =
    r.status === "blocked" && (r.blockedReason || r.blockedStage)
      ? `<div class="blocked-banner"><span class="label">Blocked:</span> ${escHtml(r.blockedStage || "")}${r.blockedStage && r.blockedReason ? " — " : ""}${escHtml(r.blockedReason || "unknown reason")}</div>`
      : "";
  const reqs = Array.isArray(r.requirements) ? r.requirements : [];
  const reqHtml = reqs.length
    ? `<div class="requirements-summary"><span class="label">Requirements:</span> ${
        reqs.map((x) => `<span class="${x.met ? "stat-success" : "stat-danger"}">${escHtml(x.id || "?")}: ${x.met ? "met" : "unmet"}${x.reason ? ` — ${escHtml(x.reason)}` : ""}</span>`).join(" · ")
      }</div>`
    : "";
  $("#run-summary").innerHTML = `
    <div><span class="label">Pipeline:</span> ${escHtml(r.pipeline)}</div>
    ${r.branchId ? `<div><span class="label">Branch:</span> ${escHtml(r.branchId)}</div>` : ""}
    <div><span class="label">Execution:</span> <span class="${execClass}">${escHtml(executionStatus)}</span> <span class="stage-meta">(${escHtml(r.status || "")})</span></div>
    <div><span class="label">Quality:</span> <span class="${qualityClass}">${escHtml(qualityStatus)}</span></div>
    <div><span class="label">Goal:</span> ${escHtml(r.goal || "(none)")}</div>
    <div><span class="label">Input:</span> <pre class="run-input-preview">${escHtml((r.input || "").slice(0, 500))}${(r.input || "").length > 500 ? "…" : ""}</pre></div>
    <div><span class="label">Started:</span> ${formatDate(r.startedAt)}</div>
    <div><span class="label">Duration:</span> ${formatDuration(r.durationMs)}</div>
    <div><span class="label">Tokens:</span> ${(usage.inputTokens || 0) + (usage.outputTokens || 0)}</div>
    <div><span class="label">Cost:</span> ${formatCost(usage.costUsd)}</div>
    ${reqHtml}
    ${blockedHtml}
  `;
}

function renderRunLineage() {
  const container = $("#run-lineage");
  if (!container) return;
  const lineage = Array.isArray(currentRunData?.lineage) ? currentRunData.lineage : [];
  if (lineage.length <= 1) {
    container.innerHTML = "";
    container.hidden = true;
    return;
  }
  container.hidden = false;
  container.innerHTML = `<span class="lineage-label">研发流程</span>${lineage.map((run, index) => {
    const isCurrent = String(run.runId) === String(currentRunId);
    const resume = run.resumedFrom ? ` · 从 run-${escHtml(run.resumedFrom.runId)} 的 ${escHtml(run.resumedFrom.stage)} 继续` : "";
    const arrow = index === 0 ? "" : '<span class="lineage-arrow" aria-hidden="true">→</span>';
    return `${arrow}<button type="button" class="lineage-run${isCurrent ? " active" : ""}" data-run-id="${escAttr(run.runId)}" aria-current="${isCurrent ? "step" : "false"}">run-${escHtml(run.runId)} · ${escHtml(run.status || "running")}${resume}</button>`;
  }).join("")}`;
  container.querySelectorAll(".lineage-run").forEach((el) => {
    el.addEventListener("click", () => openRunDetail(el.dataset.runId));
  });
}

function selectStage(index) {
  currentStageIndex = index;
  renderStageList();
  loadStageIO();
  loadRunLog();
  loadStageArtifacts();
  renderGateDetail();
}

function currentStageEntry() {
  const flat = currentRunData?._flatStages;
  if (flat && flat[currentStageIndex]) return flat[currentStageIndex];
  return currentRunData?.stages?.[currentStageIndex];
}

/** Prefer snapshot paths recorded on the selected attempt (issue #16). */
function resolveAttemptIoPrefix(stage) {
  const arts = stage.artifacts || [];
  for (const raw of arts) {
    const p = String(raw).replace(/\\/g, "/");
    const idx = p.lastIndexOf("/artifacts/");
    const rel = idx >= 0 ? p.slice(idx + "/artifacts/".length) : p;
    if (/^\d+-/.test(rel) || rel.includes("/")) {
      const parts = rel.split("/").filter(Boolean);
      if (parts.length >= 2) return parts.slice(0, 2).join("/");
      if (parts.length === 1) return parts[0];
    }
  }
  return stage.stage + "/" + (stage.role || "");
}

async function loadStageIO() {
  const promptEl = $("#io-prompt");
  const resultEl = $("#io-result");

  const stage = currentStageEntry();
  if (!stage) {
    promptEl.textContent = "Select a stage to view agent I/O.";
    resultEl.textContent = "";
    return;
  }

  const prefix = resolveAttemptIoPrefix(stage);

  // Load prompt (_prompt.md) from attempt snapshot when available
  const promptRes = await api("/api/runs/" + currentRunId + "/artifacts/" + prefix + "/_prompt.md");
  if (promptRes.status === 200 && promptRes.data) {
    promptEl.innerHTML = DOMPurify.sanitize(marked.parse(promptRes.data));
  } else {
    promptEl.textContent = "(No prompt saved for this attempt — available when snapshot includes _prompt.md)";
  }
  // A long prompt starts expanded in its own scroll pane so Result remains
  // visible and the divider is immediately available for mouse dragging.
  setIoPromptCollapsed(false);

  const resultRes = await api("/api/runs/" + currentRunId + "/artifacts/" + prefix + "/_result.md");
  if (resultRes.status === 200 && resultRes.data) {
    resultEl.innerHTML = DOMPurify.sanitize(marked.parse(resultRes.data));
  } else {
    resultEl.textContent = "(No result saved for this attempt — available when snapshot includes _result.md)";
  }
}

/** Filter run.log to the selected stage attempt only (issue #16). */
function filterLogForAttempt(logText, stage) {
  const lines = logText.split("\n");
  const filtered = [];
  let inAttempt = false;
  const stageHeader = `Stage "${stage.stage}"`;
  const attemptMarker =
    stage.attempt != null && stage.attempt > 0
      ? `Stage "${stage.stage}" attempt ${stage.attempt}/`
      : null;
  const stagePrefix = `  ${stage.stage}/`;

  for (const line of lines) {
    if (line.includes(stageHeader) && line.includes(" attempt ")) {
      inAttempt = attemptMarker ? line.includes(attemptMarker) : true;
      if (inAttempt) filtered.push(line);
      continue;
    }
    if (line.includes(stageHeader) && !attemptMarker) {
      inAttempt = true;
      filtered.push(line);
      continue;
    }
    if (inAttempt) {
      if (line.match(/\] Stage "/)) {
        inAttempt = false;
        if (line.includes(stageHeader) && attemptMarker && line.includes(attemptMarker)) {
          inAttempt = true;
          filtered.push(line);
        }
        continue;
      }
      if (line.includes(stagePrefix) || line.includes("  Gate [") || line.includes("  artifacts:")) {
        filtered.push(line);
      }
    }
  }
  return filtered.length > 0
    ? filtered.join("\n")
    : `No log entries for stage "${stage.stage}"${stage.attempt ? ` attempt ${stage.attempt}` : ""}.`;
}

async function loadRunLog() {
  const res = await api("/api/runs/" + currentRunId + "/log");
  if (res.status !== 200) {
    $("#log-output").textContent = "Failed to load log.";
    return;
  }

  const stage = currentStageEntry();
  if (!stage) {
    $("#log-output").textContent = res.data;
    return;
  }

  $("#log-output").textContent = filterLogForAttempt(res.data, stage);
}

/** Filter artifact list to the selected attempt using snapshot metadata (issue #16). */
function filterArtifactsForAttempt(artifacts, stage) {
  if (!stage) return artifacts;
  const attempt = stage.attempt;
  const role = stage.role;
  // Prefer explicit attempt metadata from run snapshots
  if (attempt != null && attempt > 0) {
    const exact = artifacts.filter(
      (a) => a.stage === stage.stage && a.attempt === attempt && (!role || !a.role || a.role === role),
    );
    if (exact.length > 0) return exact;
  }
  // Prefer paths recorded on the StageLog entry for this attempt
  if (Array.isArray(stage.artifacts) && stage.artifacts.length > 0) {
    const norms = stage.artifacts.map((p) => String(p).replace(/\\/g, "/"));
    const matched = artifacts.filter((a) => {
      const ap = a.path.replace(/\\/g, "/");
      return norms.some((n) => n.endsWith(ap) || n.includes(ap) || ap.includes(n.split("/artifacts/").pop() || "___"));
    });
    if (matched.length > 0) return matched;
  }
  // Path fallback: {seq}-{stage}/{role}/
  const pathMatched = artifacts.filter((a) => {
    const p = a.path.replace(/\\/g, "/");
    if (a.stage && a.stage !== stage.stage) return false;
    if (a.attempt != null && attempt != null && attempt > 0 && a.attempt !== attempt) return false;
    const m = p.match(/^(\d+)-([^/]+)\/([^/]+)\//);
    if (m) {
      if (m[2] !== stage.stage) return false;
      if (role && m[3] !== role) return false;
      return true;
    }
    if (p.startsWith(stage.stage + "/")) {
      if (role && !p.startsWith(stage.stage + "/" + role)) return false;
      return true;
    }
    return false;
  });
  return pathMatched.length > 0 ? pathMatched : [];
}

async function loadStageArtifacts() {
  const container = $("#artifacts-list");
  $("#artifact-preview").textContent = "";

  const res = await api("/api/runs/" + currentRunId + "/artifacts");
  if (res.status !== 200 || !Array.isArray(res.data) || res.data.length === 0) {
    container.innerHTML = '<p class="empty-state">No artifacts.</p>';
    return;
  }

  const stage = currentStageEntry();
  const artifacts = filterArtifactsForAttempt(res.data, stage);

  if (artifacts.length === 0) {
    container.innerHTML = '<p class="empty-state">No artifacts for this attempt.</p>';
    return;
  }

  container.innerHTML = artifacts.map((a) => `
    <button type="button" class="artifact-item" data-path="${escAttr(a.path)}">
      <span>${escHtml(a.path)}</span>
      <span class="artifact-size">${formatSize(a.size)}</span>
    </button>
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
  const stage = currentStageEntry();
  if (currentStageIndex < 0 || !stage) {
    gate.innerHTML = '<p class="empty-state">Select a stage to view gate results.</p>';
    return;
  }

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
      <div><strong>Provider:</strong> ${escHtml(stage.provider || "-")}</div>
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
  // Dedupe live SSE appends (issue #21): consecutive identical lines + structured keys
  // that include iteration/repeatName so Repeat loops reusing attempt # are kept.
  let lastSseLine = null;
  const seenSseKeys = new Set();
  let sseSeq = 0;

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      const line = formatSSEEvent(data);
      sseSeq += 1;
      const key = data.id
        ? "id:" + data.id
        : [
            data.type,
            data.stage,
            data.role,
            data.attempt,
            data.passed,
            data.status,
            data.iteration != null ? data.iteration : "",
            data.repeatName != null ? data.repeatName : "",
            // Without iteration/id, use monotonic seq so later repeat rounds survive
            data.iteration != null || data.id ? "" : "s" + sseSeq,
          ].join("|");
      if (line && line !== lastSseLine && !seenSseKeys.has(key)) {
        seenSseKeys.add(key);
        lastSseLine = line;
        logEl.textContent += "\n" + line;
        logEl.scrollTop = logEl.scrollHeight;
      }
      // Refresh stage list on stage completion or gate results
      if (data.type === "role-end" || data.type === "gate-result") {
        loadRun(runId);
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
    case "role-start": return `[${ts}] ${data.stage}/${data.role} — model: ${data.model || "?"}${data.provider ? ` | provider: ${data.provider}` : ""}`;
    case "role-end": return `[${ts}] ${data.stage}/${data.role} done (${formatDuration(data.durationMs)})`;
    case "gate-result": return `[${ts}] Gate [${data.passed ? "PASS" : "FAIL"}]: ${data.reason || ""}`;
    case "run-end": return `[${ts}] Run finished — ${data.status}`;
    default: return null;
  }
}

// ══════════════════════════════════════
// ── Config Tab (pipeline-centric, #12)
// ══════════════════════════════════════

let configPipelines = [];
let selectedConfigPipelineFile = null;

/** Hierarchical Run Trace timeline (Repeat → StageAttempt → Role → Gate). */
function renderTraceTimeline(list, trace) {
  const parts = [];
  for (const node of trace.root) {
    parts.push(renderTraceNode(node, 0));
  }
  list.innerHTML = parts.join("") || '<p class="empty-state">No trace nodes yet.</p>';
  list.querySelectorAll("[data-trace-stage]").forEach((el) => {
    el.addEventListener("click", () => {
      const stage = el.getAttribute("data-stage");
      const attempt = el.getAttribute("data-attempt");
      const role = el.getAttribute("data-role");
      if (stage && currentRunData && Array.isArray(currentRunData.stages)) {
        const idx = currentRunData.stages.findIndex(
          (s) => s.stage === stage
            && String(s.attempt) === String(attempt || s.attempt)
            && (!role || s.role === role),
        );
        if (idx >= 0) {
          selectStage(idx);
        }
      }
    });
  });
}

function renderTraceNode(node, depth) {
  const pad = depth * 12;
  if (node.kind === "repeat_iteration") {
    const kids = (node.children || []).map((c) => renderTraceNode(c, depth + 1)).join("");
    return `<div class="trace-repeat" data-trace-id="${escAttr(node.id)}" style="margin-left:${pad}px">
      <div class="trace-repeat-header">
        <span class="stage-dot ${node.status === "done" ? "passed" : node.status === "running" ? "pending" : "failed"}"></span>
        <div class="stage-name">Repeat ${escHtml(node.repeatName)} · iteration ${node.iteration}/${node.maxIterations}</div>
        <div class="stage-meta">${escHtml(node.id)}</div>
      </div>
      ${kids}
    </div>`;
  }
  // stage_attempt
  const roles = (node.roles || [])
    .map(
      (r) => {
        const active = traceSelectionMatches(node.stage, node.attempt, r.role) ? " active" : "";
        return `<button type="button" class="trace-role${active}" data-trace-stage data-stage="${escAttr(node.stage)}" data-attempt="${escAttr(String(node.attempt))}" data-role="${escAttr(r.role)}" aria-pressed="${active ? "true" : "false"}" style="margin-left:${pad + 12}px">
        <span class="stage-dot ${r.gatePassed === true ? "passed" : r.gatePassed === false ? "failed" : "pending"}"></span>
        <span>${escHtml(r.role)}</span>
        <span class="stage-meta">${escHtml(r.provider || "-")} · ${escHtml(r.model || "-")} · ${escHtml(r.id)}</span>
        ${r.gateReason ? `<div class="stage-fail-reason">${escHtml(r.gateReason)}</div>` : ""}
      </button>`;
      },
    )
    .join("");
  const gate = node.stageGate
    ? `<div class="trace-stage-gate" style="margin-left:${pad + 12}px">
        Stage gate [${node.stageGate.passed ? "PASS" : "FAIL"}]${node.stageGate.strategy ? " · " + escHtml(node.stageGate.strategy) : ""}: ${escHtml(node.stageGate.reason || "")}
        ${(node.stageGate.roleResults || [])
          .map((rr) => `<div class="stage-meta">${escHtml(rr.role)}: ${rr.passed ? "PASS" : "FAIL"} — ${escHtml(rr.reason || "")}</div>`)
          .join("")}
      </div>`
    : "";
  const rep =
    node.repeatName != null
      ? ` · rep ${escHtml(node.repeatName)} i${node.iteration}`
      : node.iteration
        ? ` · i${node.iteration}`
        : "";
  const active = traceSelectionMatches(node.stage, node.attempt) ? " active" : "";
  return `<div class="trace-attempt" style="margin-left:${pad}px">
    <button type="button" class="stage-item trace-attempt${active}" data-trace-stage data-stage="${escAttr(node.stage)}" data-attempt="${escAttr(String(node.attempt))}" aria-pressed="${active ? "true" : "false"}">
      <span class="stage-dot ${node.status === "done" ? "passed" : node.status === "running" ? "pending" : "failed"}"></span>
      <div class="stage-name">${escHtml(node.stage)} · attempt ${node.attempt}${rep}</div>
      <div class="stage-meta">${escHtml(node.id)}</div>
    </button>
    ${roles}
    ${gate}
  </div>`;
}

function traceSelectionMatches(stage, attempt, role) {
  const selected = currentStageEntry();
  return !!selected
    && selected.stage === stage
    && String(selected.attempt) === String(attempt)
    && (!role || selected.role === role);
}

async function loadConfigTab() {
  // Project settings always available
  const projBtn = $("#config-project-settings");
  if (projBtn && !projBtn.dataset.bound) {
    projBtn.dataset.bound = "1";
    projBtn.addEventListener("click", () => {
      clearConfigNavActive();
      projBtn.classList.add("active");
      selectedConfigPipelineFile = null;
      $("#config-structure-section").style.display = "none";
      loadConfigFile("petri.yaml");
    });
  }

  // Pipeline list by logical name
  const listEl = $("#config-pipeline-list");
  const emptyEl = $("#config-pipelines-empty");
  const pipesRes = await api("/api/pipelines");
  if (pipesRes.status !== 200 || !Array.isArray(pipesRes.data)) {
    if (listEl) {
      listEl.innerHTML =
        '<p class="empty-state">Failed to load pipelines. Check project selection or restart petri web.</p>';
    }
    configPipelines = [];
  } else {
    configPipelines = pipesRes.data;
    if (configPipelines.length === 0) {
      if (emptyEl) {
        emptyEl.style.display = "";
        emptyEl.textContent =
          "No pipelines found. Add a pipeline.yaml or create a project from a template on Home.";
      }
      if (listEl) listEl.innerHTML = emptyEl ? emptyEl.outerHTML : "";
    } else {
      if (emptyEl) emptyEl.style.display = "none";
      const nameCount = {};
      for (const p of configPipelines) nameCount[p.name] = (nameCount[p.name] || 0) + 1;
      listEl.innerHTML = configPipelines
        .map((p) => {
          let label = p.name || p.file;
          if (nameCount[p.name] > 1 && p.name !== p.file) {
            label = `${p.name} (${p.file})`;
          }
          const active =
            selectedConfigPipelineFile === p.file ? " active" : "";
          return `<button type="button" class="config-nav-item config-pipeline-item${active}" data-file="${escAttr(p.file)}">
            <span class="config-nav-title">${escHtml(label)}</span>
            <span class="config-nav-sub">${escHtml(p.file)}</span>
          </button>`;
        })
        .join("");
      listEl.querySelectorAll(".config-pipeline-item").forEach((el) => {
        el.addEventListener("click", () => selectConfigPipeline(el.dataset.file));
      });
    }
  }

  // Optional full file tree under "All files"
  await loadConfigAllFilesTree();

  // Restore selection
  if (selectedConfigPipelineFile) {
    selectConfigPipeline(selectedConfigPipelineFile);
  } else if (currentConfigPath) {
    loadConfigFile(currentConfigPath);
  }
}

function clearConfigNavActive() {
  $$(".config-nav-item").forEach((el) => el.classList.remove("active"));
  $$(".config-structure-item").forEach((el) => el.classList.remove("active"));
}

function selectConfigPipeline(file) {
  selectedConfigPipelineFile = file;
  const pipe = configPipelines.find((p) => p.file === file);
  clearConfigNavActive();
  $$(".config-pipeline-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.file === file);
  });

  const section = $("#config-structure-section");
  const tree = $("#config-structure-tree");
  const title = $("#config-structure-title");
  if (!pipe) {
    if (section) section.style.display = "none";
    return;
  }
  if (section) section.style.display = "";
  if (title) title.textContent = pipe.name || file;

  let html = "";
  html += `<button type="button" class="config-structure-item" data-path="${escAttr(pipe.file)}">
    <strong>Pipeline definition</strong>
    <span class="config-nav-sub">${escHtml(pipe.file)}</span>
  </button>`;

  for (const stage of pipe.stages || []) {
    const isCmd = stage.kind === "command" || (!stage.roles?.length && stage.command);
    if (isCmd) {
      html += `<div class="config-stage-label">Command Stage: ${escHtml(stage.name)}</div>`;
      html += `<div class="config-role-block">
        <div class="config-role-name">command</div>
        <div class="config-nav-sub">${escHtml(stage.command || "(command)")}</div>
        <div class="config-nav-sub">${stage.hasGate ? "gate: yes" : "gate: none"}</div>
      </div>`;
      continue;
    }
    html += `<div class="config-stage-label">Stage: ${escHtml(stage.name)}</div>`;
    for (const role of stage.roles || []) {
      const rolePrefix = `roles/${role}`;
      html += `<div class="config-role-block">
        <div class="config-role-name">${escHtml(role)}</div>
        <button type="button" class="config-structure-item" data-path="${escAttr(rolePrefix + "/role.yaml")}">role.yaml</button>
        <button type="button" class="config-structure-item" data-path="${escAttr(rolePrefix + "/soul.md")}">soul.md</button>
        <button type="button" class="config-structure-item" data-path="${escAttr(rolePrefix + "/gate.yaml")}">gate.yaml</button>
      </div>`;
    }
  }
  tree.innerHTML = html;
  tree.querySelectorAll(".config-structure-item").forEach((el) => {
    el.addEventListener("click", () => {
      tree.querySelectorAll(".config-structure-item").forEach((e) => e.classList.remove("active"));
      el.classList.add("active");
      loadConfigFile(el.dataset.path);
    });
  });

  // Open pipeline file by default
  loadConfigFile(pipe.file);
}

async function loadConfigAllFilesTree() {
  const res = await api("/api/config/files");
  const tree = $("#file-tree");
  if (!tree) return;

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
      html += `<button type="button" class="file-item${activeClass}" data-path="${escAttr(f)}">${escHtml(name)}</button>`;
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


function clearConfigValidateResult() {
  const box = $("#config-validate-result");
  if (!box) return;
  box.textContent = "";
  box.className = "config-validate-result";
}

async function validateConfigDraft() {
  const box = $("#config-validate-result");
  if (!box) return;
  const payload = {};
  if (currentConfigPath) {
    const editor = $("#editor-content");
    payload.drafts = { [currentConfigPath]: editor ? editor.value : "" };
  }
  const res = await api("/api/config/validate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (res.status === 200 && res.data?.valid) {
    box.className = "validate-ok";
    box.textContent = "Configuration is valid.";
  } else {
    box.className = "validate-err";
    const errs = res.data?.errors || [res.data?.error || "Validation failed"];
    box.textContent = Array.isArray(errs) ? errs.join("\n") : String(errs);
  }
}

async function loadConfigFile(filePath) {
  currentConfigPath = filePath;
  const editor = $("#editor-content");
  const filenameEl = $("#editor-filename");
  const saveBtn = $("#editor-save-btn");
  const statusEl = $("#editor-status");

  clearConfigValidateResult();
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
    const err =
      (res.data && res.data.error) ||
      (res.status === 404 ? "File not found." : "Failed to load file.");
    editor.value = err;
    statusEl.textContent = err;
    statusEl.className = "editor-status error";
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
// ── Create Tab: Wizard
// ══════════════════════════════════════

function onDescriptionInput() {
  const val = $("#create-description").value.trim();
  $("#wizard-next-1").disabled = !val;
}

function loadCreateTab() {
  loadTemplates();
  wizardRenderStep();
}

async function loadTemplates() {
  if (wizard.templates.length > 0) return;
  const res = await api("/api/templates");
  if (res.status === 200 && Array.isArray(res.data)) {
    wizard.templates = res.data;
    renderTemplateGrid();
  }
}

function renderTemplateGrid() {
  const grid = $("#template-grid");
  const blankSel = wizard.templateId === null ? " selected" : "";
  let html =
    '<button type="button" class="template-card blank-card' +
    blankSel +
    '" data-template-id="" aria-label="Blank template">' +
    '<div class="template-name">Blank</div>' +
    '<div class="template-desc">Start from scratch with a custom description.</div>' +
    "</button>";
  for (const t of wizard.templates) {
    const sel = wizard.templateId === t.id ? " selected" : "";
    html +=
      '<button type="button" class="template-card' +
      sel +
      '" data-template-id="' +
      escAttr(t.id) +
      '" aria-label="' +
      escAttr(t.name) +
      '">' +
      '<div class="template-name">' +
      escHtml(t.name) +
      "</div>" +
      '<div class="template-desc">' +
      escHtml(t.description) +
      "</div>" +
      '<div class="template-meta">' +
      t.stages.length +
      " stages · " +
      escHtml(t.roles.join(", ")) +
      "</div>" +
      "</button>";
  }
  grid.innerHTML = html;
  grid.querySelectorAll(".template-card").forEach((card) => {
    card.addEventListener("click", () => selectTemplate(card.dataset.templateId));
  });
}

function selectTemplate(templateId) {
  const tmpl = wizard.templates.find((t) => t.id === templateId);
  wizard.templateId = templateId || null;
  if (tmpl) {
    $("#create-description").value = tmpl.description;
  } else {
    $("#create-description").value = "";
  }
  onDescriptionInput();
  renderTemplateGrid();
}

function wizardGoTo(step) {
  const prev = wizard.step;
  wizard.step = step;
  wizardRenderStep();

  if (step === 2 && prev === 1) {
    wizard.description = $("#create-description").value.trim();
    startGenerate();
  }
  if (step === 3 && prev !== 4) {
    renderReviewStep();
  }
  if (step === 4) {
    renderRunStep();
  }
}

function wizardRenderStep() {
  $$(".step-item").forEach((el) => {
    const s = parseInt(el.dataset.step, 10);
    el.classList.remove("active", "completed");
    if (s === wizard.step) el.classList.add("active");
    else if (s < wizard.step) el.classList.add("completed");
  });
  $$(".wizard-step").forEach((el) => el.classList.remove("active"));
  const stepEl = $("#wizard-step-" + wizard.step);
  if (stepEl) stepEl.classList.add("active");
}

async function startGenerate() {
  const spinnerEl = $("#wizard-step-2 .spinner");
  const msgEl = $("#wizard-step-2 .generate-msg");
  if (spinnerEl) spinnerEl.style.display = "";
  if (msgEl) msgEl.style.display = "";
  $("#generate-error").style.display = "none";

  const res = await api("/api/generate", {
    method: "POST",
    body: JSON.stringify({ description: wizard.description }),
  });

  if (res.status === 200 && res.data.files) {
    wizard.generateResult = {
      status: res.data.status,
      files: res.data.files,
      errors: res.data.errors || [],
    };
    wizard.validationPassed = res.data.status === "ok";
    wizard.selectedFile = null;
    if (wizard.step === 2) wizardGoTo(3);
  } else {
    if (spinnerEl) spinnerEl.style.display = "none";
    if (msgEl) msgEl.style.display = "none";
    $("#generate-error").style.display = "";
    $("#generate-error-msg").textContent = (res.data && res.data.error) || "Generation failed.";
  }
}

function renderReviewStep() {
  if (!wizard.generateResult) return;
  renderStatusBanner();
  renderGeneratedFileTree();
  renderPipelinePreview();
}

function renderStatusBanner() {
  const banner = $("#create-status-banner");
  if (wizard.generateResult.status === "ok" || wizard.validationPassed) {
    banner.className = "create-status-banner success";
    banner.textContent = "Pipeline generated successfully. Review the files below, then proceed to run.";
  } else if (wizard.generateResult.status === "validation_failed") {
    banner.className = "create-status-banner warning";
    banner.textContent = "Generated with validation errors: " + wizard.generateResult.errors.join("; ");
  }
}

function renderGeneratedFileTree() {
  const tree = $("#gen-file-tree");
  const files = wizard.generateResult.files;
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
    html += '<div class="file-group-label">' + escHtml(label) + '</div>';
    groups[dir].sort().forEach((f) => {
      const name = f.split("/").pop();
      const activeClass = f === wizard.selectedFile ? " active" : "";
      html += '<button type="button" class="file-item' + activeClass + '" data-path="' + escAttr(f) + '">' + escHtml(name) + '</button>';
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
  if (files.length > 0 && !wizard.selectedFile) {
    loadGeneratedFile(files[0]);
    tree.querySelector(".file-item")?.classList.add("active");
  }
}

async function loadGeneratedFile(filePath) {
  wizard.selectedFile = filePath;
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
  if (!wizard.selectedFile) return;
  const saveBtn = $("#gen-editor-save-btn");
  const statusEl = $("#gen-editor-status");
  const content = $("#gen-editor-content").value;
  saveBtn.disabled = true;
  statusEl.textContent = "Saving...";
  statusEl.className = "editor-status";
  const res = await api("/api/generate/file?path=" + encodeURIComponent(wizard.selectedFile), {
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
      wizard.generateResult.status = "ok";
      wizard.generateResult.errors = [];
      wizard.validationPassed = true;
    } else {
      wizard.generateResult.status = "validation_failed";
      wizard.generateResult.errors = res.data.errors || [];
      wizard.validationPassed = false;
    }
    renderStatusBanner();
  }
}

async function renderPipelinePreview() {
  const container = $("#pipeline-preview");
  const res = await api("/api/generate/file?path=pipeline.yaml");
  if (res.status !== 200) {
    container.innerHTML = '<p class="empty-state">No pipeline to preview.</p>';
    return;
  }
  const content = typeof res.data === "string" ? res.data : res.data.content || "";
  const prev = await api("/api/pipeline/preview", {
    method: "POST",
    body: JSON.stringify({ content }),
  });
  if (prev.status !== 200 || !prev.data) {
    container.innerHTML = '<p class="empty-state">Could not parse pipeline structure.</p>';
    return;
  }
  const tree = prev.data;
  let html = '<div class="preview-header">';
  if (tree.name) html += "<h3>" + escHtml(tree.name) + "</h3>";
  if (tree.description) html += "<p>" + escHtml(tree.description) + "</p>";
  if (tree.goal) html += "<p><strong>Goal:</strong> " + escHtml(tree.goal) + "</p>";
  html += "</div>";
  html += renderPreviewNodesClient(tree.nodes || [], 0);
  container.innerHTML = html || '<p class="empty-state">Could not parse pipeline structure.</p>';
}

function renderPreviewNodesClient(nodes, depth) {
  let html = "";
  (nodes || []).forEach((n, i) => {
    if (i > 0 && depth === 0) html += '<div class="preview-arrow">↓</div>';
    const pad = depth * 12;
    if (n.kind === "repeat") {
      html += `<div class="preview-stage preview-repeat" style="margin-left:${pad}px">
        <div class="preview-stage-name">Repeat: ${escHtml(n.name)}</div>
        <div class="preview-stage-meta">max ${n.maxIterations ?? "?"} · until ${escHtml(n.until || "?")}</div>
      </div>`;
      html += renderPreviewNodesClient(n.children || [], depth + 1);
    } else if (n.kind === "command") {
      html += `<div class="preview-stage preview-command" style="margin-left:${pad}px">
        <div class="preview-stage-name">Command: ${escHtml(n.name)}</div>
        <div class="preview-stage-meta">${escHtml(n.command || "")}${n.hasGate ? " · gate" : ""}</div>
      </div>`;
    } else {
      html += `<div class="preview-stage" style="margin-left:${pad}px">
        <div class="preview-stage-name">${escHtml(n.name)}</div>
        <div class="preview-stage-meta">→ ${escHtml((n.roles || []).join(", ") || "(no roles)")}</div>
      </div>`;
    }
  });
  return html;
}


function renderRunStep() {
  if (!wizard.generateResult) return;
  const info = $("#run-summary-info");
  const files = wizard.generateResult.files;
  info.innerHTML =
    "<div><strong>Pipeline:</strong> " + escHtml(wizard.description.slice(0, 100)) + (wizard.description.length > 100 ? "..." : "") + "</div>" +
    "<div><strong>Files to promote:</strong> " + files.length + " files</div>";
  $("#run-confirm-error").textContent = "";
}

async function confirmAndRun() {
  const btn = $("#create-confirm-btn");
  const errorEl = $("#run-confirm-error");
  btn.disabled = true;
  btn.textContent = "Promoting...";
  errorEl.textContent = "";
  const promoteRes = await api("/api/generate/promote", { method: "POST" });
  if (promoteRes.status !== 200) {
    btn.disabled = false;
    btn.textContent = "Confirm & Run";
    errorEl.textContent = "Promote failed: " + ((promoteRes.data && promoteRes.data.error) || "Unknown error");
    return;
  }
  btn.textContent = "Starting run...";
  const input = wizard.description || "";
  const runRes = await api("/api/runs", {
    method: "POST",
    body: JSON.stringify({ input }),
  });
  btn.disabled = false;
  btn.textContent = "Confirm & Run";
  if (runRes.status === 200 && runRes.data.runId) {
    wizard = {
      step: 1,
      description: "",
      templateId: null,
      generateResult: null,
      selectedFile: null,
      validationPassed: false,
      templates: wizard.templates,
    };
    openRunDetail(runRes.data.runId);
  } else {
    errorEl.textContent = (runRes.data && runRes.data.error) || "Failed to start run.";
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
