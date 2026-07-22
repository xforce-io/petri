import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../skills/petri",
);

describe("shipped petri operator skill package", () => {
  it("includes SKILL.md with name and description frontmatter", () => {
    const skillMd = path.join(skillRoot, "SKILL.md");
    expect(fs.existsSync(skillMd)).toBe(true);
    const body = fs.readFileSync(skillMd, "utf-8");
    expect(body).toMatch(/^---\n/);
    expect(body).toMatch(/^name:\s*petri\s*$/m);
    expect(body).toMatch(/^description:/m);
    expect(body).toMatch(/petri run/i);
    expect(body).toMatch(/code-dev/i);
    expect(body).toMatch(/--in-place/);
  });

  it("ships CLI / code-dev / config references and an install script", () => {
    for (const rel of [
      "references/cli.md",
      "references/code-dev.md",
      "references/config.md",
      "install.sh",
    ]) {
      const p = path.join(skillRoot, rel);
      expect(fs.existsSync(p), `missing ${rel}`).toBe(true);
      expect(fs.statSync(p).size).toBeGreaterThan(0);
    }
    const cli = fs.readFileSync(path.join(skillRoot, "references/cli.md"), "utf-8");
    expect(cli).toMatch(/--worktree/);
    expect(cli).toMatch(/--in-place/);
    const install = fs.readFileSync(path.join(skillRoot, "install.sh"), "utf-8");
    expect(install).toMatch(/\.claude\/skills/);
    expect(install).toMatch(/\.grok\/skills/);
  });
});
