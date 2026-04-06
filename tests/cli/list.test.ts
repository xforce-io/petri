import { describe, it, expect, vi } from "vitest";

describe("petri list templates", () => {
  it("lists available templates", async () => {
    const lines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });

    const { listTemplatesCommand } = await import("../../src/cli/list.js");
    await listTemplatesCommand();

    const output = lines.join("\n");
    expect(output).toContain("code-dev");

    consoleSpy.mockRestore();
  });
});

describe("petri list skills", () => {
  it("lists built-in skills", async () => {
    const lines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });

    const { listSkillsCommand } = await import("../../src/cli/list.js");
    await listSkillsCommand();

    const output = lines.join("\n");
    expect(output).toContain("file_operations");
    expect(output).toContain("shell_tools");

    consoleSpy.mockRestore();
  });
});
