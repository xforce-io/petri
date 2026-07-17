import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("preset vs AI create terminology (issue #25)", () => {
  const html = () =>
    fs.readFileSync(path.join(process.cwd(), "src/web/public/index.html"), "utf-8");

  it("S1: preset entry uses distinct name from AI generator", () => {
    const h = html();
    expect(h).toMatch(/New project from preset/);
    expect(h).toMatch(/id="ai-create-banner"/);
    expect(h).toMatch(/AI Pipeline generator/);
    // Top-level nav uses a distinct name from preset create
    expect(h).toMatch(/>AI Generate</);
    expect(h).not.toMatch(/>Create ⋯</);
    expect(h).not.toMatch(/Preferred path: Home → New from template/);
  });

  it("S1: AI path explains cost and result before execution", () => {
    const h = html();
    // Specific AI cost wording — not the Runs table "Cost" column
    expect(h).toMatch(/may incur API cost/);
    expect(h).toMatch(/id="ai-create-preexec-note"/);
    expect(h).toMatch(/AI generation/);
    expect(h).toMatch(/does not copy a preset project|not a deterministic project copy/);
    expect(h).toMatch(/id="ai-generate-progress"/);
    expect(h).toMatch(/model call in progress/);
  });

  it("S1: AI style hints are not labeled as project presets", () => {
    const h = html();
    expect(h).toMatch(/Optional AI style hints \(not project presets\)/);
  });
});
