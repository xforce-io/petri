import { describe, it, expect, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  createProviderRegistry,
  resolveRoleProviderName,
  validateRoleProviderConfig,
} from "../../src/util/provider.js";
import { CodexProvider } from "../../src/providers/codex.js";
import type { PetriConfig } from "../../src/types.js";

const templateRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../src/templates/code-dev",
);

function loadCodeDevPetri(): PetriConfig {
  const raw = fs.readFileSync(path.join(templateRoot, "petri.yaml"), "utf-8");
  return YAML.parse(raw) as PetriConfig;
}

function loadCodeReviewerRole(): { provider?: string; model?: string } {
  const raw = fs.readFileSync(
    path.join(templateRoot, "roles/code_reviewer/role.yaml"),
    "utf-8",
  );
  return YAML.parse(raw) as { provider?: string; model?: string };
}

describe("code-dev code_reviewer terra high", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("binds code_reviewer to codex review provider and terra model alias", () => {
    const petri = loadCodeDevPetri();
    const role = loadCodeReviewerRole();

    expect(petri.providers.default?.type).toBe("grok");
    expect(petri.providers.review?.type).toBe("codex");
    expect(petri.providers.review?.reasoning_effort).toBe("high");
    expect(petri.models.terra?.provider).toBe("review");
    expect(petri.models.terra?.model).toBe("gpt-5.6-terra");
    expect(role.provider).toBe("review");
    expect(role.model).toBe("terra");

    const roles = [
      { name: "code_reviewer", provider: role.provider, model: role.model ?? petri.defaults.model },
      { name: "developer", model: petri.defaults.model },
    ];
    expect(() => validateRoleProviderConfig(roles, petri)).not.toThrow();
    expect(resolveRoleProviderName(roles[0], petri)).toBe("review");
    expect(resolveRoleProviderName(roles[1], petri)).toBe("default");
  });

  it("registry review provider runs codex with gpt-5.6-terra and high effort on argv", async () => {
    const petri = loadCodeDevPetri();
    const { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const artifactDir = mkdtempSync(join(tmpdir(), "petri-terra-high-"));
    try {
      mkdirSync(artifactDir, { recursive: true });
      const fakeBin = join(artifactDir, "fake-codex.sh");
      writeFileSync(
        fakeBin,
        `#!/bin/bash
printf '%s\\n' "$@" > "${artifactDir}/_fake_argv.txt"
cat > /dev/null
last=""
while [ \$# -gt 0 ]; do
  if [ "\$1" = "-o" ]; then last="\$2"; shift 2; continue; fi
  shift
done
[ -n "\$last" ] && echo ok > "\$last"
exit 0
`,
        "utf-8",
      );
      chmodSync(fakeBin, 0o755);
      // Real factory path: PETRI_CODEX_BIN is how shipped CodexProvider resolves the binary.
      vi.stubEnv("PETRI_CODEX_BIN", fakeBin);
      const registry = createProviderRegistry(petri);
      expect(registry.providers.review).toBeInstanceOf(CodexProvider);

      await registry.providers.review!.createAgent({
        persona: "reviewer",
        playbooks: [],
        context: "review",
        artifactDir,
        model: "terra",
        timeout: 10_000,
      }).run();

      const argv = readFileSync(join(artifactDir, "_fake_argv.txt"), "utf-8");
      expect(argv).toContain("gpt-5.6-terra");
      expect(argv).toContain("model_reasoning_effort=high");
      const meta = JSON.parse(readFileSync(join(artifactDir, "_agent_run.json"), "utf-8"));
      expect(meta.cli_model).toBe("gpt-5.6-terra");
      expect(meta.reasoning_effort).toBe("high");
      expect(meta.command).toContain("gpt-5.6-terra");
      expect(meta.command).toContain("model_reasoning_effort=high");
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("does not introduce a second code-dev template", () => {
    const templatesDir = path.dirname(templateRoot);
    const names = fs.readdirSync(templatesDir).filter((name) => {
      const full = path.join(templatesDir, name);
      return fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, "pipeline.yaml"));
    });
    expect(names).toEqual(["code-dev"]);
  });
});
