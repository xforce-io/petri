/** Pure markup builders for keyboard-accessible controls (issue #22). */

export function stageItemButtonHtml(opts: {
  index: number;
  active: boolean;
  stage: string;
  role?: string;
  attempt?: number;
  gatePassed?: boolean | null;
  gateReason?: string;
  model?: string;
  durationLabel: string;
}): string {
  const active = opts.active ? " active" : "";
  const attemptStr = opts.attempt ? ` · attempt ${opts.attempt}` : "";
  const dot =
    opts.gatePassed === true ? "passed" : opts.gatePassed === false ? "failed" : "pending";
  const fail =
    opts.gatePassed === false && opts.gateReason
      ? `<div class="stage-fail-reason">${escapeHtml(opts.gateReason)}</div>`
      : "";
  return (
    `<button type="button" class="stage-item${active}" data-index="${opts.index}">` +
    `<div class="stage-dot ${dot}"></div>` +
    `<div class="stage-info">` +
    `<div class="stage-name">${escapeHtml(opts.stage)}${attemptStr}</div>` +
    `<div class="stage-meta">${escapeHtml(opts.role || "")}${opts.model ? " · " + escapeHtml(opts.model) : ""} · ${escapeHtml(opts.durationLabel)}</div>` +
    fail +
    `</div>` +
    `</button>`
  );
}

export function fileItemButtonHtml(path: string, name: string, active: boolean): string {
  const activeClass = active ? " active" : "";
  return `<button type="button" class="file-item${activeClass}" data-path="${escapeAttr(path)}">${escapeHtml(name)}</button>`;
}

export function templateCardButtonHtml(opts: {
  id: string;
  name: string;
  description: string;
  selected: boolean;
  blank?: boolean;
  meta?: string;
}): string {
  const sel = opts.selected ? " selected" : "";
  const blank = opts.blank ? " blank-card" : "";
  const meta = opts.meta
    ? `<div class="template-meta">${escapeHtml(opts.meta)}</div>`
    : "";
  return (
    `<button type="button" class="template-card${blank}${sel}" data-template-id="${escapeAttr(opts.id)}" aria-label="${escapeAttr(opts.name)}">` +
    `<div class="template-name">${escapeHtml(opts.name)}</div>` +
    `<div class="template-desc">${escapeHtml(opts.description)}</div>` +
    meta +
    `</button>`
  );
}

/** True if every <button> has a matching </button> and no attribute-stuffed tabindex. */
export function isWellFormedInteractiveHtml(html: string): boolean {
  if (/tabindex="0[^"]*\s(blank-card|selected)/.test(html)) return false;
  if (/tabindex="0\s+selected"/.test(html)) return false;
  const open = (html.match(/<button\b/g) || []).length;
  const close = (html.match(/<\/button>/g) || []).length;
  if (open !== close) return false;
  // stage-item / file-item / template-card must be buttons when present as controls
  if (/<div class="stage-item\b/.test(html)) return false;
  if (/<div class="file-item\b/.test(html)) return false;
  if (/<div class="template-card\b/.test(html)) return false;
  return true;
}

function escapeHtml(str: string): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(str: string): string {
  return escapeHtml(str);
}
