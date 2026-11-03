# buildlock

一台机器范围的重任务队列。在完整构建、类型检查或测试命令前加上 `buildlock`，它会等到机器有余力时再原样运行：输出和退出码都不变。

[English](README.md)

适用场景：一台机器同时开着很多终端、worktree 和 AI 编码会话。五个 Claude Code / Codex 会话在同一分钟各自跑 `tsc`、`vitest run` 和构建，足以把一台 32 核机器压进 swap，SSH 都连不上。经过 buildlock 排队后，它们轮流执行；机器有余力时，仍然可以并排跑多个。

```sh
buildlock npm test
buildlock npx tsc --noEmit
buildlock cargo build --release
```

- **只需加一个前缀。** 没有守护进程，没有服务，也不需要配置。整个工具就是一个 bash 脚本。
- **按真实余量放行。** 看是否有空槽位、负载、CPU / IO / 内存压力、可用内存，以及刚启动的任务还会再涨多少内存。
- **会学习每条命令。** 按「仓库 + 命令」记录峰值内存和耗时。从第三次运行起，按实测值预留内存，不再靠猜；又小又快的命令会自动进入轻量通道。
- **公平。** 按到达顺序启动，重任务不会被源源不断的小任务饿死。
- **教会 AI 编码工具使用它。** `buildlock agents install` 会往 Claude Code、Codex、Gemini CLI、Cursor、opencode、Copilot 等工具的说明文件里加一小段说明，每个会话自然就会用它。
- **安静时段。** 夜间（或满足你自定义的条件时）少跑一些任务。

## 安装

```sh
curl -fsSL https://raw.githubusercontent.com/Ice-Hazymoon/buildlock/main/install.sh | bash
```

安装脚本会检查依赖，下载最新版本并校验 sha256，然后放进 `~/.local/bin`，最后询问是否运行引导设置。参数写在 `bash -s --` 后面：

```sh
curl -fsSL https://raw.githubusercontent.com/Ice-Hazymoon/buildlock/main/install.sh | bash -s -- --prefix /usr/local/bin --yes
```

**依赖：** Linux 或 WSL 2、bash 5、util-linux 2.31+（`flock`、`setsid --wait`）、procps、GNU coreutils，现在的发行版都满足。有 `/proc/pressure`（内核 4.20+）时会用上压力指标。只有写入 Claude Code 权限设置时才需要 `python3`。

升级用 `buildlock update`，卸载用 `buildlock uninstall`。升级通过重命名替换文件，正在运行或排队的任务不受影响。

## 快速开始

```sh
buildlock setup            # 为这台机器设定上限、安静时段，并配置 AI 编码工具
buildlock npm run build    # 任意重任务
buildlock status           # 在跑什么、谁在排队、为什么等待
```

需要排队的命令会在 stderr 提示一次：`buildlock: waiting (all 4 slots busy); starts on its own`；开始运行时打印 `buildlock: waited 37s (slot 1 of 4)`。除此之外的输出都来自命令本身。

## 让 AI 编码工具学会使用

```sh
buildlock agents install             # 全局：这台机器上的所有项目
buildlock agents install --project   # 当前仓库，并写入这个项目自己的命令
buildlock agents status
buildlock agents uninstall
```

全局安装会找出机器上装了哪些 AI 编码工具，往各自的全局说明文件（也就是它们的「全局记忆」）里写入一段带标记的说明。说明告诉每个会话（包括子代理）：完整构建、类型检查、测试套件要通过 `buildlock` 运行；快速命令不要包；排队中的任务会自己启动，不要轮询。

项目安装则写进仓库自己的文件，别人克隆后也能拿到。它会读取 `package.json`（自动识别 bun / pnpm / yarn / npm）、`Cargo.toml`、`go.mod`、pytest、Makefile、Gradle、Maven，把这个项目真实的命令列出来，例如 `buildlock bun run typecheck`。

支持的工具：Claude Code、Codex CLI、Gemini CLI、opencode、Qwen Code、Cursor、Windsurf、GitHub Copilot、Kiro、Factory Droid、Pi、Kimi Code、Grok Build（具体文件路径见[英文说明](README.md#teach-your-coding-agents)）。

- **选择工具：** `--target` 可取 `auto`（检测到的，默认）、`all`、`none`，或 `claude,codex` 这样的列表。交互模式下会列出所有工具，已检测到的预先勾选。`--dry-run` 只预览改动。
- **只动自己那一段：** 不改你原有的内容。重复执行会原地更新那一段，`uninstall` 只删掉它加的部分。
- **已提到 buildlock 的文件：** 如果文件里已经用你自己的话写过 buildlock，就保持原样，除非加 `--force`。
- **共享文件：** 多个工具共用 `AGENTS.md`，`CLAUDE.md` 也可能是指向它的软链接或只写了 `@AGENTS.md`。每个实际文件只写一次，软链接保持是软链接。
- **Claude Code 权限：** 只自动放行只读的 `buildlock status / explain / history / stats`。不会放行 `Bash(buildlock:*)`，因为 buildlock 会执行跟在它后面的任意命令，被包起来的命令应当照常弹出权限确认。

## 调度规则

1. **两条通道，按序排队。** 任务按到达顺序排队，分属两条通道。重任务占重任务槽位；轻任务（约 2 GB、3 分钟以内）有自己的槽位池，不用排在长构建后面。
2. **按余量放行。** 什么都没在跑时，排在最前的任务直接开始。已有任务在跑时，要同时满足以下条件才能启动：
   - 有空槽位；
   - 距上一个重任务启动已过 20 秒，让它的负载先显现出来；
   - 负载和压力都在上限以下；
   - swap 没有快用完；
   - 预留本任务的内存、以及刚启动的任务还会再涨的内存之后，仍剩 `RESERVE_MEMORY_MB`。
3. **内存预算。** 每个任务的峰值内存和耗时都写入日志 `~/.cache/buildlock/jobs-YYYY-MM.jsonl`。同一仓库的同一条命令跑满三次后，预算取 p90 峰值 × 1.25 + 256 MB；在那之前用 `--memory`，或默认值（重任务 8 GB，轻任务 1.5 GB）。同一仓库的各个 worktree 共享历史。
4. **机器空闲时：** 不再等启动间隔，最多可以跑 `cores / 4` 个重任务。内存检查始终生效。
5. **内存告急时：** 可用内存低于 3 GB，或内存严重卡顿时，什么都不启动，哪怕只有一个任务。
6. **嵌套调用：** 任务内部再次调用 buildlock 会直接放行，不会死锁；把环境变量拷给其他进程，并不能让它们插队。

## 配置

- **查看与修改：** `buildlock config` 打开交互菜单；`buildlock config list` 列出全部设置、当前值和来源。
- **配置文件：** 设置保存在 `~/.config/buildlock/config`。
- **临时覆盖：** 用环境变量 `BUILDLOCK_<KEY>` 设置单次调用，优先级高于配置文件。

```sh
buildlock config set SLOTS 2
buildlock config set QUIET_HOURS 00:00-08:00
buildlock quiet on        # 强制进入安静模式，直到执行 buildlock quiet auto
```

安静时段内，每个 `QUIET_<KEY>` 会替代对应的 `<KEY>`。配置文件本身是 bash，`buildlock config` 只改写标记之间的部分，标记之后可以写你自己的逻辑，比如跟随 CPU 电源模式切换安静模式：

```bash
if read -r boost < /sys/devices/system/cpu/cpufreq/boost 2>/dev/null && [[ $boost == 0 ]]; then
    BUILDLOCK_QUIET=on
fi
[[ -n "${CI:-}" ]] && BUILDLOCK_BYPASS=1   # CI 独占机器，不排队
```

配置文件写错不会让构建停下：出错的那行会被忽略，`buildlock doctor` 会指出问题所在。

## 命令一览

`status [--watch] [--json]`、`explain`、`history`、`stats`、`config`、`quiet`、`agents`、`setup`、`doctor`、`completion bash|zsh`、`update`、`uninstall`。每个命令都支持 `--help`。

- **退出码：** 与命令本身一致。
- **73：** 等待超时（`--timeout`）。
- **127：** 命令不存在（排队前就会检查）。
- **129 / 130 / 143：** 被 HUP / INT / TERM 取消。

## 局限

- **只管经过它的命令。** 不经过 buildlock 的命令仍会体现在负载、压力和内存里，但不占槽位。
- **只是调度器，不是沙箱。** 它决定任务何时启动，不限制运行中的任务能用多少 CPU 或内存（那是 cgroups / `systemd-run` 的事）。
- **仅支持 Linux（含 WSL 2）。**

## 许可证

[MIT](LICENSE)
