# Stable CLI Contract

The `zhivex-ai` executable ships with `@zhivex-ai/sdk` and is a Stable local-development and inspection interface for Bun and supported Node.js releases. It operates on application-owned modules and local SDK state; it does not add a hosted control plane, authentication layer, workspace service, or Gateway client.

## Commands

```text
zhivex-ai version
zhivex-ai init agent
zhivex-ai doctor
zhivex-ai agents ledger|inspect|diff|golden|eval
zhivex-ai eval run|compare
zhivex-ai sessions list|show|workflow-state|prune
zhivex-ai artifacts list|show|verify|inspect|cleanup|prune
zhivex-ai workflow replay|report|compare|baseline|gate|run|eval
zhivex-ai workflow-states list|show|prune
```

Use `zhivex-ai --help` for the current summary. `zhivex-ai --version` and `zhivex-ai version` print schema-versioned package metadata as JSON.

## Compatibility Contract

- Commands use long flags in either `--name value` or `--name=value` form.
- Unknown flags, duplicate flags, unexpected positionals, and values supplied to boolean flags fail closed.
- Successful data commands write one pretty-printed JSON value to stdout and return exit code `0`.
- `--help` is the only non-JSON success output. Errors are written as a single message to stderr without a stack trace and return exit code `1`.
- A workflow evaluation gate that rejects its candidate also returns exit code `1`, while still writing the versioned gate report to stdout.
- `eval run` returns exit code `1` when a candidate run, scorer, or configured threshold fails, while still writing its versioned report.
- JSON objects use the corresponding SDK record schemas. Additive fields may appear in compatible releases; removing fields or changing their meaning requires the same compatibility treatment as the underlying Stable SDK type.
- File outputs are written with private permissions where POSIX permissions are available and refuse symbolic-link destinations.

## Execution and Safety

Inspection, replay, reporting, comparison, baseline, and gate commands do not execute models or tools. `workflow run`, `workflow eval`, and `eval run` import an explicit application-owned local module; the application remains responsible for runners, models, tools, credentials, authorization, and side effects. `eval compare` only reads existing reports.

Comparative model evaluation commands use:

```bash
zhivex-ai eval run --module ./model-eval.mjs [--export suite] [--out report.json]
zhivex-ai eval compare --base baseline.json --target report.json [--out comparison.json]
```

See [Comparative Model Evaluations](./MODEL_EVALUATIONS.md) for suite and scorer contracts.

Session, artifact, and workflow-state pruning commands are dry-run by default and require `--execute` to delete records. Artifact cleanup deletes orphan blobs only when invoked without `--dry-run`.

The release package smoke installs the generated npm tarballs in an isolated consumer, executes the installed `zhivex-ai` bin, checks its version against package metadata, exercises help output, and imports the public SDK entrypoints with Node.js.
