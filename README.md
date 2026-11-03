# buildlock

A machine-wide queue for heavy commands. Put `buildlock` in front of a full build, type-check or test run, and it waits until the machine has room for it, then runs it unchanged: same output, same exit code.

[中文说明](README.zh-CN.md)

It is for one machine shared by many terminals, worktrees and coding agents. Five Claude Code or Codex sessions that each start `tsc`, `vitest run` and a build in the same minute can push a 32-core box into swap until SSH stops answering. Queued with buildlock, they take turns, and they still run side by side whenever the machine has room for more.

```sh
buildlock npm test
buildlock npx tsc --noEmit
buildlock cargo build --release
```

- **One line in front of the command.** No daemon, no service, no config needed. It is a single bash script.
- **Admits by real headroom.** A free slot, load, CPU, IO and memory pressure, free memory, and how much memory the jobs that just started may still need.
- **Learns each command.** Peak memory and run time are recorded per repository and command. From the third run on, the memory reserved for a command is the measured figure instead of a guess, and small, fast commands move to a separate light lane.
- **Fair.** Jobs start in arrival order. A heavy job never starves behind a stream of small ones.
- **Teaches your coding agents.** `buildlock agents install` adds a short section to the instructions of Claude Code, Codex, Gemini CLI, Cursor, opencode, Copilot and others, so every session learns to use it.
- **Quiet hours.** Run fewer jobs at night, or whenever your own condition says so.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/Ice-Hazymoon/buildlock/main/install.sh | bash
```

The installer checks the requirements, downloads the latest release, verifies its checksum and puts `buildlock` in `~/.local/bin`. It then offers the guided setup. Options go after `bash -s --`:

```sh
curl -fsSL https://raw.githubusercontent.com/Ice-Hazymoon/buildlock/main/install.sh | bash -s -- --prefix /usr/local/bin --yes
```

| Option | |
| --- | --- |
| `--prefix DIR` | install directory (default `~/.local/bin`) |
| `--version vX.Y.Z` | a specific release; `main` for the development version |
| `--yes` | no questions, no setup |
| `--from FILE` | install a local copy of `bin/buildlock` |

**Requirements:** Linux or WSL 2, bash 5, util-linux 2.31+ (`flock`, `setsid --wait`), procps (`ps`), GNU coreutils. That is any current distribution. Pressure stall information (`/proc/pressure`, kernel 4.20+) is used when present. `python3` is only needed to write Claude Code's permission settings.

Update with `buildlock update`, remove with `buildlock uninstall`. Updates replace the file by rename, so jobs that are running or queued are not disturbed.

## Quick start

```sh
buildlock setup            # limits for this machine, quiet hours, coding agents
buildlock npm run build    # any heavy command
buildlock status           # what is running, what is queued, and why
```

```text
$ buildlock status
buildlock 0.1.0 · 32 cores · 59.4 GB RAM

Running  heavy 3/4 (up to 8 when idle) · light 0/8
  SLOT  PID      AGE     BUDGET   WHERE                      COMMAND
  h0    886679   36s     11.9 GB  ~/projects/shop            bun run typecheck
  h1    836499   5m38s   7.7 GB   ~/projects/app             pnpm -r test
  h2    892901   9s      2.3 GB   ~/projects/shop-feature    vitest run --project integration

Queued   1
  #   CLASS  PID      WAITING  WHERE                      COMMAND
  1   heavy  893114   4s       ~/projects/api             cargo build --release

Machine  load 11.68/40 · 19.8 GB free · swap 74% free · pressure cpu 0% io 0% mem 0%
Next     heavy: waits · last start 9s ago < 20s gap
         light: starts now
```

A command that has to wait says so once on stderr (`buildlock: waiting (all 4 slots busy); starts on its own`), and when it starts it prints `buildlock: waited 37s (slot 1 of 4)`. Everything else is the command's own output.

## Teach your coding agents

```sh
buildlock agents install             # global: every project on this machine
buildlock agents install --project   # this repository, with its own commands
buildlock agents status
buildlock agents uninstall
```

The global install finds the coding agents on this machine and writes a short, marker-fenced section into each one's global instructions file, its "memory". The section tells every session, subagents included, to run full builds, type-checks and test suites through `buildlock`, not to wrap quick commands, and to keep working instead of polling a queued job.

The project install writes into the repository's own files instead, so everyone who clones it gets the section. buildlock reads `package.json` (bun, pnpm, yarn or npm), `Cargo.toml`, `go.mod`, pytest, Makefile, Gradle and Maven, and lists the project's real commands:

```markdown
<!-- BUILDLOCK_START -->
## Heavy commands: queue them with buildlock

When `buildlock` is installed (`command -v buildlock`), run this project's full builds,
type-checks, test suites and lint through it, ...

    buildlock bun run build
    buildlock bun run typecheck
    buildlock bun run test
...
<!-- BUILDLOCK_END -->
```

| Agent | Global file | Project file |
| --- | --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` | `CLAUDE.md` |
| Codex CLI | `~/.codex/AGENTS.md` | `AGENTS.md` |
| Gemini CLI | `~/.gemini/GEMINI.md` | `GEMINI.md` |
| opencode | `~/.config/opencode/AGENTS.md` | `AGENTS.md` |
| Qwen Code | `~/.qwen/QWEN.md` | `QWEN.md` |
| Cursor | none (rules are per project) | `.cursor/rules/buildlock.mdc` |
| Windsurf | `~/.codeium/windsurf/memories/global_rules.md` | `.windsurf/rules/buildlock.md` |
| GitHub Copilot | none | `.github/copilot-instructions.md` |
| Kiro | `~/.kiro/steering/buildlock.md` | `.kiro/steering/buildlock.md` |
| Factory Droid | `~/.factory/AGENTS.md` | `AGENTS.md` |
| Pi | `~/.pi/agent/AGENTS.md` | `AGENTS.md` |
| Kimi Code | `~/.kimi-code/AGENTS.md` | `AGENTS.md` |
| Grok Build | `~/.grok/rules/buildlock.md` | `.grok/rules/buildlock.md` |

Details:

- **Choosing agents.** `--target` chooses the agents: `auto` (detected, the default), `all`, `none`, or a list such as `claude,codex`. Interactively you pick from a list with the detected agents preselected. `--dry-run` shows what would change.
- **Only its own section.** Your content is left alone. Running the install again updates the section in place, and `uninstall` removes exactly what was added.
- **Existing mentions.** A file that already mentions buildlock in your own words is kept as it is, unless you pass `--force`.
- **Shared files.** Several agents read `AGENTS.md`, and a `CLAUDE.md` may be a symlink to it or just `@AGENTS.md`. Each real file is written once, and symlinks stay symlinks.
- **Claude Code permissions.** Claude Code is allowed to run `buildlock status`, `explain`, `history` and `stats` without asking (`--no-permissions` skips this). It never gets `Bash(buildlock:*)`: buildlock runs whatever follows it, so the wrapped command keeps its normal permission prompt.

## How it decides

1. **Order.** Jobs wait in arrival order, in one of two lanes. *Heavy* jobs (builds, type-checks, test suites) take a heavy slot; *light* jobs (quick checks under about 2 GB and 3 minutes) have a separate pool, so they don't queue behind a long build.
2. **Room.** The first job in a lane starts when nothing runs. Beside running jobs, a job starts only when all of these hold:
   - a slot is free (`cores / WORKERS` heavy slots, `cores / 4` light slots);
   - 20 seconds have passed since the last heavy start, so that job's load shows first;
   - load is under `cores × 1.25`, and CPU, IO and memory pressure are under their limits;
   - swap is not nearly full;
   - after reserving this job's memory and what recently started jobs may still grow into, `RESERVE_MEMORY_MB` stays free.
3. **Memory budgets.** Every job's peak memory and run time go to a log (`~/.cache/buildlock/jobs-YYYY-MM.jsonl`). From the third run of the same command in the same repository, its budget is the p90 peak × 1.25 + 256 MB. Until then it is the declared `--memory`, or a default of 8 GB heavy and 1.5 GB light. Worktrees of one repository share their history.
4. **Idle machine.** When expected load is under half the cores and pressure is low, the start gap is skipped and up to `cores / 4` heavy jobs may run. Memory checks always apply.
5. **Critical memory.** Below 3 GB available, or under heavy memory stalls, nothing starts, not even a lone job.
6. **Nesting.** A buildlock call inside a running job (a script that calls `buildlock` again) runs straight through instead of deadlocking. Copying the environment variable to another process does not let that process skip the queue.

The command runs in its own process group. Ctrl-C or SIGTERM reaches the whole group, and the slot is released only after every process in it has exited. buildlock also exports `VITEST_MAX_WORKERS`, `VITEST_MAX_FORKS`, `VITEST_MAX_THREADS` and `JEST_MAX_WORKERS` (default 8), plus `BUILDLOCK_WORKERS` for your own scripts (`make -j"$BUILDLOCK_WORKERS"`).

## Commands

| Command | |
| --- | --- |
| `buildlock <cmd> [args]` | run a command once there is room |
| `buildlock run [--light\|--heavy] [--memory MB] [--timeout S] -- <cmd>` | the same, with options |
| `buildlock status [--watch] [--json]` | running and queued jobs and the next verdict |
| `buildlock explain <cmd>` | how a command would be scheduled, without running it |
| `buildlock history [-n N] [--here] [--failed] [--json]` | recent jobs |
| `buildlock stats [--days N] [--here]` | run time, memory budget, lane and waiting per command |
| `buildlock config` | interactive settings; also `list`, `get`, `set`, `unset`, `edit`, `path` |
| `buildlock quiet [on\|off\|auto]` | quiet mode |
| `buildlock agents [install\|uninstall\|status\|print]` | coding-agent instructions |
| `buildlock setup` | guided setup |
| `buildlock doctor` | check requirements, installation, config and agents |
| `buildlock completion bash\|zsh` | shell completion |
| `buildlock update [--check]` / `uninstall [--purge]` | maintenance |

A program whose name matches a subcommand (`status`, `run`, `log`, ...) runs with `buildlock run -- status`.

Exit codes are the command's own. Additionally, 73 means it timed out waiting (`--timeout` / `BUILDLOCK_TIMEOUT`), 127 means the command was not found (checked before queueing), and 129, 130 and 143 mean it was cancelled by HUP, INT or TERM.

Shell completion:

```sh
echo 'eval "$(buildlock completion bash)"' >> ~/.bashrc
echo 'source <(buildlock completion zsh)' >> ~/.zshrc   # after compinit
```

## Configuration

`buildlock config` opens an interactive menu, and `buildlock config list` shows every setting with its current value and where it comes from. Settings live in `~/.config/buildlock/config` (or `$BUILDLOCK_CONFIG`). Each one can also be set for a single call with an environment variable `BUILDLOCK_<KEY>`, which wins over the file.

```sh
buildlock config set SLOTS 2
buildlock config set QUIET_HOURS 00:00-08:00
BUILDLOCK_SLOTS=1 buildlock npm test
```

| Key | Default | |
| --- | --- | --- |
| `SLOTS` | cores / `WORKERS` | heavy jobs at once on a busy machine |
| `WORKERS` | 8 | test workers per heavy job; CPUs a heavy job is assumed to use |
| `MAX_JOBS` | cores / 4 | heavy jobs at once when the machine is idle (`SLOTS` if only `SLOTS` is set) |
| `LIGHT_SLOTS` | cores / 4 | light jobs at once |
| `RESERVE_MEMORY_MB` | 6144 | memory kept free after admitting a job |
| `CRITICAL_MEMORY_MB` | 3072 | below this, nothing starts |
| `DEFAULT_MEMORY_MB` | 8192 | budget of a heavy command with no history |
| `START_GAP` | 20 | seconds between heavy starts |
| `LOAD_MAX` | cores × 1.25 | load ceiling for starting beside other jobs |
| `QUIET_HOURS` | | e.g. `00:00-08:00`, `22-06`, `12-13,22-07` |
| `QUIET_SLOTS`, `QUIET_WORKERS`, `QUIET_LIGHT_SLOTS`, `QUIET_MAX_JOBS` | | the limits during quiet hours |

`buildlock config list` shows the rest (pressure ceilings, the light lane's limits, the ramp-up window, the job log directory, profiling on or off).

### Quiet hours and your own conditions

During quiet hours each `QUIET_<KEY>` replaces `<KEY>`. A quiet slot count also caps the idle fast path (unless `QUIET_MAX_JOBS` / `QUIET_LIGHT_MAX_JOBS` say otherwise), so an idle machine stays quiet too. `buildlock quiet on` / `off` force quiet mode until `buildlock quiet auto`.

The config file is bash. `buildlock config` only rewrites the lines between its markers, and you can add your own logic after them. For example, to follow a CPU power profile instead of a clock, or to let CI and one particular tool run unqueued:

```bash
# >>> buildlock config >>>
BUILDLOCK_QUIET_SLOTS=1
BUILDLOCK_QUIET_WORKERS=4
# <<< buildlock config <<<

# Quiet whenever turbo boost is off (a "silent" power profile).
if read -r boost < /sys/devices/system/cpu/cpufreq/boost 2>/dev/null && [[ $boost == 0 ]]; then
    BUILDLOCK_QUIET=on
fi

# CI runners have the machine to themselves.
[[ -n "${CI:-}" ]] && BUILDLOCK_BYPASS=1
```

`BUILDLOCK_BYPASS=1` runs commands at once, without queueing. The worker limits are still exported.

A mistake in the file never stops a build. A failing line is skipped and `buildlock doctor` points at it. A value buildlock cannot use, such as `SLOTS=abc`, falls back to its default with a warning. `buildlock config set` rejects bad values in the first place, and it warns when your own code below the markers still overrides the value you just set. See [examples/config](examples/config) for more.

## For scripts and tools

These interfaces are stable across versions:

- **`buildlock --status`.** One line per job, then a summary line:
  ```text
  holder pid=1234 age=12s worktree=/path slot=0 class=heavy
  queued pid=1240 age=3s worktree=/path class=heavy
  scheduler running=1/4 next=start light=0/8 idle=yes expected_load=9.00 max=8 light_max=16
  ```
- **`buildlock status --json`.** Lanes, running and queued jobs, machine metrics.
- **`buildlock --explain <cmd>`.** Key, samples, profile, class and budget, verdict.
- **The `buildlock: waited Ns` line** on stderr when a job starts.
- **The job log.** JSON Lines in `~/.cache/buildlock/jobs-YYYY-MM.jsonl`, one line per finished job: `at`, `end`, `pid`, `cwd`, `class`, `budgetMb`, `waitSeconds`, `runSeconds`, `exit`, `cmd`, `key`, `peakMb`, `budgetSource`, `admission`. `buildlock history --json` prints them.
- **Environment variables.** `BUILDLOCK_CLASS=light|heavy`, `BUILDLOCK_JOB_MEMORY_MB`, `BUILDLOCK_TIMEOUT`. For isolated tests: `BUILDLOCK_LOCK_PATH`, `BUILDLOCK_JOB_LOG_DIR`, `BUILDLOCK_CONFIG=` (no config).

## Limits

- **Only what goes through it.** A command started without buildlock still counts through load, pressure and memory, but it takes no slot.
- **A scheduler, not a sandbox.** It decides when a job starts. It does not cap a job's CPU or memory once it runs: use cgroups or `systemd-run` for that.
- **Linux only.** It reads `/proc` and relies on `flock` and `setsid`. On macOS there is no `/proc`.

## Development

```sh
bun test                                # scheduler and CLI tests (isolated: fake /proc, temp HOME)
shellcheck bin/buildlock install.sh
```

Releases are published from a `v*` tag by GitHub Actions, which attaches `buildlock`, its `.sha256` and `install.sh`.

## License

[MIT](LICENSE)
