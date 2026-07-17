import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

describe("preset vs AI create terminology (issue #25)", () => {
  it("S1: distinct names and cost/result notes for preset vs AI", () => {
    const html = fs.readFileSync(path.join(process.cwd(), "src/web/public/index.html"), "utf-8");
    const app = fs.readFileSync(path.join(process.cwd(), "src/web/public/app.js"), "utf-8");
    expect(html + app).toMatch(/preset/i);
    expect(html).toMatch(/AI|model|cost/i);
    expect(html).not.toMatch(/Preferred path: Home → New from template/);
    // AI path mentions cost or model
    expect(html).toMatch(/cost|model/i);
  });
});
