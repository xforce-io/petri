import { describe, it, expect } from "vitest";
import {
  normalizeCommandScript,
  formatCommandExecFailure,
  formatCommandConfigFailure,
  formatCommandGateFailure,
} from "../../src/engine/command-script.js";

describe("normalizeCommandScript", () => {
  // U1
  it("leaves a single-line command unchanged (within trim semantics)", () => {
    expect(normalizeCommandScript("echo a")).toBe("echo a");
    expect(normalizeCommandScript("  echo a  ")).toBe("echo a");
  });

  // U2
  it("joins non-structure multi-line argv with spaces", () => {
    expect(normalizeCommandScript("echo a\nb")).toBe("echo a b");
  });

  // U3 — issue #57 repro shape: more-indented argv continuation
  it("joins more-indented argv continuation into one line", () => {
    const input = "npx jest a.ts\n  b.ts --runInBand";
    const out = normalizeCommandScript(input);
    expect(out).toBe("npx jest a.ts b.ts --runInBand");
    expect(out).toContain("a.ts b.ts");
    expect(out).not.toContain("\n");
  });

  // U4 — blank-line segmented argv (YAML fold artifact)
  it("joins blank-line-segmented argv into one line (non-script mode)", () => {
    const input = "npx jest a.ts\n\n  b.ts --runInBand";
    expect(normalizeCommandScript(input)).toBe("npx jest a.ts b.ts --runInBand");
  });

  // U5
  it("preserves newlines in if/then/fi scripts and does not join then-body into then line", () => {
    const input = "if true; then\n  echo a\nfi";
    const out = normalizeCommandScript(input);
    expect(out).toContain("\n");
    expect(out).toMatch(/then\n/);
    // body must stay on its own line (not joined onto the then line)
    expect(out).not.toMatch(/then[ \t]+echo a/);
    const lines = out.split("\n");
    expect(lines.some((l) => l.trim() === "echo a" || l.includes("echo a"))).toBe(true);
    expect(lines.some((l) => /^\s*fi\s*$/.test(l) || l.trim() === "fi")).toBe(true);
  });

  // U6 — code-dev style if/elif/else/fi
  it("keeps code-dev style if/elif/else/fi as an executable multi-line script", () => {
    const input = [
      'test_dir="/tmp/x";',
      "if [ -f \"$test_dir/package.json\" ]; then",
      "  (cd \"$test_dir\" && npm test);",
      "elif [ -d \"$test_dir/tests\" ]; then",
      "  (cd \"$test_dir\" && python -m pytest);",
      "else",
      '  echo "no runner" >&2;',
      "  exit 1;",
      "fi",
    ].join("\n");
    const out = normalizeCommandScript(input);
    expect(out).toContain("\n");
    expect(out).toMatch(/\bif\b/);
    expect(out).toMatch(/\belif\b/);
    expect(out).toMatch(/\belse\b/);
    expect(out).toMatch(/\bfi\b/);
    // body under then/elif/else must not be smashed onto the control line incorrectly
    expect(out).toMatch(/then\n/);
    expect(out).toMatch(/else\n/);
  });

  // U7
  it("normalizes CRLF and strips trailing whitespace", () => {
    const input = "echo a  \r\necho b\r";
    const out = normalizeCommandScript(input);
    expect(out).not.toContain("\r");
    expect(out).toBe("echo a echo b");
  });

  it("handles empty / whitespace-only input as empty string", () => {
    expect(normalizeCommandScript("")).toBe("");
    expect(normalizeCommandScript("   \n  \n")).toBe("");
  });

  it("joins more-indented argv inside script mode when previous line is not a block opener", () => {
    // structure present → script mode; indented continuation of a long command
    const input = [
      "if true; then",
      "  npx jest a.ts",
      "    b.ts --runInBand",
      "fi",
    ].join("\n");
    const out = normalizeCommandScript(input);
    expect(out).toContain("a.ts b.ts");
    expect(out).toMatch(/then\n/);
    expect(out).toMatch(/\bfi\b/);
  });

  // multi-statement body: same-indent lines must stay separate (review CRITICAL)
  it("keeps same-indent multi-statement then-body on separate lines", () => {
    const input = "if true; then\n  echo a\n  echo b\nfi";
    const out = normalizeCommandScript(input);
    expect(out).toBe("if true; then\n  echo a\n  echo b\nfi");
    expect(out).not.toMatch(/echo a echo b/);
  });

  it("joins more-indented argv then keeps following same-indent statement separate", () => {
    const input = [
      "if true; then",
      "  npx jest a.ts",
      "    b.ts --runInBand",
      "  echo done",
      "fi",
    ].join("\n");
    const out = normalizeCommandScript(input);
    expect(out).toContain("a.ts b.ts");
    expect(out).toMatch(/--runInBand\n/);
    expect(out).toMatch(/^\s*echo done$/m);
    expect(out).not.toMatch(/b\.ts --runInBand echo done/);
  });

  it("keeps same-indent else-body statements on separate lines (no trailing ;)", () => {
    const input = [
      "if false; then",
      "  echo yes",
      "else",
      "  echo no",
      "  exit 1",
      "fi",
    ].join("\n");
    const out = normalizeCommandScript(input);
    expect(out).toMatch(/else\n/);
    expect(out).toMatch(/echo no\n/);
    expect(out).toMatch(/^\s*exit 1$/m);
    expect(out).not.toMatch(/echo no exit 1/);
  });

  it("treats then # comment as block opener (body not joined onto then)", () => {
    const input = "if true; then # run body\n  echo a\nfi";
    const out = normalizeCommandScript(input);
    expect(out).toMatch(/then # run body\n/);
    expect(out).not.toMatch(/then # run body echo a/);
  });
});

describe("formatCommand*Failure helpers", () => {
  // U8
  it("formatCommandExecFailure includes prefix and full command", () => {
    const prepared = "npx jest a.ts b.ts --runInBand";
    const out = formatCommandExecFailure("Command failed: exit 1", prepared);
    expect(out).toMatch(/Command exec failed/i);
    expect(out).toContain(prepared);
  });

  it("formatCommandConfigFailure includes prefix and empty-command semantics", () => {
    const out = formatCommandConfigFailure("command is empty after normalization");
    expect(out).toMatch(/Command config failed/i);
    expect(out.toLowerCase()).toMatch(/empty/);
  });

  it("formatCommandGateFailure includes gate prefix", () => {
    const out = formatCommandGateFailure("field ok != true");
    expect(out).toMatch(/Command gate failed/i);
    expect(out).toContain("field ok != true");
  });
});
