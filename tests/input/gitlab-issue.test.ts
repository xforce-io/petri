import { describe, expect, it, vi } from "vitest";
import {
  parseGitLabIssueUrl,
  parseGitLabRemote,
  resolveGitLabIssueInput,
} from "../../src/input/gitlab-issue.js";
import { resolveIssueInput } from "../../src/input/issue-input.js";

const issueUrl = "https://gitlab.example.com/acme/widgets/-/issues/42";

describe("parseGitLabIssueUrl", () => {
  it("parses nested group project paths", () => {
    expect(parseGitLabIssueUrl("https://git.corp.example/g1/g2/app/-/issues/7")).toEqual({
      url: "https://git.corp.example/g1/g2/app/-/issues/7",
      host: "git.corp.example",
      projectPath: "g1/g2/app",
      number: 7,
    });
  });

  it("returns null for ordinary text and GitHub URLs", () => {
    expect(parseGitLabIssueUrl("just a goal")).toBeNull();
    expect(parseGitLabIssueUrl("https://github.com/o/r/issues/1")).toBeNull();
  });

  it("rejects malformed /-/issues paths", () => {
    expect(() => parseGitLabIssueUrl("https://gitlab.com/group/proj/-/issues/"))
      .toThrow(/Invalid GitLab Issue URL/);
  });
});

describe("parseGitLabRemote", () => {
  it("parses https and ssh remotes including nested groups", () => {
    expect(parseGitLabRemote("https://gitlab.example.com/acme/widgets.git")).toEqual({
      host: "gitlab.example.com",
      projectPath: "acme/widgets",
    });
    expect(parseGitLabRemote("git@git.corp.example:g1/g2/app.git")).toEqual({
      host: "git.corp.example",
      projectPath: "g1/g2/app",
    });
  });

  it("returns null for GitHub remotes", () => {
    expect(parseGitLabRemote("https://github.com/xforce-io/petri.git")).toBeNull();
    expect(parseGitLabRemote("git@github.com:xforce-io/petri.git")).toBeNull();
  });
});

describe("resolveGitLabIssueInput", () => {
  it("returns ordinary text unchanged without inspecting git or calling the API", () => {
    const getOrigin = vi.fn();
    const runApi = vi.fn();

    const result = resolveGitLabIssueInput({
      projectDir: "/project",
      input: "Build a gitlab resolver",
      getOrigin,
      runApi,
    });

    expect(result).toEqual({ input: "Build a gitlab resolver", source: "text" });
    expect(getOrigin).not.toHaveBeenCalled();
    expect(runApi).not.toHaveBeenCalled();
  });

  it("loads issue metadata and every non-system note page into the agent input", () => {
    // Full page (100) then a short page — proves pagination without huge fixtures.
    const page1 = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      body: `note-${index + 1}`,
      created_at: "2026-07-20T00:00:00Z",
      system: false,
      author: { username: "reviewer" },
    }));
    const runApi = vi.fn((opts: { host: string; apiPath: string }) => {
      expect(opts.host).toBe("gitlab.example.com");
      if (opts.apiPath === "projects/acme%2Fwidgets/issues/42") {
        return JSON.stringify({
          iid: 42,
          title: "Load GitLab Issue URL",
          description: "GitLab issue body",
          state: "opened",
          web_url: issueUrl,
          author: { username: "author" },
          labels: ["enhancement"],
        });
      }
      const pageMatch = opts.apiPath.match(/[?&]page=(\d+)/);
      const page = pageMatch ? Number(pageMatch[1]) : 0;
      if (opts.apiPath.includes("/notes") && page === 1) {
        return JSON.stringify(page1);
      }
      if (opts.apiPath.includes("/notes") && page === 2) {
        return JSON.stringify([
          {
            id: 101,
            body: "system noise",
            system: true,
            author: { username: "gitlab" },
          },
          {
            id: 102,
            body: "last discussion",
            created_at: "2026-07-20T01:00:00Z",
            system: false,
            author: { username: "maintainer" },
          },
        ]);
      }
      throw new Error(`unexpected apiPath: ${opts.apiPath}`);
    });

    const result = resolveGitLabIssueInput({
      projectDir: "/project",
      input: issueUrl,
      getOrigin: () => "https://gitlab.example.com/acme/widgets.git",
      runApi,
    });

    expect(result.source).toBe("gitlab_issue");
    if (result.source !== "gitlab_issue") throw new Error("expected gitlab_issue");
    expect(result.issue.commentCount).toBe(101);
    expect(result.input).toContain("# Issue Source");
    expect(result.input).toContain("Platform: gitlab");
    expect(result.input).toContain("GitLab issue body");
    expect(result.input).toContain("note-100");
    expect(result.input).toContain("last discussion");
    expect(result.input).not.toContain("system noise");
    expect(result.input).toContain("Comments (101)");
    expect(runApi).toHaveBeenCalledTimes(3);
  });

  it("rejects an Issue URL outside the current origin instead of silently using it", () => {
    expect(() => resolveGitLabIssueInput({
      projectDir: "/project",
      input: "https://gitlab.example.com/other/repo/-/issues/7",
      getOrigin: () => "git@gitlab.example.com:acme/widgets.git",
      runApi: vi.fn(),
    })).toThrow(/does not belong to current origin/);
  });

  it("rejects GitLab URL when origin is not GitLab-style", () => {
    expect(() => resolveGitLabIssueInput({
      projectDir: "/project",
      input: issueUrl,
      getOrigin: () => "https://github.com/xforce-io/petri.git",
      runApi: vi.fn(),
    })).toThrow(/requires a GitLab origin/);
  });

  it("includes the source URL when the current origin cannot be read", () => {
    expect(() => resolveGitLabIssueInput({
      projectDir: "/project",
      input: issueUrl,
      getOrigin: () => { throw new Error("fatal: not a git repository"); },
      runApi: vi.fn(),
    })).toThrow(new RegExp(`${issueUrl}.*not a git repository`));
  });

  it("reports GitLab fetch failures with the source URL", () => {
    expect(() => resolveGitLabIssueInput({
      projectDir: "/project",
      input: issueUrl,
      getOrigin: () => "https://gitlab.example.com/acme/widgets.git",
      runApi: () => { throw new Error("curl: (22) The requested URL returned error: 403"); },
    })).toThrow(new RegExp(`${issueUrl}.*403`));
  });
});

describe("resolveIssueInput (unified dispatcher)", () => {
  it("dispatches GitLab URLs and leaves plain text without remote calls", () => {
    const runApi = vi.fn((opts: { host: string; apiPath: string }) => {
      if (opts.apiPath.includes("/notes")) {
        return JSON.stringify([]);
      }
      return JSON.stringify({
        iid: 42,
        title: "T",
        description: "B",
        state: "opened",
        web_url: issueUrl,
        labels: [],
      });
    });
    const runGh = vi.fn();

    const text = resolveIssueInput({
      projectDir: "/p",
      input: "plain goal",
      getOrigin: vi.fn(),
      runApi,
      runGh,
    });
    expect(text).toEqual({ input: "plain goal", source: "text" });
    expect(runApi).not.toHaveBeenCalled();
    expect(runGh).not.toHaveBeenCalled();

    const gl = resolveIssueInput({
      projectDir: "/p",
      input: issueUrl,
      getOrigin: () => "https://gitlab.example.com/acme/widgets.git",
      runApi,
      runGh,
    });
    expect(gl.source).toBe("gitlab_issue");
    expect(runGh).not.toHaveBeenCalled();
  });

  it("still expands GitHub Issue URLs via the github adapter", () => {
    const runGh = vi.fn((args: string[]) => {
      const endpoint = args.at(-1) ?? "";
      if (endpoint === "repos/xforce-io/petri/issues/49") {
        return JSON.stringify({
          number: 49,
          title: "Load Issue URL",
          body: "Issue body",
          state: "open",
          html_url: "https://github.com/xforce-io/petri/issues/49",
          labels: [],
        });
      }
      if (endpoint.includes("comments")) {
        return JSON.stringify([]);
      }
      throw new Error(`unexpected: ${endpoint}`);
    });

    const result = resolveIssueInput({
      projectDir: "/p",
      input: "https://github.com/xforce-io/petri/issues/49",
      getOrigin: () => "https://github.com/xforce-io/petri.git",
      runGh,
      runApi: vi.fn(),
    });

    expect(result.source).toBe("github_issue");
    expect(result.input).toContain("Platform: github");
    expect(result.input).toContain("Issue body");
  });
});
