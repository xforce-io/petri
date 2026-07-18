import { execFileSync } from "node:child_process";

export interface GitHubIssueInputDeps {
  getOrigin?: (projectDir: string) => string;
  runGh?: (args: string[]) => string;
}

export interface GitHubIssueSource {
  url: string;
  owner: string;
  repo: string;
  number: number;
  title: string;
  state: string;
  labels: string[];
  commentCount: number;
}

export type GitHubIssueInputResult =
  | { input: string; source: "text" }
  | { input: string; source: "github_issue"; issue: GitHubIssueSource };

interface GitHubIssuePayload {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user?: { login?: string };
  labels?: Array<{ name?: string } | string>;
}

interface GitHubIssueCommentPayload {
  id: number;
  body: string | null;
  created_at?: string;
  updated_at?: string;
  user?: { login?: string };
}

/**
 * Expand a GitHub Issue URL into the complete, reviewable source context used
 * by the issue role. Ordinary text remains untouched and does not invoke git
 * or gh, so non-GitHub projects keep the existing input behavior.
 */
export function resolveGitHubIssueInput(
  opts: { projectDir: string; input: string } & GitHubIssueInputDeps,
): GitHubIssueInputResult {
  const parsed = parseGitHubIssueUrl(opts.input);
  if (!parsed) return { input: opts.input, source: "text" };

  const getOrigin = opts.getOrigin ?? defaultGetOrigin;
  const runGh = opts.runGh ?? defaultRunGh;
  let remote: string;
  try {
    remote = getOrigin(opts.projectDir);
  } catch (err) {
    throw new Error(`Failed to load GitHub Issue ${parsed.url}: ${errorMessage(err)}`);
  }
  const current = parseGitHubRemote(remote);
  if (!current) {
    throw new Error(
      `GitHub Issue URL ${parsed.url} requires a GitHub origin, but the current origin is not GitHub`,
    );
  }
  if (
    current.owner.toLowerCase() !== parsed.owner.toLowerCase()
    || current.repo.toLowerCase() !== parsed.repo.toLowerCase()
  ) {
    throw new Error(
      `GitHub Issue URL ${parsed.url} does not belong to current origin ${current.owner}/${current.repo}`,
    );
  }

  try {
    const issue = parseJson<GitHubIssuePayload>(
      runGh(["api", `repos/${parsed.owner}/${parsed.repo}/issues/${parsed.number}`]),
      `Issue ${parsed.url}`,
    );
    const comments = loadComments(runGh, parsed);
    const labels = (issue.labels ?? []).map((label) =>
      typeof label === "string" ? label : label.name ?? "",
    ).filter(Boolean);
    const source: GitHubIssueSource = {
      url: issue.html_url || parsed.url,
      owner: parsed.owner,
      repo: parsed.repo,
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels,
      commentCount: comments.length,
    };
    return {
      input: formatIssueInput(issue, comments, source),
      source: "github_issue",
      issue: source,
    };
  } catch (err) {
    const message = errorMessage(err);
    throw new Error(`Failed to load GitHub Issue ${parsed.url}: ${message}`);
  }
}

function parseGitHubIssueUrl(input: string): { url: string; owner: string; repo: string; number: number } | null {
  const trimmed = input.trim();
  if (!/^https?:\/\/github\.com\//i.test(trimmed)) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid GitHub Issue URL: ${trimmed}`);
  }
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
  if (!match) {
    throw new Error(`Invalid GitHub Issue URL: ${trimmed}. Expected https://github.com/<owner>/<repo>/issues/<number>`);
  }
  const [, owner, repo, number] = match;
  return { url: trimmed, owner, repo, number: Number(number) };
}

function parseGitHubRemote(remote: string): { owner: string; repo: string } | null {
  const match = remote.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
}

function defaultGetOrigin(projectDir: string): string {
  return execFileSync("git", ["remote", "get-url", "origin"], {
    cwd: projectDir,
    encoding: "utf-8",
  }).trim();
}

function defaultRunGh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf-8" });
}

function loadComments(
  runGh: (args: string[]) => string,
  issue: { owner: string; repo: string; number: number },
): GitHubIssueCommentPayload[] {
  const comments: GitHubIssueCommentPayload[] = [];
  for (let page = 1; ; page++) {
    const endpoint = `repos/${issue.owner}/${issue.repo}/issues/${issue.number}/comments?per_page=100&page=${page}`;
    const current = parseJson<GitHubIssueCommentPayload[]>(runGh(["api", endpoint]), `comments page ${page}`);
    if (!Array.isArray(current)) {
      throw new Error(`comments page ${page} returned a non-array response`);
    }
    comments.push(...current);
    if (current.length < 100) return comments;
  }
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

function formatIssueInput(
  issue: GitHubIssuePayload,
  comments: GitHubIssueCommentPayload[],
  source: GitHubIssueSource,
): string {
  const labels = source.labels.length > 0 ? source.labels.join(", ") : "none";
  const commentBlocks = comments.length === 0
    ? "(No comments)"
    : comments.map((comment, index) => [
      `### Comment ${index + 1} — ${comment.user?.login ?? "unknown"}${comment.created_at ? ` · ${comment.created_at}` : ""}`,
      comment.body?.trim() || "(empty comment)",
    ].join("\n\n")).join("\n\n");
  return [
    "# GitHub Issue Source",
    `Source URL: ${source.url}`,
    `Repository: ${source.owner}/${source.repo}`,
    `Issue: #${source.number}`,
    `State: ${source.state}`,
    `Author: ${issue.user?.login ?? "unknown"}`,
    `Labels: ${labels}`,
    "",
    "## Title",
    issue.title,
    "",
    "## Body",
    issue.body?.trim() || "(No body)",
    "",
    `## Comments (${comments.length})`,
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
