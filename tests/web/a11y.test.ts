import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  stageItemButtonHtml,
  fileItemButtonHtml,
  templateCardButtonHtml,
  isWellFormedInteractiveHtml,
} from "../../src/web/a11y-markup.js";

describe("web a11y native semantics (issue #22)", () => {
  it("S1: stage-item markup is a balanced button (not div-closed)", () => {
    const html = stageItemButtonHtml({
      index: 0,
      active: true,
      stage: "design",
      role: "designer",
      attempt: 1,
      gatePassed: false,
      gateReason: "nope",
      durationLabel: "1.0s",
    });
    expect(html.startsWith("<button type=\"button\"")).toBe(true);
    expect(html.endsWith("</button>")).toBe(true);
    expect(html).not.toMatch(/<\/div>\s*$/);
    expect(isWellFormedInteractiveHtml(html)).toBe(true);
    expect((html.match(/<button\b/g) || []).length).toBe(
      (html.match(/<\/button>/g) || []).length,
    );
  });

  it("S1: template-card does not stuff class into tabindex", () => {
    const blank = templateCardButtonHtml({
      id: "",
      name: "Blank",
      description: "x",
      selected: true,
      blank: true,
    });
    const card = templateCardButtonHtml({
      id: "code-dev",
      name: "Code",
      description: "y",
      selected: false,
      meta: "3 stages",
    });
    expect(blank).toMatch(/class="template-card blank-card selected"/);
    expect(blank).not.toMatch(/tabindex="0 blank/);
    expect(card).toMatch(/data-template-id="code-dev"/);
    expect(isWellFormedInteractiveHtml(blank + card)).toBe(true);
  });

  it("S1: config file-item is a button control", () => {
    const html = fileItemButtonHtml("pipeline.yaml", "pipeline.yaml", true);
    expect(html).toMatch(/^<button type="button" class="file-item active"/);
    expect(html).toMatch(/<\/button>$/);
    expect(isWellFormedInteractiveHtml(html)).toBe(true);
  });

  it("S1: shipped app.js stage/template/file markup is well-formed", () => {
    const appJs = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    // No broken tabindex stuffing
    expect(appJs).not.toMatch(/tabindex="0 blank-card/);
    expect(appJs).not.toMatch(/tabindex="0 selected"/);
    expect(appJs).not.toMatch(/tabindex="0\$\{/);
    // stage-item opens as button and closes as button in both branches
    const stageBlocks = appJs.match(
      /<button type="button" class="stage-item[\s\S]*?<\/button>/g,
    );
    expect(stageBlocks).not.toBeNull();
    expect(stageBlocks!.length).toBeGreaterThanOrEqual(2);
    for (const b of stageBlocks!) {
      expect(isWellFormedInteractiveHtml(b)).toBe(true);
    }
    // Must not have stage-item closed only with </div>
    expect(appJs).not.toMatch(
      /class="stage-item[^"]*"[^>]*>[\s\S]{0,400}<\/div>\s*<\/div>`;/,
    );
    // file-item rendered as button
    expect(appJs).toMatch(/button type="button" class="file-item|type="button" class="file-item/);
    expect(appJs).toMatch(/button type="button" class="template-card/);
    // home start run
    expect(appJs).toMatch(/id="home-start-run-btn"/);
    // keyboard on run rows
    expect(appJs).toMatch(/tabIndex\s*=\s*0/);
    expect(appJs).toMatch(/key === "Enter"/);
  });

  it("S1: prompt toggle, artifact rows, and wizard steps are buttons", () => {
    const html = fs.readFileSync(path.join(process.cwd(), "src/web/public/index.html"), "utf-8");
    const appJs = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    expect(html).toMatch(/<button type="button"[^>]*id="io-prompt-toggle"/);
    expect(html).not.toMatch(/<div class="io-header" id="io-prompt-toggle"/);
    expect(html).toMatch(/<button type="button" class="step-item/);
    expect(appJs).toMatch(/button type="button" class="artifact-item/);
    expect(appJs).not.toMatch(/<div class="artifact-item"/);
  });

  it("S2: trace attempts and roles are native buttons and expose lineage navigation", () => {
    const appJs = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    expect(appJs).toMatch(/button type="button" class="stage-item trace-attempt/);
    expect(appJs).toMatch(/button type="button" class="trace-role/);
    expect(appJs).toMatch(/aria-pressed=/);
    expect(appJs).toMatch(/renderRunLineage/);
  });
});
