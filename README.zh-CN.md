# buildlock

[![CI](https://github.com/Ice-Hazymoon/buildlock/actions/workflows/ci.yml/badge.svg)](https://github.com/Ice-Hazymoon/buildlock/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Ice-Hazymoon/buildlock)](https://github.com/Ice-Hazymoon/buildlock/releases/latest)
[![npm](https://img.shields.io/npm/v/buildlock)](https://www.npmjs.com/package/buildlock)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

整机共享的重任务队列，适用于 Linux 和 WSL 2。在完整构建、类型检查或测试命令前加上 `buildlock`，它会等机器有余力时再原样运行：输出和退出码都不变。

[English](README.md)

适用场景：一台机器同时开着很多终端、worktree 和 AI 编码会话。五个 Claude Code / Codex 会话在同一分钟各自跑 `tsc`、`vitest run` 和构建，足以把一台 32 核机器压进 swap，SSH 都连不上。经过 buildlock 排队后，它们轮流执行；机器有余力时，仍然可以并排跑多个。

```sh
buildlock npm test
buildlock npx tsc --noEmit
buildlock cargo build --release
```

- **只需加一个前缀。** 没有守护进程，没有服务，也不需要配置，整个工具就是一个 bash 脚本。不用排队的任务，buildlock 自己一行字都不输出。
- **按真实余量放行。** 看是否有空槽位、负载、CPU / IO / 内存压力、可用内存，以及刚启动的任务还会再涨多少内存。
- **会学习每条命令。** 按「仓库 + 命令」记录峰值内存和耗时。从第三次运行起，按实测值预留内存，不再靠猜；又小又快的命令会自动进入轻量通道。
- **公平。** 按到达顺序启动。重任务等内存等久了，轻任务会给它把内存留出来，不会被源源不断的小任务饿死。已知耗时很短的任务可以绕过正在等内存的任务先跑；被 buildlock 之外的进程占住的内存也不会让队列永远卡住。
- **透明。** Ctrl-C、Ctrl-Z、密码提示、调整窗口大小都和直接运行时一样；信号只送达命令一次，命令可以先做完清理再退出。
- **教会 AI 编码工具使用它。** `buildlock agents install` 会往 Claude Code、Codex、Gemini CLI、Copilot、opencode、Cursor 等二十来种工具的说明文件里加一小段说明，每个会话自然就会用它。
- **安静时段。** 夜间（或满足你自定义的条件时）少跑一些任务。

## 安装

```sh
curl -fsSL https://github.com/Ice-Hazymoon/buildlock/releases/latest/download/install.sh | bash
```

安装脚本会检查依赖，下载最新版本并校验 sha256，然后放进 `~/.local/bin`；首次安装时会询问是否运行引导设置。参数写在 `bash -s --` 后面：

```sh
curl -fsSL https://github.com/Ice-Hazymoon/buildlock/releases/latest/download/install.sh | bash -s -- --prefix ~/bin --yes
```

| 参数 | |
| --- | --- |
| `--prefix DIR` | 安装目录（默认 `~/.local/bin`，也可用 `$BUILDLOCK_PREFIX`） |
| `--version vX.Y.Z` | 指定版本；`main` 表示开发版 |
| `--yes` | 不提问，也不运行引导设置 |
| `--no-setup` | 不询问引导设置 |
| `--from FILE` | 安装本地的 `bin/buildlock` |
| `--force` | 目标位置是软链接、或者不是 buildlock 的文件时，也照样替换 |

也可以从 npm 安装（包里就是同一个脚本，运行时不需要 Node.js）：

```sh
npm install -g buildlock      # 或者 pnpm add -g buildlock、bun add -g buildlock
```

npm 装的版本用 `npm install -g buildlock@latest` 升级；`buildlock update` 和 `buildlock uninstall` 会告诉你当初安装它的包管理器该用哪条命令。`npx buildlock …` 也能用，但每次调用都要解析一遍包，所以给 AI 工具和脚本用的话请全局安装。

要给机器上所有用户安装，就装到 root 拥有的目录，用 `sudo bash` 运行（`... | sudo bash -s -- --prefix /usr/local/bin --yes`），之后用 `sudo buildlock update` 升级；`buildlock setup` 和 `buildlock agents install` 仍以你自己的身份运行。

**依赖：** Linux 或 WSL 2、bash 5、util-linux 2.31+（`flock`、`setsid --wait`）、procps、GNU coreutils，现在的发行版都满足。有 `/proc/pressure`（内核 4.20+）时会用上压力指标。只有写入 Claude Code 权限设置时才需要 `python3`。

升级用 `buildlock update`，卸载用 `buildlock uninstall`（见[卸载](#卸载)）。升级通过重命名替换文件，正在运行或排队的任务不受影响。

## 快速开始

```sh
buildlock setup            # 为这台机器设定上限、安静时段，并配置 AI 编码工具
buildlock npm run build    # 任意重任务
buildlock status           # 在跑什么、谁在排队、为什么等待
```

不需要等待的任务，buildlock 什么都不输出。需要排队的，会在 stderr 提示一次：`buildlock: waiting (all 4 heavy slots are busy); starts on its own`，开始运行时再打印 `buildlock: waited 37s (slot 2 of 4)`。除此之外的输出都来自命令本身。

### 怎么确认它在工作

```sh
buildlock doctor
BUILDLOCK_SLOTS=1 buildlock sleep 30 &
buildlock --timeout 5 true    # 提示等待（唯一的重任务槽位被占用），5 秒后放弃，退出码 73
```

## 让 AI 编码工具学会使用

```sh
buildlock agents install             # 全局：这台机器上的所有项目
buildlock agents install --project   # 当前仓库，并写入这个项目自己的命令
buildlock agents status
buildlock agents uninstall
```

全局安装会找出机器上装了哪些 AI 编码工具，往各自的全局说明文件（也就是它们的「全局记忆」）里写入一段带标记的说明。这段说明告诉每个会话（包括子代理）：

- 完整构建、类型检查、测试套件和全仓库 lint 通过 `buildlock` 运行，其他命令一律直接运行；
- 排队中的命令会自己启动：给它足够长的超时，或者放到后台、结束后再读结果；不要重复启动，也不要轮询；
- 退出码 73 表示等待超时、命令根本没有运行；
- 如果机器上没有 `buildlock`（比如同步到另一台机器的配置文件），就直接运行命令。

项目安装写入仓库自己的 `AGENTS.md`。几乎所有工具都读这个文件，别人克隆后也能拿到。它会读取 `package.json`（根据锁文件或 `packageManager` 识别 bun / pnpm / yarn / npm）、`Cargo.toml`、`go.mod`、pytest（含 uv、poetry）、Makefile、justfile、Gradle、Maven，把这个项目真实的命令列出来；并说明在没有 buildlock 的机器上直接运行这些命令，不要去安装它。

只有两个工具光有 `AGENTS.md` 还不够，而且只会写入项目里已有的文件：

- **Claude Code** 只在项目没有自己的 `CLAUDE.md` 时才读 `AGENTS.md`。已有的 `CLAUDE.md` 也会加上这段说明，除非它用 `@AGENTS.md` 引入了 `AGENTS.md` 或者是指向它的软链接。buildlock 不会新建 `CLAUDE.md`，那样反而会让 Claude 看不到 `AGENTS.md`。
- **Gemini CLI** 读 `GEMINI.md`。已有的会加上这段说明；`--target gemini` 时会新建一个。

在仓库的任何子目录下运行都可以，文件始终写到仓库根目录。它还会删掉 0.1 版写的那些按工具分开的副本（`.cursor/rules/buildlock.mdc`、`.github/copilot-instructions.md` 等），因为这些工具同样会读 `AGENTS.md`。

| 工具 | 全局文件 |
| --- | --- |
| Claude Code | `~/.claude/CLAUDE.md` |
| Codex CLI | `~/.codex/AGENTS.md`（有 `AGENTS.override.md` 时写入它） |
| Gemini CLI、Antigravity | `~/.gemini/GEMINI.md` |
| opencode | `~/.config/opencode/AGENTS.md` |
| Qwen Code | `~/.qwen/QWEN.md` |
| GitHub Copilot（CLI、VS Code） | `~/.copilot/copilot-instructions.md` |
| Devin（Windsurf） | `~/.config/devin/AGENTS.md`（`~/.claude/CLAUDE.md` 里已有说明时跳过，Devin 也会读它） |
| Kiro | `~/.kiro/steering/buildlock.md` |
| Factory Droid | `~/.factory/AGENTS.md` |
| Pi | `~/.pi/agent/AGENTS.md` |
| Kimi Code | `~/.kimi-code/AGENTS.md` |
| Grok Build | `~/.grok/rules/buildlock.md` |
| Amp、Crush | `~/.config/AGENTS.md` |
| Zed | `~/.config/zed/AGENTS.md` |
| Junie | `~/.junie/AGENTS.md` |
| Kilo Code | `~/.config/kilo/AGENTS.md` |
| Goose | `~/.config/goose/AGENTS.md` |
| Cline | `~/.cline/rules/buildlock.md` |
| Augment（Auggie） | `~/.augment/rules/buildlock.md` |
| Continue | `~/.continue/rules/buildlock.md` |
| Cursor | 没有全局文件（用户规则保存在应用里）；项目里通过 `AGENTS.md` 拿到 |

各工具自己的路径变量都会被遵循，例如 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GEMINI_CLI_HOME`、`COPILOT_HOME`、`XDG_CONFIG_HOME`。

- **选择工具：** `--target` 可取 `auto`（检测到的，默认）、`all`、`none`，或 `claude,codex` 这样的列表。命令在 PATH 上、或者主目录里有它自己的文件，才算检测到；只有一个 `skills/` 的目录（技能安装器会创建）不算。交互模式下会列出所有工具，已检测到的预先勾选。`--dry-run` 只预览改动。
- **只动自己那一段：** 不改你原有的内容。重复执行会原地更新那一段，`uninstall` 只删掉它加的部分，连同它建的、现已为空的目录。
- **已提到 buildlock 的文件：** 如果文件里已经用你自己的话写过 buildlock，就保持原样，除非加 `--force`。
- **共享文件：** 多个工具可能读同一个文件，`CLAUDE.md` 也可能是指向 `AGENTS.md` 的软链接。每个实际文件只写一次，软链接保持是软链接。
- **Claude Code 权限：** Claude Code 不会拿 `npm test` 的规则去匹配 `buildlock npm test`，所以全局安装会在 `~/.claude/settings.json` 里补上对应的规则：已放行的构建或测试命令（`Bash(npm test:*)`）加上 buildlock 后照样放行（`Bash(buildlock npm test:*)`），所有 deny / ask 规则加上 buildlock 后也照样生效。另外放行只读的 `buildlock status / explain / history / stats`。不会添加 `Bash(buildlock:*)`，那样任何命令都能跳过确认。新增规则后重新运行一次安装即可；`--no-permissions` 表示不改设置。

## 调度规则

1. **两条通道，按序排队。** 任务按到达顺序排队，分属两条通道。重任务占重任务槽位；轻任务（约 2 GB、3 分钟以内；通常一分钟内跑完的命令放宽到 `LIGHT_SHORT_MAX_MB`，大内存机器上是 5 GB，超过 2 GB 的仍遵守启动间隔）有自己的槽位池，不用排在长构建后面。
2. **按余量放行。** 什么都没在跑时，排在最前的任务直接开始。已有任务在跑时，要同时满足以下条件才能启动：
   - 有空槽位（`cores / WORKERS` 个重任务槽位，`cores / 4` 个轻任务槽位）；
   - 距上一个重任务启动已过 20 秒，让它的负载先显现出来；
   - 负载低于 `cores × 1.25`，CPU / IO / 内存压力都在上限以下；
   - swap 没有快用完；
   - 预留本任务的内存、以及刚启动的任务还会再涨的内存之后，仍剩 `RESERVE_MEMORY_MB`。
3. **内存预算。** 每个任务的峰值内存和耗时都写入日志 `~/.cache/buildlock/jobs-YYYY-MM.jsonl`。同一仓库的同一条命令跑满三次后，预算取 p90 峰值 × 1.25 + 256 MB；在那之前用 `--memory`，或默认值：重任务取内存的四分之一（最多 8 GB），轻任务 1.5 GB。同一仓库的各个 worktree 共享历史。
4. **不会饿死。** 重任务等内存超过一分钟后，轻任务也要给它把预算留出来，不能把腾出来的内存全部占走。
5. **回填（backfill）。** 排在最前的重任务在等内存时，后面的重任务如果自己能通过所有检查（槽位、负载、压力、留足预留的内存），并且学到的耗时（至少 3 次运行的 p90）不超过 `BACKFILL_MAX_SECONDS`（2 分钟），就可以先跑。没有历史的命令从不回填；候选者之间仍按到达顺序，只有最早的那个能尝试。等待超过 `HEAVY_STARVE_SECONDS`（一分钟）后，等内存的任务受到保护，回填停止，除非它已经没指望：没有任务在启动爬升，而且连下面的放宽检查也放不下它，只有 buildlock 之外释放内存才帮得上忙。同一时间只有一个回填任务在跑，它跑的期间等待的任务一直受保护，所以任意两次回填之间它都能得到一次干净的检查。
6. **内存被别处占用。** 重任务等内存满 `MEMORY_RELAX_SECONDS`（5 分钟），两条通道都没有任务在启动爬升，而且即使 buildlock 在跑的任务全部结束也留不足完整预留，说明它等的是 buildlock 管不到的内存（开发服务器、浏览器、编辑器）。这时它只需在预算之外留出 `CRITICAL_MEMORY_MB`，不再要求 `RESERVE_MEMORY_MB`。`status` 和 `explain` 会说明何时适用；设为 `0` 关闭。
7. **机器空闲时：** 不再等启动间隔，最多可以跑 `cores / 4` 个重任务。内存检查始终生效。
8. **内存告急时：** 可用内存低于总内存的十分之一（最多 3 GB），或内存压力（PSI full）过高时，什么都不启动，哪怕只有一个任务。
9. **嵌套调用：** 任务内部再次调用 buildlock 会直接放行，不会死锁；即使 `env -i`、turbo 严格环境模式之类的包装丢掉了 `BUILDLOCK_HELD` 也一样。把环境变量拷给其他进程，并不能让它们插队。

**卡住的任务。** 在跑的任务如果在最近 `STALL_SECONDS`（30 分钟）里整个进程树只用了不到 `STALL_CPU_SECONDS`（5 秒）的 CPU（比如卡在某个 worker 上的测试运行器），`status` 和 `doctor` 会把它标为 `stalled`。buildlock 不会停掉它：它可能在等什么、之后还会继续，所以仍占着槽位；通过守护进程干活的构建（Gradle、Bazel、Docker）看起来也是这样。

**调用方没了。** 排队中的任务如果调用方退出了（shell 被杀、AI 工具的调用超时），它会以退出码 74 离开队列，而不是之后白跑一趟：它启动时的父进程号变了，无论是被 init 还是被 `systemd --user` 这类 subreaper 接管。已经在跑的任务不受影响。`BUILDLOCK_KEEP_ORPHANS=1` 会让这类任务继续排队；用 `nohup`、`setsid` 启动的，或输出单独重定向到普通文件的（`buildlock make > build.log &`）也一样，因为之后还有人能读到结果；与调用方共用的输出（比如 AI 工具调用的输出文件）不算。

**命令本身。** 在终端里，命令和 buildlock 在同一个进程组，终端照常作用于它：Ctrl-C、Ctrl-Z、Ctrl-\、调整窗口大小，以及 sudo / ssh / gpg 通过 `/dev/tty` 的密码提示。循环里按 Ctrl-C 会停掉整个循环。在其他场合（AI 编码工具、CI、管道），命令有自己的会话，buildlock 把 HUP、INT、QUIT、TERM 转发给它的整个进程树，只发一次；命令可以先清理再退出，第二次信号才强制结束。命令退出后，它在该会话里留下的进程也会被停掉，之后才释放槽位。buildlock 自己被 `kill -9` 时，看门狗会在几秒内停掉留下的命令。排队时按 Ctrl-Z，后面的任务会先走。

buildlock 会导出 `BUILDLOCK_WORKERS`（一个重任务预计占用的核数），供你自己的脚本使用（`make -j"$BUILDLOCK_WORKERS"`、`vitest --maxWorkers=$BUILDLOCK_WORKERS`）。设 `EXPORT_WORKERS=on` 还会导出 `VITEST_MAX_WORKERS`；默认关闭，因为 Vitest 会让这个变量覆盖项目自己的设置，包括 `fileParallelism: false`。

## 命令一览

| 命令 | |
| --- | --- |
| `buildlock <cmd> [args]` | 有余力时运行命令 |
| `buildlock run [--light\|--heavy] [--memory SIZE] [--timeout S] -- <cmd>` | 同上，带选项 |
| `buildlock status [--watch] [--json]` | 在跑和排队的任务，以及下一个为什么等 |
| `buildlock explain <cmd>` | 不运行，只说明这条命令会怎样调度 |
| `buildlock history [-n N] [--here] [--failed] [--days N] [--json]` | 最近的任务 |
| `buildlock stats [--days N] [--here] [--json]` | 每条命令的耗时、内存预算、通道和等待 |
| `buildlock config` | 交互式设置；另有 `list`、`get`、`set`、`unset`、`edit`、`path` |
| `buildlock quiet [on\|off\|auto]` | 安静模式 |
| `buildlock agents [install\|uninstall\|status\|print]` | AI 编码工具的说明 |
| `buildlock setup` | 引导设置 |
| `buildlock doctor` | 检查依赖、安装、配置、当前上限和 AI 工具 |
| `buildlock completion bash\|zsh\|fish` | 命令补全 |
| `buildlock update [--check]` / `uninstall [--purge]` | 维护 |

每个命令都支持 `--help`。名字与子命令相同的程序（`status`、`run`、`log` 等）用 `buildlock run -- status` 运行。`--memory` 接受 MB 数或 `512M`、`2G` 这样的写法。

- **退出码：** 与命令本身一致。
- **73：** 等待超时（`--timeout` / `BUILDLOCK_TIMEOUT`），命令没有运行。
- **74：** 排队时调用方退出了，命令没有运行。
- **126 / 127：** 不可执行 / 命令不存在（排队前就会检查）。
- **129 / 130 / 131 / 143：** 排队时被 HUP / INT / QUIT / TERM 取消。

命令补全：

```sh
echo 'eval "$(buildlock completion bash)"' >> ~/.bashrc
echo 'source <(buildlock completion zsh)' >> ~/.zshrc   # 放在 compinit 之后
buildlock completion fish > ~/.config/fish/completions/buildlock.fish
```

## 配置

- **查看与修改：** `buildlock config` 打开交互菜单；`buildlock config list` 列出全部设置、当前值和来源。
- **配置文件：** 设置保存在 `~/.config/buildlock/config`（或 `$BUILDLOCK_CONFIG`）。
- **临时覆盖：** 用环境变量 `BUILDLOCK_<KEY>` 设置单次调用，优先级高于配置文件。

```sh
buildlock config set SLOTS 2
buildlock config set RESERVE_MEMORY_MB 4G
buildlock config set QUIET_HOURS 00:00-08:00
buildlock quiet on        # 强制进入安静模式，直到执行 buildlock quiet auto
```

| 设置 | 默认值 | |
| --- | --- | --- |
| `SLOTS` | cores / `WORKERS` | 机器忙时同时运行的重任务数 |
| `WORKERS` | 8（不超过核数） | 一个重任务预计占用的核数 |
| `EXPORT_WORKERS` | off | 同时导出 `VITEST_MAX_WORKERS=WORKERS`（会覆盖项目自己的 Vitest worker 设置） |
| `MAX_JOBS` | cores / 4 | 机器空闲时同时运行的重任务数（只设了 `SLOTS` 时等于 `SLOTS`） |
| `LIGHT_SLOTS` | cores / 4 | 同时运行的轻任务数 |
| `RESERVE_MEMORY_MB` | 内存 / 8，最多 6144 | 放行一个任务后仍要保留的内存 |
| `CRITICAL_MEMORY_MB` | 内存 / 10，最多 3072 | 可用内存低于它时什么都不启动 |
| `DEFAULT_MEMORY_MB` | 内存 / 4，最多 8192 | 没有历史的重任务的内存预算 |
| `START_GAP` | 20 | 两次重任务启动之间的秒数 |
| `LIGHT_SHORT_MAX_MB`、`LIGHT_SHORT_MAX_SECONDS` | 内存 / 8（最多 5120）、60 | 学到的内存不超过前者、耗时不超过后者的命令进入轻量通道 |
| `BACKFILL_MAX_SECONDS` | 120 | 学到的耗时在此之内的重任务，可以先于等内存的重任务启动（0：不回填） |
| `MEMORY_RELAX_SECONDS` | 300 | 等 buildlock 之外占用的内存这么久后，重任务只需在预算外留出 `CRITICAL_MEMORY_MB`（0：不放宽） |
| `STALL_SECONDS`、`STALL_CPU_SECONDS` | 1800、5 | 在跑的任务在这段时间内用的 CPU 少于这么多秒，就显示为卡住 |
| `KEEP_ORPHANS` | auto | `on`：调用方退出后仍运行排队中的任务；`auto`：在 `nohup`、`setsid` 下或输出单独写进文件时这样做 |
| `LOAD_MAX` | cores × 1.25 | 与其他任务并排启动时的负载上限 |
| `CORES` | `nproc` | 按多少核来规划（容器和 WSL 里建议设置） |
| `BYPASS` | off | 命令直接运行，不排队 |
| `QUIET_HOURS` | | 如 `00:00-08:00`、`22-06`、`12-13,22-07` |
| `QUIET_SLOTS`、`QUIET_LIGHT_SLOTS` | 正常值的一半 | 安静时段同时运行的任务数 |
| `QUIET_WORKERS`、`QUIET_MAX_JOBS` | `WORKERS`、`QUIET_SLOTS` | 安静时段的其他上限 |

其余设置（压力上限、轻任务通道的上限、内存增长观察期、日志目录、是否学习）见 `buildlock config list`。内存大小可以带单位（`512M`、`2G`）。

安静时段内，每个 `QUIET_<KEY>` 会替代对应的 `<KEY>`；没有单独设置时，安静模式同时运行的任务数减半。安静时段的槽位数同样限制空闲时的放行上限，机器空闲时也保持安静。

配置文件本身是 bash，`buildlock config` 只改写标记之间的部分，标记之后可以写你自己的逻辑，比如跟随 CPU 电源模式切换安静模式：

```bash
if read -r boost < /sys/devices/system/cpu/cpufreq/boost 2>/dev/null && [[ $boost == 0 ]]; then
    BUILDLOCK_QUIET=on
fi
[[ -n "${CI:-}" ]] && BUILDLOCK_BYPASS=1   # CI 独占机器，不排队
```

配置文件在每次调用时独立运行，只取回其中的 `BUILDLOCK_*` 设置：它打印的内容进入 stderr，其中的 `exit`、`cd`、修改 `IFS` 都影响不到 buildlock 和命令。写错也不会让构建停下：运行出错的那行会被跳过（每次调用都会显示错误，`buildlock doctor` 也会列出）；语法错误会让文件在出错处中断，后面的设置在修好之前都不生效（`buildlock doctor` 同样会报告）。`SLOTS=abc` 这类无法使用的值会回退到默认值并给出警告。`buildlock config set` 会直接拒绝错误的值；如果标记之后你自己的代码仍会覆盖刚设置的值，它也会提醒。这个文件在每条命令前都会运行，请保持它足够快。更多例子见 [examples/config](examples/config)。

## 在脚本、Makefile 和 CI 中使用

- **package.json 脚本**在没有 buildlock 的机器上也能用：`"test": "$(command -v buildlock) vitest run"`，缺少 buildlock 时就是普通的 `vitest run`。
- **Makefile：** `BL := $(shell command -v buildlock)`，然后 `$(BL) cargo build`。
- **CI 机器**独占资源：设置 `BUILDLOCK_BYPASS=1`（或在该机器上 `config set BYPASS on`）。
- **turbo、nx 等任务编排工具：** 只包最外层命令即可，任务内部的嵌套调用会直接放行。
- **自带并行度的工具：** 显式传入 `$BUILDLOCK_WORKERS`：`jest --maxWorkers=$BUILDLOCK_WORKERS`、`make -j"$BUILDLOCK_WORKERS"`、`cargo build -j "$BUILDLOCK_WORKERS"`、`pytest -n "$BUILDLOCK_WORKERS"`、`go test -p "$BUILDLOCK_WORKERS"`。

## Shell、容器和 WSL

- buildlock 运行的是真实程序，在 bash、zsh、fish、nushell 里用法都一样。它看不到 shell 的别名和函数：用 `buildlock bash -ic 'myfunc'`；整条命令行用 `buildlock sh -c 'a && b'`。
- 队列按用户账户划分，保存在 `~/.cache`。其他用户、通过 `sudo` 以 root 运行、或者在容器里运行的任务不占槽位，但仍会体现在负载和内存里。
- 容器和 WSL 里，`nproc` 和 `/proc/meminfo` 可能显示的是宿主机或虚拟机：请设置 `CORES`（并留意 `.wslconfig` 的内存限制）。

## 给脚本和工具用的接口

这些接口在各版本之间保持稳定：

- **`buildlock --status`：** 每个任务一行（没有任务时是 `holder none`），最后是汇总行：
  ```text
  holder pid=1234 age=12s worktree=/path slot=0 class=heavy
  holder pid=1236 age=36012s worktree=/path slot=1 class=heavy stalled=35400s
  queued pid=1240 age=3s worktree=/path class=heavy
  scheduler running=2/4 next=start light=0/8 idle=yes expected_load=9.00 max=8 light_max=16 relaxed=no backfill=no
  ```
  `stalled=` 只出现在卡住的任务上。`relaxed=yes` 表示重任务的结论来自放宽的内存检查，`backfill=yes` 表示短的重任务可以绕过等内存的任务先跑；结论按那个任务自己的预算计算。
- **`buildlock status --json`、`buildlock stats --json`：** 通道（重任务通道带 `memoryRelaxed` 和 `backfill`）、在跑的任务（带 `stalledSeconds`，没卡住时为 `null`）、排队的任务、机器指标；每条命令的统计、等待原因和 `admissions`（按放行方式统计的启动次数）。
- **`buildlock --explain <cmd>`：** key、样本数、画像、通道和预算、结论，然后是 `backfill:`（能否回填，不能时说明原因）和 `relaxed:`（等满 `MEMORY_RELAX_SECONDS` 后放宽的内存检查会怎么判）。
- **stderr 上的 `buildlock: waited Ns`：** 需要等待的任务开始时打印。不用等待的任务什么都不打印，解析时把缺失当作 0。
- **任务日志：** `~/.cache/buildlock/jobs-YYYY-MM.jsonl`，JSON Lines，每个结束的任务一行：`at`、`end`、`pid`、`cwd`、`class`、`budgetMb`、`waitSeconds`、`runSeconds`、`exit`、`cmd`、`key`、`peakMb`、`budgetSource`、`admission`（`free`；空闲快速通道为 `idle`；`backfill`；`memory-relaxed`），等过的任务还有 `waitReasons`（按阻塞原因统计的等待秒数：`slot`、`memory`、`memory-pressure`、`gap`、`load`、`cpu`、`io`、`swap`、`order`）。`buildlock history --json` 会原样输出；`buildlock stats` 汇总各原因。
- **环境变量：** `BUILDLOCK_CLASS=light|heavy`、`BUILDLOCK_JOB_MEMORY_MB`、`BUILDLOCK_TIMEOUT`、`BUILDLOCK_BYPASS`。隔离测试用：`BUILDLOCK_LOCK_PATH`、`BUILDLOCK_JOB_LOG_DIR`、`BUILDLOCK_CONFIG=`（不读配置）。

## 常见问题

- **任务一直在等：** `buildlock status` 会用白话说明两条通道各在等什么；`buildlock doctor` 显示当前生效的上限。
- **某个任务占着槽位好几个小时：** 进程不再用 CPU 时，`buildlock status` 和 `buildlock doctor` 会把它标为 `stalled`；确认后用 `kill <pid>` 停掉（buildlock 会把信号转给整个命令）。
- **在 shell 里能用的命令报「command not found」：** 那是别名或函数，见 [Shell、容器和 WSL](#shell容器和-wsl)。
- **设置不生效：** `buildlock config list` 会显示每个值及其来源（default、config、quiet、env）；配置文件出错时 `buildlock doctor` 会指出来。
- **AI 工具没有用它：** 先看 `buildlock agents status`，再重启该工具的会话，它们只在会话开始时读取说明文件。

## 卸载

```sh
buildlock uninstall            # 程序本身、各工具全局文件里的说明、它添加的 Claude Code 规则
buildlock uninstall --purge    # 另外删除配置、任务日志和锁文件
```

用 npm、pnpm 或 bun 安装的，`buildlock uninstall` 照样做清理，最后提示你用包管理器的命令（如 `npm uninstall -g buildlock`）删掉程序本身。

项目文件里的说明会保留，因为它告诉 AI 工具在没有 buildlock 的机器上直接运行命令；要删掉的话，在项目里运行 `buildlock agents uninstall --project`。`--keep-agents` 表示不动 AI 工具的文件。

## 局限

- **只管经过它的命令。** 不经过 buildlock 的命令仍会体现在负载、压力和内存里，但不占槽位。
- **只是调度器，不是沙箱。** 它决定任务何时启动，不限制运行中的任务能用多少 CPU 或内存（那是 cgroups / `systemd-run` 的事）。
- **仅支持 Linux（含 WSL 2）。** 它读取 `/proc`，依赖 `flock` 和 `setsid`。macOS 没有 `/proc`。

## 开发

```sh
bun test                                # 调度器和 CLI 测试（隔离环境：假的 /proc、临时 HOME）
shellcheck bin/buildlock install.sh
scripts/release.sh 0.2.1                # 升版本号、检查 CHANGELOG、提交并打 tag
```

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。推送 `v*` tag 后，GitHub Actions 会发布版本，附上 `buildlock`、`install.sh` 及其 `.sha256`，并带构建来源证明。

## 许可证

[MIT](LICENSE)
