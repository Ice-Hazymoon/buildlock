# Changelog

## 0.2.2

- On npm: `npm install -g buildlock` (or pnpm, bun). The package is the same script; releases publish it from GitHub Actions with provenance.
- A copy installed by npm, pnpm, bun or yarn, or run through npx, is left to its package manager: `update` and `uninstall` name its command instead of replacing or deleting a file it manages, `update --check` still checks, and `doctor` says where the copy came from. The installer explains an npm link it finds at its target.

## 0.2.1

- On bash 5.1 (Ubuntu 22.04, Debian 11, RHEL 9), a waiter stopped with Ctrl-Z never woke after `fg` or SIGCONT: bash resumed its paused read without the timeout.
- Light jobs that hold back for a heavy job starved of memory said so poorly ("13.4 GB for this job" for `true`), and `status` and `explain` claimed they would start. The verdicts now count that reserve, and the message names it.

## 0.2.0

A release from a five-part review (first use, transparency, robustness, coding agents, docs and release).

**Behaviour changes**

- A job that starts at once prints nothing; `buildlock: waited Ns (slot 2 of 4)` appears only after a wait, and slots count from 1. Parsers that read `buildlock: waited (\d+)s` should treat a missing line as 0.
- `VITEST_MAX_WORKERS` (and the unused `VITEST_MAX_FORKS`, `VITEST_MAX_THREADS`, `JEST_MAX_WORKERS`) are no longer exported by default: Vitest let the variable override a project's own `fileParallelism: false` and `--maxWorkers`, so serial suites ran in parallel only when wrapped. `config set EXPORT_WORKERS on` brings it back; `BUILDLOCK_WORKERS` is still exported. `WORKERS` now defaults to 8 or the core count, whichever is smaller.
- `agents install --project` writes the repository's `AGENTS.md` (which nearly every agent reads) at the repository's top, plus an existing `CLAUDE.md` or `GEMINI.md`. It no longer creates `CLAUDE.md` (which hid `AGENTS.md` from Claude Code), Copilot, Cursor, Windsurf, Kiro, Qwen or Grok copies, or `.claude/settings.local.json`, and removes the ones 0.1 wrote.
- `buildlock uninstall` cleans global files only; project files keep their section, which now tells agents to run commands directly where buildlock is missing.
- The config file runs apart from buildlock: `exit`, `cd`, `IFS` or `echo` in it can no longer end buildlock (and fake a passing build), move the command or mix into its output.
- Memory defaults scale with RAM on smaller machines: `DEFAULT_MEMORY_MB` RAM / 4 (at most 8192), `RESERVE_MEMORY_MB` RAM / 8 (at most 6144), `CRITICAL_MEMORY_MB` RAM / 10 (at most 3072). On an 8 GB laptop jobs no longer wait forever.
- Quiet mode without its own limits halves the jobs at once (`buildlock quiet on` used to change nothing).

**Fixes**

- Called through a symlink or under another name, every run hung: processes are now identified by pid and start time, which also ends phantom holders and queue heads from reused pids.
- A waiter whose queue file was removed (a cleanup of `~/.cache`, a sandbox in another PID namespace) waited forever; it now puts the file back, and an entry whose waiter holds its lock is never removed.
- `kill -9` of buildlock left the command running outside the queue and the memory sampler looping forever; the sampler is now a watchdog in its own process group that stops the command.
- Ctrl-C, Ctrl-Z, Ctrl-\, window resizes and `/dev/tty` prompts now work in a terminal as without buildlock, and Ctrl-C stops a loop of buildlock steps. Elsewhere a signal reaches the command once (no TERM 30 ms after an INT, no KILL after a second), the command may clean up, and its own exit status is kept. Wrapped programs no longer start with SIGINT and SIGQUIT ignored.
- A Ctrl-Z'd (stopped) waiter no longer blocks its lane, and is never stopped while it holds the scheduler mutex.
- A nested call deadlocked when a wrapper (`env -i`, turbo's strict env mode, sudo) dropped `BUILDLOCK_HELD`; holders among the ancestors now count too.
- A stream of light jobs could starve a heavy job waiting for memory; after a minute, light jobs keep its budget free.
- An unwritable or full lock directory, or a broken stderr, stopped every command; the command now runs (unqueued, with a warning, in the first case).
- With a waiter of the pre-scheduler script queued and one slot, nothing started.
- A clock set back blocked heavy starts; job keys with `"` or `\` never learned; a huge job log cost the lookup hundreds of MB; an invalid `BUILDLOCK_TIMEOUT` or `SAMPLE_SECONDS=0` in the config broke builds or burned CPU.
- `explain --help` and `setup --help` work; `config unset NOPE` is an error; `status --watch -i 0` is refused; bare `buildlock agents` without a terminal shows the status instead of installing; history shows `-` instead of `0 MB` for jobs too short to sample.

**Coding agents**

- Global files follow each agent's current docs: Copilot (`~/.copilot/copilot-instructions.md`), Devin / Windsurf (`~/.config/devin/AGENTS.md`), Codex's and Pi's `AGENTS.override.md`, `GEMINI_CLI_HOME`, Antigravity. New: Amp and Crush, Zed, Junie, Kilo Code, Goose, Cline, Augment, Continue.
- Detection no longer counts directories that hold only `skills/`, and uninstall removes the directories it emptied.
- Claude Code: allow rules for build and test commands, and every deny and ask rule, are mirrored for `buildlock <command>`, so wrapping a command neither adds a prompt nor bypasses a deny rule.
- The instructions say how agent shells should wait for a queued command, what exit 73 means, that `buildlock: waited` is not the command's output, and to run commands directly without buildlock.
- Project commands come from the lockfile or `packageManager`, with uv / poetry, justfile and `./mvnw`, and from the repository's top.

**Other**

- Wait reasons in plain words in `status`, the waiting notice and the new timeout message (`--status` and `--json` keep the raw form). `explain` ends with a sentence; `doctor` shows the limits in effect, warns about critically low memory and lists config lines that fail.
- `--memory` and size settings take units (`512M`, `2G`). New settings `CORES`, `BYPASS`, `EXPORT_WORKERS`. `history --days`, `stats --json`, `completion fish`. Help fits 80 columns. Clearer errors for `FOO=1 cmd`, a quoted command line and a non-executable file (exit 126).
- The installer expands `~` in `--prefix=`, checks the prefix before downloading (with the `sudo` command to use), refuses to replace a symlink or a file that isn't buildlock without `--force`, offers setup on a first install only, and runs nothing if its download is cut short.
- `update --version main` explains that main comes from the installer.
- Per-run overhead down from about 110 ms to 65 ms.
- Releases: actions pinned by commit, shellcheck and Bun pinned, build provenance, a smoke test of the published installer, `scripts/release.sh`, SECURITY.md and CONTRIBUTING.md. The documented installer URL is the release's `install.sh`.

## 0.1.0

First public release. The scheduler has run a busy 32-core machine shared by many coding agents since September 2026; this release packages it with a CLI around it.

- Run any command through a machine-wide queue: `buildlock <command>`. Jobs start in arrival order once a slot is free and load, CPU, IO and memory pressure, free memory and the growth of recently started jobs leave room. Heavy and light jobs have separate lanes.
- Learned budgets: peak memory and run time per repository and command, from the job log. From the third run, the memory reserved for a command is measured, and small, fast commands move to the light lane.
- `buildlock status` (with `--watch` and `--json`), `history`, `stats` and `explain` show what runs, what waits and why. A job that has to wait says so once on stderr.
- `buildlock config` (interactive, or `list` / `get` / `set` / `unset` / `edit`) and a bash config file; environment variables win over it.
- Quiet hours (`QUIET_HOURS` with `QUIET_SLOTS`, `QUIET_WORKERS`, ...) and `buildlock quiet on|off|auto`; your own conditions in the config file can switch quiet mode or `BUILDLOCK_BYPASS`.
- `buildlock agents install` teaches coding agents to use buildlock: a marker-fenced section in the global or project instructions of Claude Code, Codex CLI, Gemini CLI, opencode, Qwen Code, Cursor, Windsurf, GitHub Copilot, Kiro, Factory Droid, Pi, Kimi Code and Grok Build, with the project's own commands listed. `uninstall` removes exactly what it wrote.
- `buildlock setup`, `doctor`, `update`, `uninstall`, `completion bash|zsh`, and a one-line installer that verifies checksums.
- `run --light | --heavy | --memory MB | --timeout S`; a missing command fails with 127 before queueing, with a hint for mistyped subcommands.
