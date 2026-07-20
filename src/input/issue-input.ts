import {
  resolveGitHubIssueInput,
  type GitHubIssueInputDeps,
  type GitHubIssueSource,
} from "./github-issue.js";
import {
  parseGitLabIssueUrl,
  resolveGitLabIssueInput,
  type GitLabIssueInputDeps,
  type GitLabIssueSource,
} from "./gitlab-issue.js";

export type IssueInputSource = "text" | "github_issue" | "gitlab_issue";

export type IssueInputResult =
  | { input: string; source: "text" }
  | { input: string; source: "github_issue"; issue: GitHubIssueSource }
  | { input: string; source: "gitlab_issue"; issue: GitLabIssueSource };

export type IssueInputDeps = GitHubIssueInputDeps & GitLabIssueInputDeps;

/**
 * Resolve pipeline input: expand GitHub/GitLab Issue URLs when recognized,
 * otherwise leave ordinary text unchanged (no remote calls).
 */
export function resolveIssueInput(
  opts: { projectDir: string; input: string } & IssueInputDeps,
): IssueInputResult {
  const trimmed = opts.input.trim();

  // GitHub host URLs stay on the GitHub adapter (including invalid issue-shaped attempts).
  if (/^https?:\/\/github\.com\//i.test(trimmed)) {
    return resolveGitHubIssueInput(opts);
  }

  // GitLab: parseGitLabIssueUrl returns null when clearly not an issue URL,
  // and throws on malformed /-/issues paths.
  const gitlabRef = parseGitLabIssueUrl(opts.input);
  if (gitlabRef) {
    return resolveGitLabIssueInput(opts);
  }

  return { input: opts.input, source: "text" };
}

export type { GitHubIssueSource, GitLabIssueSource };
