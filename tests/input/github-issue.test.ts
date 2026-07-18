import { describe, expect, it, vi } from "vitest";
import { resolveGitHubIssueInput } from "../../src/input/github-issue.js";

const issueUrl = "https://github.com/xforce-io/petri/issues/49";

describe("resolveGitHubIssueInput", () => {
  it("returns ordinary text unchanged without inspecting git or calling gh", () => {
    const getOrigin = vi.fn();
    const runGh = vi.fn();

    const result = resolveGitHubIssueInput({
      projectDir: "/project",
      input: "Build an issue resolver",
      getOrigin,
      runGh,
    });

    expect(result).toEqual({ input: "Build an issue resolver", source: "text" });
    expect(getOrigin).not.toHaveBeenCalled();
    expect(runGh).not.toHaveBeenCalled();
  });

  it("loads issue metadata and every comment page into the agent input", () => {
    const runGh = vi.fn((args: string[]) => {
      const endpoint = args.at(-1) ?? "";
      if (endpoint === "repos/xforce-io/petri/issues/49") {
        return JSON.stringify({
          number: 49,
          title: "Load Issue URL",
          body: "Issue body",
          state: "open",
          html_url: issueUrl,
          user: { login: "author" },
          labels: [{ name: "enhancement" }],
        });
      }
      if (endpoint.endsWith("page=1")) {
        return JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          body: `comment-${index + 1}`,
          created_at: "2026-07-18T00:00:00Z",
          updated_at: "2026-07-18T00:00:00Z",
          user: { login: "reviewer" },
        })));
      }
      if (endpoint.endsWith("page=2")) {
        return JSON.stringify([{
          id: 101,
          body: "last comment",
          created_at: "2026-07-19T00:00:00Z",
          updated_at: "2026-07-19T00:00:00Z",
          user: { login: "maintainer" },
        }]);
      }
      throw new Error(`unexpected endpoint: ${endpoint}`);
    });

    const result = resolveGitHubIssueInput({
      projectDir: "/project",
      input: issueUrl,
      getOrigin: () => "https://github.com/xforce-io/petri.git",
      runGh,
    });

    expect(result.source).toBe("github_issue");
    expect(result.input).toContain("Issue body");
    expect(result.input).toContain("comment-100");
    expect(result.input).toContain("last comment");
    expect(result.input).toContain("Comments (101)");
    expect(runGh).toHaveBeenCalledTimes(3);
  });

  it("rejects an Issue URL outside the current origin instead of silently using it", () => {
    expect(() => resolveGitHubIssueInput({
      projectDir: "/project",
      input: "https://github.com/other/repo/issues/7",
      getOrigin: () => "git@github.com:xforce-io/petri.git",
      runGh: vi.fn(),
    })).toThrow(/does not belong to current origin/);
  });

  it("includes the source URL when the current origin cannot be read", () => {
    expect(() => resolveGitHubIssueInput({
      projectDir: "/project",
      input: issueUrl,
      getOrigin: () => { throw new Error("fatal: not a git repository"); },
      runGh: vi.fn(),
    })).toThrow(new RegExp(`${issueUrl}.*not a git repository`));
  });

  it("reports GitHub fetch failures with the source URL", () => {
    expect(() => resolveGitHubIssueInput({
      projectDir: "/project",
      input: issueUrl,
      getOrigin: () => "https://github.com/xforce-io/petri.git",
      runGh: () => { throw new Error("HTTP 403: Resource not accessible"); },
    })).toThrow(new RegExp(`${issueUrl}.*HTTP 403`));
  });
});
