import { execFileSync } from "node:child_process";

export interface GitLabIssueInputDeps {
  getOrigin?: (projectDir: string) => string;
  /** Fetch raw JSON from GitLab API v4 path (no leading slash), e.g. `projects/foo%2Fbar/issues/1`. */
  runApi?: (opts: { host: string; apiPath: string }) => string;
}

export interface GitLabIssueSource {
  url: string;
  host: string;
  projectPath: string;
  number: number;
  title: string;
  state: string;
  labels: string[];
  commentCount: number;
}

export type GitLabIssueInputResult =
  | { input: string; source: "text" }
  | { input: string; source: "gitlab_issue"; issue: GitLabIssueSource };

interface GitLabIssuePayload {
  iid: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  author?: { username?: string };
  labels?: string[];
}

interface GitLabNotePayload {
  id: number;
  body: string | null;
  created_at?: string;
  system?: boolean;
  author?: { username?: string };
}

/**
 * Expand a GitLab Issue URL into the reviewable Issue Source context.
 * Ordinary text is unchanged and does not invoke git or the API.
 */
export function resolveGitLabIssueInput(
  opts: { projectDir: string; input: string } & GitLabIssueInputDeps,
): GitLabIssueInputResult {
  const parsed = parseGitLabIssueUrl(opts.input);
  if (!parsed) return { input: opts.input, source: "text" };

  const getOrigin = opts.getOrigin ?? defaultGetOrigin;
  const runApi = opts.runApi ?? defaultRunGitlabApi;
  let remote: string;
  try {
    remote = getOrigin(opts.projectDir);
  } catch (err) {
    throw new Error(`Failed to load GitLab Issue ${parsed.url}: ${errorMessage(err)}`);
  }
  const current = parseGitLabRemote(remote);
  if (!current) {
    throw new Error(
      `GitLab Issue URL ${parsed.url} requires a GitLab origin, but the current origin is not a GitLab-style remote`,
    );
  }
  if (
    current.host.toLowerCase() !== parsed.host.toLowerCase()
    || current.projectPath.toLowerCase() !== parsed.projectPath.toLowerCase()
  ) {
    throw new Error(
      `GitLab Issue URL ${parsed.url} does not belong to current origin ${current.host}/${current.projectPath}`,
    );
  }

  const projectId = encodeURIComponent(parsed.projectPath);
  try {
    const issue = parseJson<GitLabIssuePayload>(
      runApi({
        host: parsed.host,
        apiPath: `projects/${projectId}/issues/${parsed.number}`,
      }),
      `Issue ${parsed.url}`,
    );
    const notes = loadNotes(runApi, parsed.host, projectId, parsed.number);
    const labels = (issue.labels ?? []).filter(Boolean);
    const source: GitLabIssueSource = {
      url: issue.web_url || parsed.url,
      host: parsed.host,
      projectPath: parsed.projectPath,
      number: issue.iid ?? parsed.number,
      title: issue.title,
      state: issue.state,
      labels,
      commentCount: notes.length,
    };
    return {
      input: formatGitLabIssueInput(issue, notes, source),
      source: "gitlab_issue",
      issue: source,
    };
  } catch (err) {
    const message = errorMessage(err);
    throw new Error(`Failed to load GitLab Issue ${parsed.url}: ${message}`);
  }
}

/** Returns parsed issue ref if input is a GitLab issue URL; null if clearly not. */
export function parseGitLabIssueUrl(
  input: string,
): { url: string; host: string; projectPath: string; number: number } | null {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  // GitHub issue URLs are owned by the GitHub adapter.
  if (/^https?:\/\/github\.com\//i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  // Minimum supported form: /<project-path>/-/issues/<n>
  const match = url.pathname.match(/^\/(.+)\/-\/issues\/(\d+)\/?$/);
  if (!match) {
    // Looks like a GitLab-style attempt (has /-/issues without number, or wrong shape) → hard error
    if (/\/-\/issues\b/i.test(url.pathname)) {
      throw new Error(
        `Invalid GitLab Issue URL: ${trimmed}. Expected https://<host>/<project-path>/-/issues/<number>`,
      );
    }
    return null;
  }
  const projectPath = match[1].replace(/^\/+|\/+$/g, "");
  if (!projectPath || projectPath.includes("/-/")) {
    throw new Error(
      `Invalid GitLab Issue URL: ${trimmed}. Expected https://<host>/<project-path>/-/issues/<number>`,
    );
  }
  return {
    url: trimmed,
    host: url.host,
    projectPath,
    number: Number(match[2]),
  };
}

export function parseGitLabRemote(
  remote: string,
): { host: string; projectPath: string } | null {
  const trimmed = remote.trim();
  // git@host:group/project.git
  const ssh = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/i);
  if (ssh) {
    const host = ssh[1];
    if (/github\.com$/i.test(host)) return null;
    return { host, projectPath: ssh[2].replace(/\.git$/i, "") };
  }
  // https://host/group/project.git  or  https://host:port/group/sub/project
  try {
    const withScheme = /^[a-z+]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    if (/github\.com$/i.test(url.host)) return null;
    let projectPath = url.pathname.replace(/^\//, "").replace(/\.git$/i, "").replace(/\/$/, "");
    if (!projectPath) return null;
    // Ignore pure GitHub remotes already handled; any other host with a path is treated as GitLab-style.
    return { host: url.host, projectPath };
  } catch {
    return null;
  }
}

function defaultGetOrigin(projectDir: string): string {
  return execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: projectDir,
    encoding: "utf-8",
  }).trim();
}

function defaultRunGitlabApi(opts: { host: string; apiPath: string }): string {
  const token = process.env.GITLAB_API_TOKEN?.trim();
  if (token) {
    return execFileSync(
      "curl",
      [
        "-sS",
        "-f",
        "-H",
        `PRIVATE-TOKEN: ${token}`,
        `https://${opts.host}/api/v4/${opts.apiPath}`,
      ],
      { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
    );
  }
  try {
    return execFileSync("glab", ["api", opts.apiPath], {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    throw new Error(
      `GitLab API requires GITLAB_API_TOKEN or a working glab CLI: ${errorMessage(err)}`,
    );
  }
}

function loadNotes(
  runApi: (opts: { host: string; apiPath: string }) => string,
  host: string,
  projectId: string,
  issueIid: number,
): GitLabNotePayload[] {
  const notes: GitLabNotePayload[] = [];
  for (let page = 1; ; page++) {
    const apiPath =
      `projects/${projectId}/issues/${issueIid}/notes?per_page=100&page=${page}&sort=asc&order_by=created_at`;
    const current = parseJson<GitLabNotePayload[]>(
      runApi({ host, apiPath }),
      `notes page ${page}`,
    );
    if (!Array.isArray(current)) {
      throw new Error(`notes page ${page} returned a non-array response`);
    }
    for (const note of current) {
      if (note.system) continue;
      notes.push(note);
    }
    if (current.length < 100) return notes;
  }
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function formatGitLabIssueInput(
  issue: GitLabIssuePayload,
  notes: GitLabNotePayload[],
  source: GitLabIssueSource,
): string {
  const labels = source.labels.length > 0 ? source.labels.join(", ") : "none";
  const commentBlocks = notes.length === 0
    ? "(No comments)"
    : notes.map((note, index) => [
      `### Comment ${index + 1} — ${note.author?.username ?? "unknown"}${note.created_at ? ` · ${note.created_at}` : ""}`,
      note.body?.trim() || "(empty comment)",
    ].join("\n\n")).join("\n\n");
  return [
    "# Issue Source",
    "Platform: gitlab",
    `Source URL: ${source.url}`,
    `Host: ${source.host}`,
    `Repository: ${source.projectPath}`,
    `Issue: #${source.number}`,
    `State: ${source.state}`,
    `Author: ${issue.author?.username ?? "unknown"}`,
    `Labels: ${labels}`,
    "",
    "## Title",
    issue.title,
    "",
    "## Body",
    issue.description?.trim() || "(No body)",
    "",
    `## Comments (${notes.length})`,
    commentBlocks,
  ].join("\n");
}

function errorMessage(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? "").trim();
    if (stderr) return stderr;
  }
  return err instanceof Error ? err.message : String(err);
}
