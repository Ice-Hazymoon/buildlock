# buildlock

[![CI](https://github.com/Ice-Hazymoon/buildlock/actions/workflows/ci.yml/badge.svg)](https://github.com/Ice-Hazymoon/buildlock/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Ice-Hazymoon/buildlock)](https://github.com/Ice-Hazymoon/buildlock/releases/latest)
[![npm](https://img.shields.io/npm/v/buildlock)](https://www.npmjs.com/package/buildlock)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A machine-wide queue for heavy commands, for Linux and WSL 2. Put `buildlock` in front of a full build, type-check or test run, and it waits until the machine has room for it, then runs it unchanged: same output, same exit code.

[中文说明](README.zh-CN.md)

It is for one machine shared by many terminals, worktrees and coding agents. Five Claude Code or Codex sessions that each start `tsc`, `vitest run` and a build in the same minute can push a 32-core box into swap until SSH stops answering. Queued with buildlock, they take turns, and they still run side by side whenever the machine has room for more.

```sh
buildlock npm test
buildlock npx tsc --noEmit
buildlock cargo build --release
```

- **One word in front of the command.** No daemon, no service, no config needed. It is a single bash script, and a job that starts at once prints nothing of its own.
- **Admits by real headroom.** A free slot, load, CPU, IO and memory pressure, free memory, and how much memory the jobs that just started may still need.
- **Learns each command.** Peak memory and run time are recorded per repository and command. From the third run on, the memory reserved for a command is the measured figure instead of a guess, and small, fast commands move to a separate light lane.
- **Fair.** Jobs start in arrival order, and a heavy job that waits for memory gets it kept free, so a stream of small jobs cannot starve it.
- **Transparent.** Ctrl-C, Ctrl-Z, password prompts and window resizes work as without it; signals reach the command once, and it may clean up before it exits.
- **Teaches your coding agents.** `buildlock agents install` adds a short section to the instructions of Claude Code, Codex, Gemini CLI, Copilot, opencode, Cursor and more than a dozen others, so every session learns to use it.
- **Quiet hours.** Run fewer jobs at night, or whenever your own condition says so.

## Install

```sh
curl -fsSL https://github.com/Ice-Hazymoon/buildlock/releases/latest/download/install.sh | bash
```

The installer checks the requirements, downloads the latest release, verifies its checksum and puts `buildlock` in `~/.local/bin`. On a first install it offers the guided setup. Options go after `bash -s --`:

```sh
curl -fsSL https://github.com/Ice-Hazymoon/buildlock/releases/latest/download/install.sh | bash -s -- --prefix ~/bin --yes
```

| Option | |
| --- | --- |
| `--prefix DIR` | install directory (default `~/.local/bin`, or `$BUILDLOCK_PREFIX`) |
| `--version vX.Y.Z` | a specific release; `main` for the development version |
| `--yes` | no questions, no setup |
| `--no-setup` | don't offer the guided setup |
| `--from FILE` | install a local copy of `bin/buildlock` |
| `--force` | replace a symlink, or a file that is not buildlock, at the target |

Or from npm (the package is the same script; Node.js is not used when it runs):

```sh
npm install -g buildlock      # or: pnpm add -g buildlock, bun add -g buildlock
```

Update an npm install with `npm install -g buildlock@latest`; `buildlock update` and `buildlock uninstall` tell you the command for the package manager that installed it. `npx buildlock …` works too, but it resolves the package on every call: install it globally for agents and scripts.

For every user of the machine, install into a root-owned directory with `sudo bash` (`... | sudo bash -s -- --prefix /usr/local/bin --yes`), update it with `sudo buildlock update`, and run `buildlock setup` and `buildlock agents install` as yourself.

**Requirements:** Linux or WSL 2, bash 5, util-linux 2.31+ (`flock`, `setsid --wait`), procps (`ps`), GNU coreutils. That is any current distribution. Pressure stall information (`/proc/pressure`, kernel 4.20+) is used when present. `python3` is only needed to write Claude Code's permission settings.

Update with `buildlock update`, remove with `buildlock uninstall` (see [Uninstall](#uninstall)). Updates replace the file by rename, so jobs that are running or queued are not disturbed.

## Quick start

```sh
buildlock setup            # limits for this machine, quiet hours, coding agents
buildlock npm run build    # any heavy command
buildlock status           # what is running, what is queued, and why
```

```text
$ buildlock status
buildlock 0.2.0 · 32 cores · 59.4 GB RAM

Running  heavy 3/4 (up to 8 when idle) · light 0/8
  SLOT  PID      AGE     BUDGET   WHERE                      COMMAND
  h0    886679   36s     11.9 GB  ~/projects/shop            bun run typecheck
  h1    836499   5m38s   7.7 GB   ~/projects/app             pnpm -r test
  h2    892901   9s      2.3 GB   ~/projects/shop-feature    vitest run --project integration

Queued   1
  #   CLASS  PID      WAITING  WHERE                      COMMAND
  1   heavy  893114   4s       ~/projects/api             cargo build --release

Machine  load 11.68 of 40 · 19.8 GB free · swap 74% free
         pressure: cpu 0% · io 0% · memory 0%
Next     heavy: waits: a heavy job started 9s ago; the next one may start 11s later
         light: starts now
```

A job that starts at once prints nothing of its own. One that has to wait says so once on stderr, `buildlock: waiting (all 4 heavy slots are busy); starts on its own`, and when it starts, `buildlock: waited 37s (slot 2 of 4)`. Everything else is the command's own output.

### Is it working?

```sh
buildlock doctor
BUILDLOCK_SLOTS=1 buildlock sleep 30 &
buildlock --timeout 5 true    # waiting (the one heavy slot is busy) ... gave up after 5s, exit 73
```

## Teach your coding agents

```sh
buildlock agents install             # global: every project on this machine
buildlock agents install --project   # this repository, with its own commands
buildlock agents status
buildlock agents uninstall
```

The global install finds the coding agents on this machine and writes a short, marker-fenced section into each one's global instructions file, its "memory". The section tells every session, subagents included:

- run full builds, type-checks, test suites and repo-wide lint through `buildlock`, and nothing else;
- a queued command starts on its own, so give it a long timeout or run it in the background, and don't start it again or poll it;
- exit code 73 means it gave up waiting and the command never ran;
- if `buildlock` isn't installed (a synced dotfile on another machine), run the command directly.

The project install writes the repository's own `AGENTS.md`, which nearly every agent reads, so everyone who clones the repository gets the section. It lists the project's real commands, read from `package.json` (bun, pnpm, yarn or npm, from the lockfile or `packageManager`), `Cargo.toml`, `go.mod`, pytest (with uv or poetry), Makefile, justfile, Gradle and Maven, and says to run them directly, without installing anything, on machines without buildlock:

```markdown
<!-- BUILDLOCK_START -->
## Heavy commands: optional buildlock queue

Some machines that run coding agents on this project queue heavy commands with
buildlock. If `buildlock` is on PATH, prefix the full build, type-check and
test commands with it:

    buildlock bun run build
    buildlock bun run typecheck
    buildlock bun run test

If it is not on PATH, run the same commands without the prefix; don't install it. ...
<!-- BUILDLOCK_END -->
```

Two agents need more than `AGENTS.md`, and get it only from files the project already has:

- **Claude Code** reads `AGENTS.md` only while the project has no `CLAUDE.md` of its own. An existing `CLAUDE.md` gets the section too, unless it imports `@AGENTS.md` or links to it. buildlock never creates a `CLAUDE.md`: that would hide `AGENTS.md` from Claude.
- **Gemini CLI** reads `GEMINI.md`. An existing one gets the section; `--target gemini` creates one.

The install runs from any directory of the repository and writes to its top. It also removes the per-agent copies (`.cursor/rules/buildlock.mdc`, `.github/copilot-instructions.md`, ...) that version 0.1 wrote, since those agents read `AGENTS.md` as well.

| Agent | Global file |
| --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex CLI | `~/.codex/AGENTS.md` (`AGENTS.override.md` when you have one) |
| Gemini CLI, Antigravity | `~/.gemini/GEMINI.md` |
| opencode | `~/.config/opencode/AGENTS.md` |
| Qwen Code | `~/.qwen/QWEN.md` |
| GitHub Copilot (CLI, VS Code) | `~/.copilot/copilot-instructions.md` |
| Devin (Windsurf) | `~/.config/devin/AGENTS.md` (skipped when `~/.claude/CLAUDE.md` has the section: Devin reads it too) |
| Kiro | `~/.kiro/steering/buildlock.md` |
| Factory Droid | `~/.factory/AGENTS.md` |
| Pi | `~/.pi/agent/AGENTS.md` |
| Kimi Code | `~/.kimi-code/AGENTS.md` |
| Grok Build | `~/.grok/rules/buildlock.md` |
| Amp, Crush | `~/.config/AGENTS.md` |
| Zed | `~/.config/zed/AGENTS.md` |
| Junie | `~/.junie/AGENTS.md` |
| Kilo Code | `~/.config/kilo/AGENTS.md` |
| Goose | `~/.config/goose/AGENTS.md` |
| Cline | `~/.cline/rules/buildlock.md` |
| Augment (Auggie) | `~/.augment/rules/buildlock.md` |
| Continue | `~/.continue/rules/buildlock.md` |
| Cursor | none (its user rules live in the app); projects get it through `AGENTS.md` |

Each path follows the agent's own variable where it has one (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GEMINI_CLI_HOME`, `QWEN_HOME`, `COPILOT_HOME`, `PI_CODING_AGENT_DIR`, `KIMI_CODE_HOME`, `GROK_HOME`, `JUNIE_HOME`, `KILO_CONFIG_DIR`, `CONTINUE_GLOBAL_DIR`, `XDG_CONFIG_HOME`).

Details:

- **Choosing agents.** `--target` chooses the agents: `auto` (detected, the default), `all`, `none`, or a list such as `claude,codex`. An agent counts as detected when its command is on PATH or its home directory holds files of its own; a directory with nothing but `skills/` in it, which skill installers create, doesn't count. Interactively you pick from a list with the detected agents preselected. `--dry-run` shows what would change.
- **Only its own section.** Your content is left alone. Running the install again updates the section in place, and `uninstall` removes exactly what was added, along with any directory it created that is now empty.
- **Existing mentions.** A file that already mentions buildlock in your own words is kept as it is, unless you pass `--force`.
- **Shared files.** Several agents read the same file, and a `CLAUDE.md` may be a symlink to `AGENTS.md`. Each real file is written once, and symlinks stay symlinks.
- **Claude Code permissions.** Claude Code matches `buildlock npm test` against no `npm test` rule, so the global install adds the matching rule for wrapped commands to `~/.claude/settings.json`: an allowed build or test command (`Bash(npm test:*)`) stays allowed behind buildlock (`Bash(buildlock npm test:*)`), and every deny or ask rule keeps applying behind it. It also allows the read-only `buildlock status`, `explain`, `history` and `stats`. It never adds `Bash(buildlock:*)`, which would let any command skip the prompt. Run the install again after you add rules; `--no-permissions` leaves the settings alone.

## How it decides

1. **Order.** Jobs wait in arrival order, in one of two lanes. *Heavy* jobs (builds, type-checks, test suites) take a heavy slot; *light* jobs (quick checks under about 2 GB and 3 minutes) have a separate pool, so they don't queue behind a long build.
2. **Room.** The first job in a lane starts when nothing runs. Beside running jobs, a job starts only when all of these hold:
   - a slot is free (`cores / WORKERS` heavy slots, `cores / 4` light slots);
   - 20 seconds have passed since the last heavy start, so that job's load shows first;
   - load is under `cores × 1.25`, and CPU, IO and memory pressure are under their limits;
   - swap is not nearly full;
   - after reserving this job's memory and what recently started jobs may still grow into, `RESERVE_MEMORY_MB` stays free.
3. **Memory budgets.** Every job's peak memory and run time go to a log (`~/.cache/buildlock/jobs-YYYY-MM.jsonl`). From the third run of the same command in the same repository, its budget is the p90 peak × 1.25 + 256 MB. Until then it is the declared `--memory`, or a default: a quarter of the RAM (at most 8 GB) for heavy jobs, 1.5 GB for light ones. Worktrees of one repository share their history.
4. **No starving.** A heavy job that has waited a minute for memory has light jobs keep its budget free too, instead of taking every bit that frees up.
5. **Idle machine.** When expected load is under half the cores and pressure is low, the start gap is skipped and up to `cores / 4` heavy jobs may run. Memory checks always apply.
6. **Critical memory.** Below a tenth of the RAM available (at most 3 GB), or under heavy memory stalls, nothing starts, not even a lone job.
7. **Nesting.** A buildlock call inside a running job (a script that calls `buildlock` again) runs straight through instead of deadlocking, also when a wrapper such as `env -i` or turbo's strict env mode drops `BUILDLOCK_HELD`. Copying the environment variable to another process does not let that process skip the queue.

**The command itself.** In a terminal the command runs in buildlock's own process group, so the terminal reaches it as usual: Ctrl-C, Ctrl-Z and Ctrl-\, window resizes, and `/dev/tty` for sudo, ssh or gpg prompts. Ctrl-C in a loop stops the loop. Elsewhere (coding agents, CI, pipes) it gets a session of its own, and buildlock passes HUP, INT, QUIT and TERM on to its whole process tree, once; the command may clean up before it exits, and a second signal kills it. Whatever the command leaves running in that session is stopped when it exits, and the slot is released only then. If buildlock itself is killed with `kill -9`, a watchdog stops the command it leaves behind within a couple of seconds. A Ctrl-Z while queued lets the jobs behind it go first.

buildlock exports `BUILDLOCK_WORKERS`, the cores one heavy job is assumed to use, for your own scripts (`make -j"$BUILDLOCK_WORKERS"`, `vitest --maxWorkers=$BUILDLOCK_WORKERS`). With `EXPORT_WORKERS=on` it also exports `VITEST_MAX_WORKERS`; that is off by default because Vitest lets the variable override a project's own settings, `fileParallelism: false` included.

## Commands

| Command | |
| --- | --- |
| `buildlock <cmd> [args]` | run a command once there is room |
| `buildlock run [--light\|--heavy] [--memory SIZE] [--timeout S] -- <cmd>` | the same, with options |
| `buildlock status [--watch] [--json]` | running and queued jobs and why the next one waits |
| `buildlock explain <cmd>` | how a command would be scheduled, without running it |
| `buildlock history [-n N] [--here] [--failed] [--days N] [--json]` | recent jobs |
| `buildlock stats [--days N] [--here] [--json]` | run time, memory budget, lane and waiting per command |
| `buildlock config` | interactive settings; also `list`, `get`, `set`, `unset`, `edit`, `path` |
| `buildlock quiet [on\|off\|auto]` | quiet mode |
| `buildlock agents [install\|uninstall\|status\|print]` | coding-agent instructions |
| `buildlock setup` | guided setup |
| `buildlock doctor` | check requirements, installation, config, limits and agents |
| `buildlock completion bash\|zsh\|fish` | shell completion |
| `buildlock update [--check]` / `uninstall [--purge]` | maintenance |

Every command takes `--help`. A program whose name matches a subcommand (`status`, `run`, `log`, ...) runs with `buildlock run -- status`. `--memory` takes megabytes or a size such as `512M` or `2G`.

Exit codes are the command's own. Additionally, 73 means it gave up waiting (`--timeout` / `BUILDLOCK_TIMEOUT`) and the command never ran, 126 that it is not executable and 127 that it was not found (both checked before queueing), and 129, 130, 131 and 143 that it was cancelled by HUP, INT, QUIT or TERM while queued.

Shell completion:

```sh
echo 'eval "$(buildlock completion bash)"' >> ~/.bashrc
echo 'source <(buildlock completion zsh)' >> ~/.zshrc   # after compinit
buildlock completion fish > ~/.config/fish/completions/buildlock.fish
```

## Configuration

`buildlock config` opens an interactive menu, and `buildlock config list` shows every setting with its current value and where it comes from. Settings live in `~/.config/buildlock/config` (or `$BUILDLOCK_CONFIG`). Each one can also be set for a single call with an environment variable `BUILDLOCK_<KEY>`, which wins over the file.

```sh
buildlock config set SLOTS 2
buildlock config set RESERVE_MEMORY_MB 4G
buildlock config set QUIET_HOURS 00:00-08:00
BUILDLOCK_SLOTS=1 buildlock npm test
```

| Key | Default | |
| --- | --- | --- |
| `SLOTS` | cores / `WORKERS` | heavy jobs at once on a busy machine |
| `WORKERS` | 8 (at most cores) | cores a heavy job is assumed to use |
| `EXPORT_WORKERS` | off | also export `VITEST_MAX_WORKERS=WORKERS` (overrides a project's own Vitest worker settings) |
| `MAX_JOBS` | cores / 4 | heavy jobs at once when the machine is idle (`SLOTS` if only `SLOTS` is set) |
| `LIGHT_SLOTS` | cores / 4 | light jobs at once |
| `RESERVE_MEMORY_MB` | RAM / 8, at most 6144 | memory kept free after admitting a job |
| `CRITICAL_MEMORY_MB` | RAM / 10, at most 3072 | below this, nothing starts |
| `DEFAULT_MEMORY_MB` | RAM / 4, at most 8192 | budget of a heavy command with no history |
| `START_GAP` | 20 | seconds between heavy starts |
| `LOAD_MAX` | cores × 1.25 | load ceiling for starting beside other jobs |
| `CORES` | `nproc` | cores to plan for (set it in containers and WSL) |
| `BYPASS` | off | run commands at once, without queueing |
| `QUIET_HOURS` | | e.g. `00:00-08:00`, `22-06`, `12-13,22-07` |
| `QUIET_SLOTS`, `QUIET_LIGHT_SLOTS` | half of the normal value | jobs at once during quiet hours |
| `QUIET_WORKERS`, `QUIET_MAX_JOBS` | `WORKERS`, `QUIET_SLOTS` | the other limits during quiet hours |

`buildlock config list` shows the rest (pressure ceilings, the light lane's limits, the ramp-up window, the job log directory, profiling on or off). Sizes take units (`512M`, `2G`).

### Quiet hours and your own conditions

During quiet hours each `QUIET_<KEY>` replaces `<KEY>`, and without its own limits quiet mode runs half the jobs at once. A quiet slot count also caps the idle fast path (unless `QUIET_MAX_JOBS` / `QUIET_LIGHT_MAX_JOBS` say otherwise), so an idle machine stays quiet too. `buildlock quiet on` / `off` force quiet mode until `buildlock quiet auto`.

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

The file runs apart from buildlock on every call: only its `BUILDLOCK_*` values come back. What it prints goes to stderr, and an `exit`, a `cd` or an `IFS` change in it cannot end buildlock or affect the command. A mistake never stops a build: a line that fails is skipped (its error shows on every call, and `buildlock doctor` lists it), while a syntax error ends the file at that line, so later settings are ignored until you fix it (`buildlock doctor` reports that too). A value buildlock cannot use, such as `SLOTS=abc`, falls back to its default with a warning. `buildlock config set` rejects bad values in the first place, and it warns when your own code below the markers still overrides the value you just set. Keep the file quick, since it runs before every command. See [examples/config](examples/config) for more.

## In scripts, Makefiles and CI

- **package.json scripts** stay usable without buildlock: `"test": "$(command -v buildlock) vitest run"` runs plain `vitest run` where buildlock is missing.
- **Makefiles:** `BL := $(shell command -v buildlock)`, then `$(BL) cargo build`.
- **CI runners** have the machine to themselves: set `BUILDLOCK_BYPASS=1` (or `config set BYPASS on` on the runner).
- **turbo, nx and other task runners:** wrap the top-level command once. Calls nested inside a running job pass straight through.
- **Tools with their own parallelism:** pass `$BUILDLOCK_WORKERS` explicitly: `jest --maxWorkers=$BUILDLOCK_WORKERS`, `make -j"$BUILDLOCK_WORKERS"`, `cargo build -j "$BUILDLOCK_WORKERS"`, `pytest -n "$BUILDLOCK_WORKERS"`, `go test -p "$BUILDLOCK_WORKERS"`.

## Shells, containers and WSL

- buildlock runs a real program, so it works from bash, zsh, fish or nushell alike. Aliases and shell functions aren't visible to it: use `buildlock bash -ic 'myfunc'`, or `buildlock sh -c 'a && b'` for a command line.
- The queue is per user account: it lives in `~/.cache`. Jobs of other users, of root through `sudo`, or inside containers take no slot, though they still count through load and memory.
- In containers and WSL, `nproc` and `/proc/meminfo` may show the host or the VM: set `CORES` (and keep `.wslconfig`'s memory limit in mind).

## For scripts and tools

These interfaces are stable across versions:

- **`buildlock --status`.** One line per job (`holder none` when nothing runs), then a summary line:
  ```text
  holder pid=1234 age=12s worktree=/path slot=0 class=heavy
  queued pid=1240 age=3s worktree=/path class=heavy
  scheduler running=1/4 next=start light=0/8 idle=yes expected_load=9.00 max=8 light_max=16
  ```
- **`buildlock status --json`** and **`buildlock stats --json`.** Lanes, running and queued jobs and machine metrics; per-command statistics.
- **`buildlock --explain <cmd>`.** Key, samples, profile, class and budget, verdict.
- **The `buildlock: waited Ns` line** on stderr when a job that had to wait starts. A job that starts at once prints nothing, so treat a missing line as 0.
- **The job log.** JSON Lines in `~/.cache/buildlock/jobs-YYYY-MM.jsonl`, one line per finished job: `at`, `end`, `pid`, `cwd`, `class`, `budgetMb`, `waitSeconds`, `runSeconds`, `exit`, `cmd`, `key`, `peakMb`, `budgetSource`, `admission`. `buildlock history --json` prints them.
- **Environment variables.** `BUILDLOCK_CLASS=light|heavy`, `BUILDLOCK_JOB_MEMORY_MB`, `BUILDLOCK_TIMEOUT`, `BUILDLOCK_BYPASS`. For isolated tests: `BUILDLOCK_LOCK_PATH`, `BUILDLOCK_JOB_LOG_DIR`, `BUILDLOCK_CONFIG=` (no config).

## Troubleshooting

- **A job always waits.** `buildlock status` says why, in plain words, for both lanes; `buildlock doctor` shows the limits in effect.
- **"command not found" for something that works in your shell.** It is an alias or a function; see [Shells, containers and WSL](#shells-containers-and-wsl).
- **Settings don't take.** `buildlock config list` shows each value and its source (default, config, quiet, env); `buildlock doctor` points at a broken config file.
- **An agent doesn't use it.** `buildlock agents status`, then restart the agent's session: they read their instructions when a session starts.

## Uninstall

```sh
buildlock uninstall            # the program, its section in agents' global files, its Claude Code rules
buildlock uninstall --purge    # also the config, the job log and the lock files
```

Installed with npm, pnpm or bun, `buildlock uninstall` cleans up the same and then tells you the package manager's command (`npm uninstall -g buildlock`) for the program itself.

Project files keep their section, since it tells agents to run commands directly where buildlock is missing; `buildlock agents uninstall --project` inside a project removes it. `--keep-agents` leaves the agents' files alone.

## Limits

- **Only what goes through it.** A command started without buildlock still counts through load, pressure and memory, but it takes no slot.
- **A scheduler, not a sandbox.** It decides when a job starts. It does not cap a job's CPU or memory once it runs: use cgroups or `systemd-run` for that.
- **Linux only.** It reads `/proc` and relies on `flock` and `setsid`. On macOS there is no `/proc`.

## Development

```sh
bun test                                # scheduler and CLI tests (isolated: fake /proc, temp HOME)
shellcheck bin/buildlock install.sh
scripts/release.sh 0.2.1                # bump, check the changelog, commit and tag
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Releases are published from a `v*` tag by GitHub Actions, which attaches `buildlock`, `install.sh` and their `.sha256` files, with build provenance.

## License

[MIT](LICENSE)
