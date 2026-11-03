# Changelog

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
