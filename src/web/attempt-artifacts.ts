/**
 * Helpers to bind Run Detail I/O / logs / artifacts to a specific stage attempt (issue #16).
 */

export interface ArtifactListItem {
  path: string;
  size: number;
  stage?: string;
  role?: string;
  attempt?: number;
  sequence?: number;
}

export interface AttemptSelection {
  stage: string;
  role?: string;
  attempt?: number;
}

/** Match artifact list entries to the selected attempt (no cross-attempt leakage). */
export function filterArtifactsForAttempt(
  artifacts: ArtifactListItem[],
  sel: AttemptSelection | null | undefined,
): ArtifactListItem[] {
  if (!sel?.stage) return artifacts;
  const stage = sel.stage;
  const role = sel.role;
  const attempt = sel.attempt;

  const withMeta = artifacts.filter((a) => {
    if (a.stage && a.stage !== stage) return false;
    if (role && a.role && a.role !== role) return false;
    if (attempt != null && attempt > 0 && a.attempt != null && a.attempt !== attempt) return false;
    return true;
  });

  // Prefer entries that carry attempt metadata when filtering by attempt
  if (attempt != null && attempt > 0) {
    const exact = withMeta.filter((a) => a.attempt === attempt && a.stage === stage);
    if (exact.length > 0) {
      return role ? exact.filter((a) => !a.role || a.role === role) : exact;
    }
  }

  // Path-based: run snapshots look like "{seq}-{stage}/{role}/..."
  const pathMatched = artifacts.filter((a) => {
    const p = a.path.replace(/\\/g, "/");
    // seq-stage/role/...
    const m = p.match(/^(?:\d+-)?([^/]+)\/([^/]+)\//);
    if (m) {
      const st = m[1].replace(/^\d+-/, "");
      // path may be "001-work/worker/x" → stage part includes seq
      const stagePart = m[1];
      const rolePart = m[2];
      const stageFromPath = stagePart.includes("-")
        ? stagePart.replace(/^\d+-/, "")
        : stagePart;
      if (stageFromPath !== stage && stagePart !== stage) return false;
      if (role && rolePart !== role && rolePart !== "_snapshot.json") return false;
      return true;
    }
    // legacy stage/role/
    if (p.startsWith(`${stage}/`)) {
      if (role && !p.startsWith(`${stage}/${role}`)) return false;
      return true;
    }
    return false;
  });

  if (pathMatched.length > 0) return pathMatched;

  // Fall back to stage.artifacts absolute/relative paths recorded on the StageLog entry
  return withMeta;
}

/** Resolve snapshot-relative I/O paths for an attempt from recorded artifact paths. */
export function resolveAttemptIoPaths(
  recordedArtifacts: string[] | undefined,
  sel: AttemptSelection,
): { promptPath: string | null; resultPath: string | null; snapshotPrefix: string | null } {
  const arts = recordedArtifacts ?? [];
  // Find a path under .../artifacts/{seq}-{stage}/{role}/
  for (const raw of arts) {
    const p = raw.replace(/\\/g, "/");
    const idx = p.lastIndexOf("/artifacts/");
    if (idx >= 0) {
      const rel = p.slice(idx + "/artifacts/".length);
      const parts = rel.split("/");
      if (parts.length >= 2) {
        const prefix = parts.slice(0, 2).join("/"); // seq-stage/role
        return {
          promptPath: `${prefix}/_prompt.md`,
          resultPath: `${prefix}/_result.md`,
          snapshotPrefix: prefix,
        };
      }
    }
    // relative already under artifacts
    if (/^\d+-/.test(p)) {
      const parts = p.split("/");
      if (parts.length >= 2) {
        const prefix = parts.slice(0, 2).join("/");
        return {
          promptPath: `${prefix}/_prompt.md`,
          resultPath: `${prefix}/_result.md`,
          snapshotPrefix: prefix,
        };
      }
    }
  }
  // legacy fallback
  const legacy = `${sel.stage}/${sel.role || ""}`.replace(/\/$/, "");
  return {
    promptPath: `${legacy}/_prompt.md`,
    resultPath: `${legacy}/_result.md`,
    snapshotPrefix: legacy,
  };
}

/** Filter run.log text lines to a specific stage attempt. */
export function filterLogForAttempt(logText: string, sel: AttemptSelection): string {
  const lines = logText.split("\n");
  const filtered: string[] = [];
  let inAttempt = false;
  const stageHeader = `Stage "${sel.stage}"`;
  const attemptMarker =
    sel.attempt != null && sel.attempt > 0
      ? `Stage "${sel.stage}" attempt ${sel.attempt}/`
      : null;
  const stagePrefix = `  ${sel.stage}/`;

  for (const line of lines) {
    if (line.includes(stageHeader)) {
      if (attemptMarker) {
        inAttempt = line.includes(attemptMarker);
      } else {
        inAttempt = true;
      }
      if (inAttempt) filtered.push(line);
      continue;
    }
    if (inAttempt) {
      if (line.match(/\] Stage "/) && !line.includes(stageHeader)) {
        inAttempt = false;
        continue;
      }
      // next attempt of same stage ends current window
      if (
        attemptMarker &&
        line.includes(stageHeader) &&
        line.includes(" attempt ") &&
        !line.includes(attemptMarker)
      ) {
        inAttempt = false;
        continue;
      }
      if (
        line.includes(stagePrefix) ||
        line.includes("  Gate [") ||
        line.includes("  artifacts:") ||
        (sel.role && line.includes(`/${sel.role}`))
      ) {
        filtered.push(line);
      }
    }
  }

  if (filtered.length > 0) return filtered.join("\n");
  return `No log entries for stage "${sel.stage}"${sel.attempt ? ` attempt ${sel.attempt}` : ""}.`;
}

/** Convert absolute copied artifact paths under a run dir into run-relative paths. */
export function relativizeRunArtifactPaths(
  runDir: string,
  absolutePaths: string[],
): string[] {
  const base = runDir.replace(/\\/g, "/").replace(/\/$/, "") + "/";
  return absolutePaths.map((p) => {
    const norm = p.replace(/\\/g, "/");
    if (norm.startsWith(base)) return norm.slice(base.length);
    const art = "/artifacts/";
    const i = norm.lastIndexOf(art);
    if (i >= 0) return norm.slice(i + 1); // artifacts/...
    return p;
  });
}
