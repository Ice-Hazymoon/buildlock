# Changelog

## 0.3.0

**Memory waits**

- Backfill: while the first heavy job waits for memory, a later heavy job may start ahead of it when it passes every admission check on its own and has a learned run time (p90 of at least 3 runs) within `BACKFILL_MAX_SECONDS` (default 120; 0 turns it off). Commands without that history never backfill; candidates keep arrival order (only the oldest may try). The waiting job is protected from `HEAVY_STARVE_SECONDS` on, which stops backfill, unless it is hopeless (nothing is starting up and even the relaxed check below would not fit it). Only one backfilled job runs at a time: while it runs the waiting job stays protected, so backfills cannot chain into a stream that keeps it waiting. Such starts are logged with `"admission":"backfill"`.
- Relaxed memory check: a heavy job that has waited `MEMORY_RELAX_SECONDS` (default 300) for memory, while no job of either lane is starting up, needs only `CRITICAL_MEMORY_MB` free after its budget instead of `RESERVE_MEMORY_MB`, but only when the running jobs' ends would not free enough for the full reserve either: the shortfall is memory held outside buildlock, which waiting does not free. While buildlock's own jobs hold enough, it keeps waiting for them. `0` turns the check off. Logged as `"admission":"memory-relaxed"`.
- The light-lane reservation for a waiting heavy job follows the same protection: light jobs are no longer held back for a heavy job that cannot start anyway, except while another job is starting up.
- `status` judges the heavy lane for the job actually waiting on memory, with its own budget (before, a job with the default budget), says when the relaxed check applies or will, and says when backfill is open. `--status` adds `relaxed=` and `backfill=` at the end of the scheduler line; `status --json` adds `memoryRelaxed` and `backfill` to the heavy lane. `explain` adds `backfill:` and `relaxed:` lines after `verdict:`. `stats` counts starts by admission (`admissions` in `--json`).

**Light lane**

- Short commands take the light lane with a larger memory cap: a learned budget up to `LIGHT_SHORT_MAX_MB` (default RAM / 8, at most 5120) and a learned p90 run up to `LIGHT_SHORT_MAX_SECONDS` (default 60). Test files, lint and partial type-checks that take seconds but 2–5 GB no longer queue behind long builds. Above `LIGHT_MAX_MB` such a job keeps the start gap and counts as `WORKERS` CPUs, so a burst of them cannot outrun the load average. The heavy job's memory reservation applies to them as to every light job.

**Running and queued jobs**

- A running job whose processes used under `STALL_CPU_SECONDS` (default 5) of CPU in `STALL_SECONDS` (default 1800) shows as stalled: `stalled=Ns` at the end of its `--status` line, `stalledSeconds` in `status --json`, a note in `status` and a warning in `doctor`, which mention that builds working through a daemon (Gradle, Bazel, Docker) look the same. Nothing is stopped, and it keeps its slot.
- A queued job whose caller exits (its parent pid changes, whether to init or to a subreaper such as `systemd --user`) leaves the queue with exit code 74 and says so on stderr, instead of running later for nobody. Running jobs are never affected. `KEEP_ORPHANS=on` (`BUILDLOCK_KEEP_ORPHANS=1`) keeps such jobs; the default `auto` keeps them when the caller set them up to outlive it: SIGHUP ignored (`nohup`), their own session (`setsid`), or stdout or stderr redirected to a regular file of its own (`buildlock cmd > log &`). Output it shares with the caller (a pipe, a terminal, an agent tool's output file) has nobody left to read it.
- Queue files gain a trailing field (`backfill` or `-`), which older versions ignore.

## 0.2.3

- The job log says why a job waited: `waitReasons` holds the seconds spent on each blocking reason (`slot`, `memory`, `memory-pressure`, `gap`, `load`, `cpu`, `io`, `swap`, `order` for a job queued behind an earlier one, `other`), taken from the verdict `--status` shows. It appears only on a line with a wait; older lines and readers are unaffected. `buildlock stats` (and `stats --json`, as a trailing `waitReasons` member) totals them.

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
