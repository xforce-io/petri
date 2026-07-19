# Safe YAML multi-line `command` (issue #57)

Command stages run the prepared string as **one shell script** (`sh -c`).
Before exec, the engine **normalizes** multi-line YAML exports.

## What normalization does

| Shape | Result |
|-------|--------|
| Single line | Unchanged |
| Multi-line **without** shell keywords (`if`/`for`/…) | Non-empty lines joined with spaces (argv fold fix) |
| Multi-line **with** control structure | Newlines kept; only **more-indented** argv continuations join onto the previous non-opener line; same-indent body statements stay separate |

## Recommended YAML

### Long argv (fold is fine)

```yaml
- name: unit_test
  command: >
    npx jest path/a.ts
      path/b.ts --runInBand
```

More-indented continuations are joined into one command line.

### Multi-statement scripts

Prefer `&&` / `;` on one logical script, or real control structure:

```yaml
command: >
  test_dir="...";
  if [ -f "$test_dir/package.json" ]; then
    (cd "$test_dir" && npm test);
  else
    exit 1;
  fi
```

### Avoid

Relying on “one shell command per line” **without** keywords when using `|` or blank-line segments — those lines will be space-joined:

```yaml
# BAD if you intended two separate commands:
command: |
  npm test
  printf ok
# becomes: npm test printf ok
```

Use:

```yaml
command: |
  npm test && printf ok
```

## Failure diagnostics

| Prefix | Meaning |
|--------|---------|
| `Command config failed:` | Empty after normalize / substitution |
| `Command exec failed:` | Shell non-zero / timeout / spawn error — reason includes **full prepared command** |
| `Command gate failed:` | Exit 0 but stage gate evidence check failed |
