/**
 * Pure helpers for command-stage script preparation and failure messages.
 * See issue #57 / design: multi-line YAML command normalization.
 */

const STRUCTURE_HEAD =
  /^(if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select)\b/;

/**
 * Previous line ends with a shell block opener — do not join the next body line.
 * Strip trailing comments so `then # note` still counts as an opener.
 */
const BLOCK_OPENER_TAIL = /(then|do|else|elif|\{)\s*$/;

function isStructureLine(trimmedStart: string): boolean {
  const t = trimmedStart.trim();
  if (t === "{" || t === "}") return true;
  return STRUCTURE_HEAD.test(trimmedStart);
}

/** Leading whitespace width (spaces + tabs as one unit each). */
function indentWidth(line: string): number {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].length : 0;
}

/** Strip trailing `# ...` comments for opener detection only. */
function stripTrailingComment(line: string): string {
  // naive: first unquoted `#` starts a comment (good enough for opener check)
  const hash = line.indexOf("#");
  if (hash === -1) return line;
  return line.slice(0, hash).replace(/[ \t]+$/g, "");
}

function isBlockOpenerLine(line: string): boolean {
  return BLOCK_OPENER_TAIL.test(stripTrailingComment(line).trimEnd());
}

/**
 * Normalize a rendered command string so YAML fold / more-indented argv
 * becomes a single shell script, while true multi-line control-flow scripts
 * keep their newlines.
 *
 * Script mode join rule: only more-indented lines (currentIndent > previousIndent)
 * are argv continuations; same-indent body statements keep their newlines.
 */
export function normalizeCommandScript(rendered: string): string {
  // 1–2. EOL normalize
  let text = rendered.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // 3. strip trailing whitespace per line
  let lines = text.split("\n").map((l) => l.replace(/[ \t]+$/g, ""));

  // strip leading / trailing all-blank lines
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();

  // 4. non-empty lines only for joining decisions (blank lines between segments drop)
  const nonEmpty = lines.filter((l) => l.trim() !== "");
  if (nonEmpty.length === 0) return "";

  // 5. structure detection
  const scriptMode = nonEmpty.some((l) => isStructureLine(l.trimStart()));

  if (!scriptMode) {
    // 7. non-script: join all non-empty lines with a single space
    return nonEmpty.map((l) => l.trim()).join(" ").trimEnd();
  }

  // 6. script mode: keep newlines; join only *more-indented* argv continuations
  //    onto previous line when previous is not a block opener and current is not
  //    a structure keyword. Same-indent body lines are separate statements.
  const out: string[] = [];
  for (const line of nonEmpty) {
    const trimmedStart = line.trimStart();
    const trimmed = line.trim();

    if (out.length === 0) {
      out.push(line.replace(/[ \t]+$/g, ""));
      continue;
    }

    const prev = out[out.length - 1];
    const currIndent = indentWidth(line);
    const prevIndent = indentWidth(prev);
    // YAML "more-indented" continuation: deeper indent than previous statement
    const isMoreIndented = currIndent > prevIndent;

    const shouldJoin =
      isMoreIndented &&
      !isBlockOpenerLine(prev) &&
      !isStructureLine(trimmedStart);

    if (shouldJoin) {
      out[out.length - 1] = `${prev.replace(/[ \t]+$/g, "")} ${trimmed}`;
    } else {
      // preserve original indentation for body lines under then/do/else
      out.push(line.replace(/[ \t]+$/g, ""));
    }
  }

  return out.join("\n").trimEnd();
}

export function formatCommandExecFailure(message: string, prepared: string): string {
  return `Command exec failed: ${message}\n--- prepared command ---\n${prepared}\n--- end command ---`;
}

export function formatCommandConfigFailure(detail: string): string {
  return `Command config failed: ${detail}`;
}

export function formatCommandGateFailure(gateReason: string): string {
  return `Command gate failed: ${gateReason}`;
}
