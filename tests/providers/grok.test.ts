import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGrokArgs, GrokProvider, planGrokCli } from "../../src/providers/grok.js";

describe("buildGrokArgs / planGrokCli", () => {
  it("builds headless prompt-file args with always-approve and plain output", () => {
    const args = buildGrokArgs({
      promptFile: "/tmp/p.md",
      artifactDir: "/tmp/art",
      model: "grok-3",
    });
    expect(args).toEqual([
      "--prompt-file",
      "/tmp/p.md",
      "--always-approve",
      "--output-format",
      "plain",
      "--cwd",
      "/tmp/art",
      "-m",
      "grok-3",
    ]);
  });

  it("omits -m when model is default", () => {
    const args = buildGrokArgs({
      promptFile: "/tmp/p.md",
      artifactDir: "/tmp/art",
      model: "default",
    });
    expect(args).not.toContain("-m");
  });

  it("plans a command that invokes the binary and redirects stdout", () => {
    const plan = planGrokCli(
      { artifactDir: "/work/artifacts", model: "default" },
      "/bin/echo",
    );
    expect(plan.binary).toBe("/bin/echo");
    expect(plan.promptFile).toBe("/work/artifacts/_prompt.md");
    expect(plan.stdoutFile).toBe("/work/artifacts/_grok_stdout.txt");
    expect(plan.command).toContain("/bin/echo");
    expect(plan.command).toContain("--prompt-file");
    expect(plan.command).toContain("_grok_stdout.txt");
  });
});

describe("GrokProvider.run (fake CLI binary)", () => {
  let artifactDir: string;
  let fakeBin: string;

  beforeEach(() => {
    artifactDir = mkdtempSync(join(tmpdir(), "petri-grok-"));
    mkdirSync(artifactDir, { recursive: true });
    // Fake grok: write a marker, dump argv, copy "assistant" text to stdout path is handled by shell redirect.
    // The provider redirects stdout to _grok_stdout.txt; our fake just prints RESULT and exits 0.
    fakeBin = join(artifactDir, "fake-grok.sh");
    writeFileSync(
      fakeBin,
      `#!/bin/bash
# Record argv for assertions
printf '%s\\n' "$@" > "${artifactDir}/_fake_argv.txt"
# Also write a role artifact the scan should pick up
echo "artifact-from-agent" > "${artifactDir}/notes.txt"
echo "FAKE_GROK_RESULT"
exit 0
`,
      "utf-8",
    );
    chmodSync(fakeBin, 0o755);
  });

  afterEach(() => {
    // temp dirs cleaned by OS; no shared state
  });

  it("writes prompt, invokes CLI plan, and returns scanned artifacts", async () => {
    const provider = new GrokProvider({ binary: fakeBin, defaultModel: "default" });
    const agent = provider.createAgent({
      persona: "You are a tester.",
      playbooks: ["Do the thing."],
      context: "Task: write notes.",
      artifactDir,
      model: "default",
      timeout: 10_000,
    });

    const result = await agent.run();

    // Prompt assembled and written
    const prompt = readFileSync(join(artifactDir, "_prompt.md"), "utf-8");
    expect(prompt).toContain("You are a tester.");
    expect(prompt).toContain("Do the thing.");
    expect(prompt).toContain("Task: write notes.");

    // Fake CLI saw prompt-file + always-approve
    const argv = readFileSync(join(artifactDir, "_fake_argv.txt"), "utf-8");
    expect(argv).toContain("--prompt-file");
    expect(argv).toContain("--always-approve");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("plain");

    // Result + run metadata
    expect(readFileSync(join(artifactDir, "_result.md"), "utf-8")).toContain("FAKE_GROK_RESULT");
    const runMeta = JSON.parse(readFileSync(join(artifactDir, "_agent_run.json"), "utf-8"));
    expect(runMeta.provider).toBe("grok");
    expect(runMeta.exit_code).toBe(0);
    expect(runMeta.timed_out).toBe(false);

    // Artifacts include role output
    expect(result.artifacts.some((p) => p.endsWith("notes.txt"))).toBe(true);
    expect(result.artifacts.some((p) => p.endsWith("_agent_run.json"))).toBe(true);
  });

  it("throws and records _error.txt on timeout without hanging", async () => {
    const slowBin = join(artifactDir, "slow-grok.sh");
    writeFileSync(slowBin, "#!/bin/bash\nsleep 30\n", "utf-8");
    chmodSync(slowBin, 0o755);

    const provider = new GrokProvider({ binary: slowBin });
    const agent = provider.createAgent({
      persona: "p",
      playbooks: [],
      context: "c",
      artifactDir,
      model: "default",
      timeout: 200,
    });

    await expect(agent.run()).rejects.toThrow(/TIMEOUT/);
    expect(existsSync(join(artifactDir, "_error.txt"))).toBe(true);
    expect(readFileSync(join(artifactDir, "_error.txt"), "utf-8")).toMatch(/TIMEOUT/);
    const runMeta = JSON.parse(readFileSync(join(artifactDir, "_agent_run.json"), "utf-8"));
    expect(runMeta.timed_out).toBe(true);
  }, 15_000);

  it("aborts via AbortSignal and records timeout path", async () => {
    const slowBin = join(artifactDir, "slow2-grok.sh");
    writeFileSync(slowBin, "#!/bin/bash\nsleep 30\n", "utf-8");
    chmodSync(slowBin, 0o755);

    const provider = new GrokProvider({ binary: slowBin });
    const agent = provider.createAgent({
      persona: "p",
      playbooks: [],
      context: "c",
      artifactDir,
      model: "default",
      timeout: 60_000,
    });
    const ac = new AbortController();
    const runPromise = agent.run(ac.signal);
    setTimeout(() => ac.abort(), 100);
    await expect(runPromise).rejects.toThrow(/TIMEOUT/);
  }, 15_000);
});
