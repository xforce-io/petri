import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("new project when projects exist (issue #26)", () => {
  it("S1: header New Project entry exists outside onboarding-only path", () => {
    const html = fs.readFileSync(path.join(process.cwd(), "src/web/public/index.html"), "utf-8");
    const app = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    expect(html).toMatch(/header-new-project-btn/);
    expect(html).toMatch(/global-new-project-panel/);
    expect(app).toMatch(/openGlobalNewProjectPanel/);
    expect(app).toMatch(/createProjectFromGlobalPanel/);
  });
});
