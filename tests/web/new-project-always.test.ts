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

  it("S1: create failure keeps panel open and uses global error element", () => {
    const app = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    // Failure path writes global-new-project-error and returns before hide
    expect(app).toMatch(/global-new-project-error/);
    const fn = app.slice(app.indexOf("async function createProjectFromGlobalPanel"));
    const body = fn.slice(0, fn.indexOf("\nasync function ") > 0 ? fn.indexOf("\nasync function ") : 1500);
    expect(body).toMatch(/res\.status !== 201/);
    expect(body).toMatch(/return;/);
    // display none only on success path after 201
    const failIdx = body.indexOf("res.status !== 201");
    const hideIdx = body.indexOf('style.display = "none"');
    expect(hideIdx).toBeGreaterThan(failIdx);
  });
