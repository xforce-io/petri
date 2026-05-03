import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { listFilesRecursive } from "../util/fs.js";

export type ConcernTag = "persona" | "coverage" | "gate" | "lang";

export interface Concern {
  tag: ConcernTag;
  message: string;
}

export interface LintInput {
  generatedDir: string;
  description: string;
}

const PERSONA_MIN_CHARS = 50;
const GENERIC_PHRASES = [
  "helpful assistant",
  "i will help",
  "i am an ai",
  "as an ai",
];
const STOPWORDS = new Set([
  "the","and","for","with","that","this","into","from","your","you","are",
  "build","make","create","using","use","want","need","would","like","just",
  "pipeline","stage","stages","role","roles",
]);
const COVERAGE_THRESHOLD = 0.3;
const CHINESE_CHAR = /[一-鿿]/g;

function readSafe(p: string): string | null {
  try { return fs.readFileSync(p, "utf-8"); } catch { return null; }
}

function listRoles(generatedDir: string): string[] {
  const rolesDir = path.join(generatedDir, "roles");
  if (!fs.existsSync(rolesDir)) return [];
  return fs.readdirSync(rolesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function gatherTextContent(generatedDir: string): string {
  if (!fs.existsSync(generatedDir)) return "";
  const files = listFilesRecursive(generatedDir);
  const parts: string[] = [];
  for (const rel of files) {
    if (rel.endsWith(".md") || rel.endsWith(".yaml")) {
      const content = readSafe(path.join(generatedDir, rel));
      if (content) parts.push(content);
    }
  }
  return parts.join("\n");
}

function tokenize(text: string): string[] {
  // Split on whitespace and common punctuation. Keep tokens of length >= 3.
  // Lowercase. Drop pure-numeric and stopwords.
  return text
    .toLowerCase()
    .split(/[\s,.;:!?\-_()\[\]{}"'`<>|/\\]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3)
    .filter((t) => !/^\d+$/.test(t))
    .filter((t) => !STOPWORDS.has(t));
}

function chineseRatio(s: string): number {
  const nonWs = s.replace(/\s+/g, "");
  if (nonWs.length === 0) return 0;
  const matches = s.match(CHINESE_CHAR);
  return (matches?.length ?? 0) / nonWs.length;
}

function lintPersonas(generatedDir: string, roles: string[]): Concern[] {
  const out: Concern[] = [];
  for (const role of roles) {
    const soul = readSafe(path.join(generatedDir, "roles", role, "soul.md"));
    if (soul === null) continue;
    const trimmed = soul.trim();
    if (trimmed.length < PERSONA_MIN_CHARS) {
      out.push({
        tag: "persona",
        message: `${role}/soul.md is ${trimmed.length} chars (likely placeholder)`,
      });
      continue;
    }
    const lower = trimmed.toLowerCase();
    const hit = GENERIC_PHRASES.find((p) => lower.includes(p));
    if (hit) {
      out.push({
        tag: "persona",
        message: `${role}/soul.md contains generic phrase "${hit}"`,
      });
    }
  }
  return out;
}

function lintCoverage(generatedDir: string, description: string): Concern[] {
  // tokenize() splits on ASCII punctuation/whitespace and keeps tokens of length >= 3,
  // so CJK descriptions yield almost no tokens and produce a meaningless ratio.
  // Skip the check when the description is predominantly Chinese.
  if (chineseRatio(description) > 0.4) return [];
  const tokens = Array.from(new Set(tokenize(description)));
  if (tokens.length === 0) return [];
  const corpus = gatherTextContent(generatedDir).toLowerCase();
  if (corpus.length === 0) return [];
  const missed: string[] = [];
  let hits = 0;
  for (const t of tokens) {
    if (corpus.includes(t)) hits += 1;
    else missed.push(t);
  }
  const ratio = hits / tokens.length;
  if (ratio >= COVERAGE_THRESHOLD) return [];
  const sample = missed.slice(0, 5).join(", ");
  return [{
    tag: "coverage",
    message:
      `only ${Math.round(ratio * 100)}% of description terms appear in generated content ` +
      `(missing: ${sample}${missed.length > 5 ? ", ..." : ""})`,
  }];
}

function lintGates(generatedDir: string, roles: string[]): Concern[] {
  // Structural problems (missing evidence.path, malformed check) are now validation
  // errors enforced by loadRole, so generation retries to fix them. This lint only
  // flags the soft case: gate present but no value check — passes whenever the
  // artifact file exists, which is rarely what the user wanted.
  const out: Concern[] = [];
  for (const role of roles) {
    const gatePath = path.join(generatedDir, "roles", role, "gate.yaml");
    const raw = readSafe(gatePath);
    if (raw === null) continue;
    let parsed: any;
    try { parsed = parseYaml(raw); } catch { continue; }
    if (parsed?.evidence?.path && !parsed.evidence.check) {
      out.push({
        tag: "gate",
        message: `${role}/gate.yaml has no evidence.check (passes whenever the file exists)`,
      });
    }
  }
  return out;
}

function lintLanguage(generatedDir: string, description: string): Concern[] {
  const descCn = chineseRatio(description);
  const corpus = gatherTextContent(generatedDir);
  if (corpus.length === 0) return [];
  const corpusCn = chineseRatio(corpus);

  if (descCn > 0.5 && corpusCn < 0.2) {
    return [{
      tag: "lang",
      message: "description is mostly Chinese but generated content is mostly English",
    }];
  }
  if (descCn < 0.05 && corpusCn > 0.5) {
    return [{
      tag: "lang",
      message: "description is in English but generated content is mostly Chinese",
    }];
  }
  return [];
}

export function lintPipeline(input: LintInput): Concern[] {
  if (!fs.existsSync(path.join(input.generatedDir, "pipeline.yaml"))) {
    return [];
  }
  const roles = listRoles(input.generatedDir);
  return [
    ...lintPersonas(input.generatedDir, roles),
    ...lintCoverage(input.generatedDir, input.description),
    ...lintGates(input.generatedDir, roles),
    ...lintLanguage(input.generatedDir, input.description),
  ];
}
