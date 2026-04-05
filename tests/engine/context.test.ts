import { describe, it, expect } from "vitest";
import { buildContext, ContextInput } from "../../src/engine/context.js";
import { AttemptRecord } from "../../src/types.js";

describe("buildContext", () => {
  it("builds basic context with input and manifest", () => {
    const ctx: ContextInput = {
      input: "Create a login page",
      artifactDir: "/tmp/artifacts",
      manifestText: "- index.html\n- style.css",
      failureContext: "",
      attemptHistory: [],
    };

    const result = buildContext(ctx);

    expect(result).toContain("/tmp/artifacts");
    expect(result).toContain("Create a login page");
    expect(result).toContain("index.html");
    expect(result).toContain("style.css");
    // Should mention writing artifacts to the directory
    expect(result).toMatch(/write.*artifact/i);
    // No failure/retry content when there are no attempts
    expect(result).not.toContain("DO NOT repeat");
  });

  it("includes failure context on retry", () => {
    const ctx: ContextInput = {
      input: "Create a login page",
      artifactDir: "/tmp/artifacts",
      manifestText: "",
      failureContext: "TypeError: Cannot read property 'foo' of undefined",
      attemptHistory: [
        {
          attempt: 1,
          failureReason: "TypeError: Cannot read property 'foo' of undefined",
          failureHash: "abc123",
        },
      ],
    };

    const result = buildContext(ctx);

    expect(result).toContain("TypeError: Cannot read property 'foo' of undefined");
    expect(result).toContain("DO NOT repeat");
    expect(result).toContain("Attempt 1");
  });

  it("formats multiple attempts", () => {
    const attempts: AttemptRecord[] = [
      { attempt: 1, failureReason: "Syntax error on line 5", failureHash: "aaa" },
      { attempt: 2, failureReason: "Missing import for React", failureHash: "bbb" },
    ];

    const ctx: ContextInput = {
      input: "Build a component",
      artifactDir: "/workspace/out",
      manifestText: "- App.tsx",
      failureContext: "Missing import for React",
      attemptHistory: attempts,
    };

    const result = buildContext(ctx);

    expect(result).toContain("Attempt 1");
    expect(result).toContain("Syntax error on line 5");
    expect(result).toContain("Attempt 2");
    expect(result).toContain("Missing import for React");
    expect(result).toContain("DO NOT repeat failed approaches");
    expect(result).toContain("/workspace/out");
    expect(result).toContain("App.tsx");
  });

  it("omits manifest section when manifestText is empty", () => {
    const ctx: ContextInput = {
      input: "Hello",
      artifactDir: "/tmp/art",
      manifestText: "",
      failureContext: "",
      attemptHistory: [],
    };

    const result = buildContext(ctx);

    expect(result).toContain("Hello");
    expect(result).not.toMatch(/available artifacts/i);
  });
});
