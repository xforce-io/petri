import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("web a11y native semantics (issue #22)", () => {
  it("S1: interactive controls use button or keyboard role", () => {
    const appJs = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    const css = fs.readFileSync(path.join(process.cwd(), "src/web/public/style.css"), "utf-8");
    const html = fs.readFileSync(path.join(process.cwd(), "src/web/public/index.html"), "utf-8");
    expect(appJs).toMatch(/home-start-run-btn|type="button"[\s\S]*Start a Run/);
    expect(appJs).toMatch(/button type="button" class="stage-item|type="button" class="stage-item/);
    expect(appJs).toMatch(/tabIndex\s*=\s*0|tabindex/);
    expect(appJs).toMatch(/Enter/);
    expect(css).toMatch(/focus-visible/);
    // tabs already buttons
    expect(html).toMatch(/class="tab"[\s\S]*data-tab|button class="tab"/);
  });
});
