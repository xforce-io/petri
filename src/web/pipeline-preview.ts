import { parse as parseYaml } from "yaml";

export interface PreviewNode {
  kind: "stage" | "command" | "repeat";
  name: string;
  roles?: string[];
  command?: string;
  hasGate?: boolean;
  maxIterations?: number;
  until?: string;
  children?: PreviewNode[];
}

/** Build preview tree from pipeline YAML text (issue #24). */
export function buildPipelinePreviewTree(yamlText: string): {
  name?: string;
  description?: string;
  goal?: string;
  nodes: PreviewNode[];
} {
  const parsed = parseYaml(yamlText) as {
    name?: string;
    description?: string;
    goal?: string;
    stages?: unknown;
  } | null;
  if (!parsed || typeof parsed !== "object") {
    return { nodes: [] };
  }
  return {
    name: typeof parsed.name === "string" ? parsed.name : undefined,
    description: typeof parsed.description === "string" ? parsed.description : undefined,
    goal: typeof parsed.goal === "string" ? parsed.goal : undefined,
    nodes: walkStages(parsed.stages),
  };
}

function walkStages(raw: unknown): PreviewNode[] {
  if (!Array.isArray(raw)) return [];
  const out: PreviewNode[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.repeat && typeof e.repeat === "object") {
      const r = e.repeat as {
        name?: string;
        max_iterations?: number;
        until?: string;
        stages?: unknown;
      };
      out.push({
        kind: "repeat",
        name: typeof r.name === "string" ? r.name : "(unnamed repeat)",
        maxIterations: typeof r.max_iterations === "number" ? r.max_iterations : undefined,
        until: typeof r.until === "string" ? r.until : undefined,
        children: walkStages(r.stages),
      });
      continue;
    }
    if (typeof e.command === "string") {
      out.push({
        kind: "command",
        name: typeof e.name === "string" ? e.name : "(command)",
        command: e.command,
        hasGate: e.gate != null,
      });
      continue;
    }
    if (typeof e.name === "string") {
      out.push({
        kind: "stage",
        name: e.name,
        roles: Array.isArray(e.roles)
          ? e.roles.filter((x): x is string => typeof x === "string")
          : [],
      });
    }
  }
  return out;
}

export function renderPreviewNodesHtml(
  nodes: PreviewNode[],
  escHtml: (s: string) => string,
  depth = 0,
): string {
  let html = "";
  nodes.forEach((n, i) => {
    if (i > 0 && depth === 0) html += '<div class="preview-arrow">↓</div>';
    const pad = depth * 12;
    if (n.kind === "repeat") {
      html += `<div class="preview-stage preview-repeat" style="margin-left:${pad}px">
        <div class="preview-stage-name">Repeat: ${escHtml(n.name)}</div>
        <div class="preview-stage-meta">max ${n.maxIterations ?? "?"} · until ${escHtml(n.until || "?")}</div>
      </div>`;
      if (n.children?.length) html += renderPreviewNodesHtml(n.children, escHtml, depth + 1);
    } else if (n.kind === "command") {
      html += `<div class="preview-stage preview-command" style="margin-left:${pad}px">
        <div class="preview-stage-name">Command: ${escHtml(n.name)}</div>
        <div class="preview-stage-meta">${escHtml(n.command || "")}${n.hasGate ? " · gate" : ""}</div>
      </div>`;
    } else {
      html += `<div class="preview-stage" style="margin-left:${pad}px">
        <div class="preview-stage-name">${escHtml(n.name)}</div>
        <div class="preview-stage-meta">→ ${(n.roles || []).map(escHtml).join(", ") || "(no roles)"}</div>
      </div>`;
    }
  });
  return html;
}
