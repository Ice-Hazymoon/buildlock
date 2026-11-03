# Contributing

Issues and pull requests are welcome. buildlock is one bash file
(`bin/buildlock`) plus its installer, with tests in `test/` run by Bun.

## Checks

```sh
bun test                                  # isolated: fake /proc, temp HOME, own lock and log
shellcheck bin/buildlock install.sh       # CI pins shellcheck 0.11.0
```

On a machine that runs buildlock itself, run the tests through it:
`BUILDLOCK_CLASS=light buildlock bun test`.

Tests never touch your real queue or config: they set `BUILDLOCK_LOCK_PATH`,
`BUILDLOCK_JOB_LOG_DIR`, `BUILDLOCK_PROC_ROOT` (a fake `/proc` for load,
memory and pressure), `BUILDLOCK_CONFIG` and `HOME`.

## Interfaces that must not change

Other tools parse these, and old and new versions share the lock files during
an upgrade:

- `buildlock --status` and `buildlock --explain` output;
- the stderr line `buildlock: waited Ns (...)`, matched as `buildlock: waited (\d+)s`;
- the job-log line format (`~/.cache/buildlock/jobs-YYYY-MM.jsonl`);
- the lock, holder and queue file formats and paths;
- the `BUILDLOCK_*` environment variables.

Add fields at the end of JSON output instead of changing existing ones.

## Releases

1. Add a `## X.Y.Z` section at the top of `CHANGELOG.md`.
2. `scripts/release.sh X.Y.Z` sets the version (in `bin/buildlock` and
   `package.json`), runs the checks, commits and tags.
3. `git push origin HEAD vX.Y.Z`. GitHub Actions tests the tag, publishes the
   release with checksums and provenance and the npm package through npm's
   trusted publishing (no token), then installs both as users do.
