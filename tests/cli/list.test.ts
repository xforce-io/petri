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

describe("petri list playbooks", () => {
  it("lists built-in playbooks", async () => {
    const lines: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((...args) => {
      lines.push(args.join(" "));
    });

    const { listPlaybooksCommand } = await import("../../src/cli/list.js");
    await listPlaybooksCommand();

    const output = lines.join("\n");
    expect(output).toContain("file_operations");
    expect(output).toContain("shell_tools");

    consoleSpy.mockRestore();
  });
});
