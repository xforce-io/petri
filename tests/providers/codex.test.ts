import { describe, it, expect, beforeEach } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildCodexArgs, CodexProvider, planCodexCli } from "../../src/providers/codex.js";

describe("buildCodexArgs / planCodexCli", () => {
  it("builds non-interactive exec args with last-message output and sandbox bypass", () => {
    const args = buildCodexArgs({
      artifactDir: "/tmp/art",
      lastMessageFile: "/tmp/art/last.txt",
      model: "gpt-5",
    });
    expect(args[0]).toBe("exec");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("-C");
    expect(args).toContain("/tmp/art");
    expect(args).toContain("-o");
    expect(args).toContain("/tmp/art/last.txt");
    expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).toContain("-m");
    expect(args).toContain("gpt-5");
    expect(args[args.length - 1]).toBe("-"); // stdin prompt
  });

  it("uses workspace as the Codex execution directory while keeping output in artifacts", () => {
    const args = buildCodexArgs({
      artifactDir: "/tmp/art",
      workspaceDir: "/repo/worktree",
      lastMessageFile: "/tmp/art/last.txt",
      model: "default",
    });
    expect(args[args.indexOf("-C") + 1]).toBe("/repo/worktree");
  });

  it("omits -m when model is default", () => {
    const args = buildCodexArgs({
      artifactDir: "/tmp/art",
      lastMessageFile: "/tmp/last.txt",
      model: "default",
    });
    expect(args).not.toContain("-m");
  });

  it("maps model alias to CLI id and pins reasoning effort high", () => {
    const args = buildCodexArgs({
      artifactDir: "/tmp/art",
      lastMessageFile: "/tmp/art/last.txt",
      model: "terra",
      modelMappings: { terra: "gpt-5.6-terra", default: "default" },
      reasoningEffort: "high",
    });
    expect(args).toContain("-m");
    expect(args).toContain("gpt-5.6-terra");
    expect(args).not.toContain("terra");
    const cIdx = args.indexOf("-c");
    expect(cIdx).toBeGreaterThanOrEqual(0);
    expect(args[cIdx + 1]).toBe("model_reasoning_effort=high");
    expect(args.join(" ")).toContain("model_reasoning_effort=high");
  });

  it("plans a command that cats the prompt into codex exec", () => {
    const plan = planCodexCli(
      { artifactDir: "/work/artifacts", model: "default" },
      "/usr/bin/true",
    );
    expect(plan.binary).toBe("/usr/bin/true");
    expect(plan.promptFile).toBe("/work/artifacts/_prompt.md");
    expect(plan.lastMessageFile).toBe("/work/artifacts/_codex_last_message.txt");
    expect(plan.command).toContain("cat ");
    expect(plan.command).toContain("_prompt.md");
    expect(plan.command).toContain("exec");
    expect(plan.command).toContain("_codex_stdout.txt");
  });

  it("plans terra high command with mapped model and effort override", () => {
    const plan = planCodexCli(
      {
        artifactDir: "/work/artifacts",
        model: "terra",
        modelMappings: { terra: "gpt-5.6-terra" },
        reasoningEffort: "high",
      },
      "/usr/bin/true",
    );
    expect(plan.args).toContain("gpt-5.6-terra");
    expect(plan.args).toContain("model_reasoning_effort=high");
    expect(plan.command).toContain("gpt-5.6-terra");
    expect(plan.command).toContain("model_reasoning_effort=high");
  });
});

describe("CodexProvider.run (fake CLI binary)", () => {
  let artifactDir: string;
  let fakeBin: string;

  beforeEach(() => {
    artifactDir = mkdtempSync(join(tmpdir(), "petri-codex-"));
    mkdirSync(artifactDir, { recursive: true });
    fakeBin = join(artifactDir, "fake-codex.sh");
    // Fake codex: parse -o <file>, write last message there, write role artifact, exit 0.
    // stdin is the prompt (ignored beyond presence).
    writeFileSync(
      fakeBin,
      `#!/bin/bash
printf '%s\\n' "$@" > "${artifactDir}/_fake_argv.txt"
# consume stdin
cat > /dev/null
last=""
while [ \$# -gt 0 ]; do
  if [ "\$1" = "-o" ]; then
    last="\$2"
    shift 2
    continue
  fi
  shift
done
if [ -n "\$last" ]; then
  echo "FAKE_CODEX_RESULT" > "\$last"
fi
echo "artifact-from-codex" > "${artifactDir}/notes.txt"
echo "stdout-noise"
exit 0
`,
      "utf-8",
    );
    chmodSync(fakeBin, 0o755);
  });

  it("writes prompt, invokes CLI, and returns scanned artifacts from last message", async () => {
    const provider = new CodexProvider({ binary: fakeBin, defaultModel: "default" });
    const agent = provider.createAgent({
      persona: "You are a codex tester.",
      playbooks: ["Ship it."],
      context: "Task: produce notes.",
      artifactDir,
      model: "default",
      timeout: 10_000,
    });

    const result = await agent.run();

    const prompt = readFileSync(join(artifactDir, "_prompt.md"), "utf-8");
    expect(prompt).toContain("You are a codex tester.");
    expect(prompt).toContain("Ship it.");
    expect(prompt).toContain("Task: produce notes.");

    const argv = readFileSync(join(artifactDir, "_fake_argv.txt"), "utf-8");
    expect(argv).toMatch(/^exec$/m);
    expect(argv).toContain("--skip-git-repo-check");
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv).toContain("-o");

    expect(readFileSync(join(artifactDir, "_result.md"), "utf-8")).toContain("FAKE_CODEX_RESULT");
    const runMeta = JSON.parse(readFileSync(join(artifactDir, "_agent_run.json"), "utf-8"));
    expect(runMeta.provider).toBe("codex");
    expect(runMeta.exit_code).toBe(0);
    expect(runMeta.timed_out).toBe(false);

    expect(result.artifacts.some((p) => p.endsWith("notes.txt"))).toBe(true);
  });

  it("throws and records _error.txt on timeout without hanging", async () => {
    const slowBin = join(artifactDir, "slow-codex.sh");
    writeFileSync(slowBin, "#!/bin/bash\nsleep 30\n", "utf-8");
    chmodSync(slowBin, 0o755);

    const provider = new CodexProvider({ binary: slowBin });
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
    const runMeta = JSON.parse(readFileSync(join(artifactDir, "_agent_run.json"), "utf-8"));
    expect(runMeta.timed_out).toBe(true);
  }, 15_000);
});
