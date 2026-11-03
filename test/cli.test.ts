import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const script = process.env.BUILDLOCK_SCRIPT_UNDER_TEST ?? resolve(import.meta.dirname, '../bin/buildlock');
const installer = resolve(import.meta.dirname, '../install.sh');
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

/** An isolated HOME with an idle fake /proc, its own lock, config and job log. */
function sandbox(extra: Record<string, string> = {}) {
    const root = mkdtempSync(resolve(tmpdir(), 'buildlock-cli-'));
    roots.push(root);
    const home = resolve(root, 'home');
    const proc = resolve(root, 'proc');
    mkdirSync(home, { recursive: true });
    mkdirSync(resolve(proc, 'pressure'), { recursive: true });
    writeFileSync(resolve(proc, 'loadavg'), '1.00 1.00 1.00 1/100 1\n');
    writeFileSync(resolve(proc, 'meminfo'), 'MemTotal: 64000000 kB\nMemAvailable: 40960000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n');
    for (const name of ['cpu', 'memory', 'io']) {
        writeFileSync(resolve(proc, 'pressure', name), 'some avg10=0 avg60=0 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0\n');
    }
    const env: Record<string, string> = {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: home,
        LANG: 'C.UTF-8',
        NO_COLOR: '1',
        COLUMNS: '160',
        BUILDLOCK_LOCK_PATH: resolve(root, 'lock/buildlock.lock'),
        BUILDLOCK_PROC_ROOT: proc,
        BUILDLOCK_CORES: '16',
        BUILDLOCK_START_GAP: '0',
        BUILDLOCK_CONFIG: resolve(home, '.config/buildlock/config'),
        BUILDLOCK_JOB_LOG_DIR: resolve(root, 'joblog'),
        ...extra,
    };
    return { root, home, env, config: env.BUILDLOCK_CONFIG, cwd: home };
}

function run(args: string[], env: Record<string, string>, cwd?: string) {
    const result = spawnSync(script, args, { env, cwd, encoding: 'utf8', timeout: 10_000 });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function finished(child: ReturnType<typeof spawn>, timeoutMs = 6_000) {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    if (child.exitCode !== null || child.signalCode !== null) return { code: child.exitCode, stdout, stderr };
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    try {
        const [code] = await once(child, 'close') as [number | null];
        return { code, stdout, stderr };
    } finally {
        clearTimeout(timer);
    }
}

async function waitFor(path: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
        if (existsSync(path)) return;
        await Bun.sleep(10);
    }
    throw new Error(`Timed out waiting for ${path}`);
}

test('version and help', () => {
    const { env } = sandbox();
    expect(run(['--version'], env).stdout).toMatch(/^buildlock \d+\.\d+\.\d+\n$/);
    const help = run([], env);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('buildlock <command> [args...]');
    for (const sub of ['run', 'status', 'history', 'stats', 'config', 'quiet', 'agents', 'doctor', 'completion']) {
        expect(run([sub, '--help'], env).code).toBe(0);
    }
});

test('an unknown command fails fast with 127 and suggests a subcommand', () => {
    const { env } = sandbox();
    const typo = run(['stauts'], env);
    expect(typo.code).toBe(127);
    expect(typo.stderr).toContain('did you mean "buildlock status"');
    expect(run(['./no-such-file'], env).code).toBe(127);
});

test('config set, get, list and unset round-trip through the managed block', () => {
    const { env, config } = sandbox();
    expect(run(['config', 'set', 'slots', '3'], env).code).toBe(0);
    expect(run(['config', 'set', 'QUIET_HOURS', '22-06'], env).code).toBe(0);
    expect(run(['config', 'get', 'SLOTS'], env).stdout).toBe('3\n');
    const file = readFileSync(config, 'utf8');
    expect(file).toContain('BUILDLOCK_SLOTS=3');
    expect(file).toContain('# >>> buildlock config >>>');
    const rows = run(['config', 'list', '--tsv'], env).stdout.trim().split('\n').map((line) => line.split('\t'));
    expect(rows.find((row) => row[0] === 'SLOTS')?.slice(1, 3)).toEqual(['3', 'config']);
    expect(rows.find((row) => row[0] === 'WORKERS')?.slice(1, 3)).toEqual(['8', 'default']);
    expect(run(['config', 'unset', 'SLOTS'], env).code).toBe(0);
    expect(readFileSync(config, 'utf8')).not.toContain('BUILDLOCK_SLOTS');
    expect(run(['config', 'get', 'SLOTS'], env).stdout).toBe('2\n');
});

test('config rejects unknown keys and bad values', () => {
    const { env } = sandbox();
    expect(run(['config', 'set', 'SLOTZ', '3'], env).code).toBe(1);
    expect(run(['config', 'set', 'SLOTS', 'many'], env).stderr).toContain('a whole number');
    expect(run(['config', 'set', 'SLOTS', '0'], env).stderr).toContain('at least 1');
    expect(run(['config', 'set', 'QUIET_HOURS', '25-26'], env).code).toBe(1);
});

test('the environment wins over the config file', () => {
    const { env } = sandbox();
    run(['config', 'set', 'SLOTS', '3'], env);
    expect(run(['config', 'get', 'SLOTS'], { ...env, BUILDLOCK_SLOTS: '5' }).stdout).toBe('5\n');
    const row = run(['config', 'list', '--tsv'], { ...env, BUILDLOCK_SLOTS: '5' }).stdout.split('\n').find((line) => line.startsWith('SLOTS\t'));
    expect(row?.split('\t')[2]).toBe('env');
});

test('quiet hours replace the normal limits while they last', () => {
    const { env } = sandbox();
    run(['config', 'set', 'QUIET_SLOTS', '1'], env);
    run(['config', 'set', 'QUIET_WORKERS', '2'], env);
    run(['config', 'set', 'QUIET_HOURS', '00-24'], env);
    expect(run(['config', 'get', 'SLOTS'], env).stdout).toBe('1\n');
    expect(run(['bash', '-c', 'printf %s "$VITEST_MAX_WORKERS"'], env).stdout).toBe('2');
    expect(run(['--status'], env).stdout).toContain('running=0/1');
    expect(run(['quiet'], env).stdout).toContain('Quiet mode is on');
    // A range that never matches, a forced off, and an explicit environment value all win.
    run(['config', 'set', 'QUIET_HOURS', '05-05'], env);
    expect(run(['config', 'get', 'SLOTS'], env).stdout).toBe('2\n');
    run(['config', 'set', 'QUIET_HOURS', '00-24'], env);
    expect(run(['config', 'get', 'SLOTS'], { ...env, BUILDLOCK_QUIET: 'off' }).stdout).toBe('2\n');
    expect(run(['config', 'get', 'SLOTS'], { ...env, BUILDLOCK_SLOTS: '6' }).stdout).toBe('6\n');
    expect(run(['quiet', 'off'], env).code).toBe(0);
    expect(run(['config', 'get', 'SLOTS'], env).stdout).toBe('2\n');
    expect(run(['quiet', 'auto'], env).code).toBe(0);
    expect(run(['config', 'get', 'SLOTS'], env).stdout).toBe('1\n');
});

test('code after the managed block runs and can switch quiet mode on', () => {
    const { env, config } = sandbox();
    run(['config', 'set', 'QUIET_SLOTS', '1'], env);
    writeFileSync(config, `${readFileSync(config, 'utf8')}[[ -n "\${FORCE_QUIET:-}" ]] && BUILDLOCK_QUIET=on\n`);
    expect(run(['config', 'get', 'SLOTS'], env).stdout).toBe('2\n');
    expect(run(['config', 'get', 'SLOTS'], { ...env, FORCE_QUIET: '1' }).stdout).toBe('1\n');
});

test('a broken config file never stops a command from running', () => {
    const { env, config } = sandbox();
    mkdirSync(resolve(config, '..'), { recursive: true });
    writeFileSync(config, 'BUILDLOCK_SLOTS=2\nif then\n$UNSET_VARIABLE_HERE\nfalse\n');
    const result = run(['bash', '-c', 'echo ran'], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('ran\n');
    expect(run(['doctor'], env).stdout).toContain('syntax error');
});

test('run options set the lane, budget and timeout', () => {
    const { env } = sandbox();
    expect(run(['explain', '--', 'true'], { ...env, BUILDLOCK_CLASS: 'light' }).stdout).toContain('class: light');
    const ran = run(['run', '--light', '--memory', '512', '--', 'bash', '-c', 'echo ok'], env);
    expect(ran.code).toBe(0);
    expect(ran.stdout).toBe('ok\n');
    expect(ran.stderr).toMatch(/buildlock: waited \d+s \(light slot 0 of \d+\)/);
    expect(run(['--memory', 'lots', 'true'], env).code).toBe(2);
    expect(run(['run'], env).code).toBe(2);
});

test('status shows a running job and its command, as text and JSON', async () => {
    const { env } = sandbox({ BUILDLOCK_SLOTS: '1' });
    const holder = spawn(script, ['sleep', '2'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await waitFor(`${env.BUILDLOCK_LOCK_PATH}.holder`);
        const text = run(['status'], env).stdout;
        expect(text).toContain('Running  heavy 1/1');
        expect(text).toContain('sleep 2');
        expect(text).toContain('heavy: waits · all 1 slots busy');
        const json = JSON.parse(run(['status', '--json'], env).stdout);
        expect(json.running).toHaveLength(1);
        expect(json.running[0].command).toBe('sleep 2');
        expect(json.running[0].pid).toBe(holder.pid);
        expect(json.lanes.heavy.next).toBe('all 1 slots busy');
        expect(json.machine.availableMb).toBe(40000);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('a job that has to wait says so once, then runs', async () => {
    const { env } = sandbox({ BUILDLOCK_SLOTS: '1' });
    const holder = spawn(script, ['sleep', '3'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await waitFor(`${env.BUILDLOCK_LOCK_PATH}.holder`);
        const waiter = await finished(spawn(script, ['true'], { env, stdio: ['ignore', 'pipe', 'pipe'] }), 8_000);
        expect(waiter.code).toBe(0);
        expect(waiter.stderr).toContain('buildlock: waiting (all 1 slots busy); starts on its own');
        expect(waiter.stderr.match(/waiting/g)).toHaveLength(1);
        expect(waiter.stderr).toMatch(/buildlock: waited \d+s/);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
}, 12_000);

test('BUILDLOCK_BYPASS runs at once, even with every slot busy', async () => {
    const { env } = sandbox({ BUILDLOCK_SLOTS: '1' });
    const holder = spawn(script, ['sleep', '2'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await waitFor(`${env.BUILDLOCK_LOCK_PATH}.holder`);
        const result = run(['bash', '-c', 'printf %s "$VITEST_MAX_WORKERS"'], { ...env, BUILDLOCK_BYPASS: '1', BUILDLOCK_TIMEOUT: '0.2' });
        expect(result.code).toBe(0);
        expect(result.stdout).toBe('8');
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('history and stats read the job log', () => {
    const { env } = sandbox();
    for (const code of [0, 0, 3]) run(['bash', '-c', `exit ${code}`], env);
    const history = run(['history'], env).stdout;
    expect(history).toContain('WHEN');
    expect(history.match(/bash -c exit/g)).toHaveLength(3);
    expect(run(['history', '--failed'], env).stdout.match(/bash -c exit 3/g)).toHaveLength(1);
    const lines = run(['history', '--json', '-n', '2'], env).stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).exit).toBe(3);
    const stats = run(['stats'], env).stdout;
    expect(stats).toContain('3 jobs in the last 30 days');
    expect(stats).toContain('33% failed');
});

test('history says so when there is no log yet', () => {
    const { env } = sandbox();
    expect(run(['history'], env).stdout).toContain('No jobs logged yet');
    expect(run(['stats'], env).stdout).toContain('No jobs logged yet');
});

test('agents install writes marker blocks and permissions; uninstall restores the files', () => {
    const { env, home } = sandbox();
    mkdirSync(resolve(home, '.claude'), { recursive: true });
    mkdirSync(resolve(home, '.codex'), { recursive: true });
    const claudeMd = resolve(home, '.claude/CLAUDE.md');
    const original = '# My rules\n\nBe concise.\n';
    writeFileSync(claudeMd, original);
    writeFileSync(resolve(home, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git status)'] }, theme: 'dark' }));

    const install = run(['agents', 'install', '--target', 'claude,codex,kiro', '--yes'], env);
    expect(install.code).toBe(0);
    const written = readFileSync(claudeMd, 'utf8');
    expect(written.startsWith(original.trim())).toBe(true);
    expect(written).toContain('<!-- BUILDLOCK_START -->');
    expect(written).toContain('buildlock npm test');
    expect(readFileSync(resolve(home, '.codex/AGENTS.md'), 'utf8')).toContain('<!-- BUILDLOCK_END -->');
    expect(readFileSync(resolve(home, '.kiro/steering/buildlock.md'), 'utf8')).toStartWith('---\ninclusion: always\n---');
    const settings = JSON.parse(readFileSync(resolve(home, '.claude/settings.json'), 'utf8'));
    expect(settings.theme).toBe('dark');
    expect(settings.permissions.allow).toContain('Bash(git status)');
    expect(settings.permissions.allow).toContain('Bash(buildlock status:*)');
    // Never a blanket rule: buildlock runs arbitrary commands.
    expect(settings.permissions.allow).not.toContain('Bash(buildlock:*)');

    expect(run(['agents', 'install', '--target', 'claude', '--yes'], env).stdout).toContain('unchanged');
    expect(readFileSync(claudeMd, 'utf8').match(/BUILDLOCK_START/g)).toHaveLength(1);

    expect(run(['agents', 'uninstall', '--global'], env).code).toBe(0);
    expect(readFileSync(claudeMd, 'utf8')).toBe(original);
    expect(existsSync(resolve(home, '.codex/AGENTS.md'))).toBe(false);
    expect(existsSync(resolve(home, '.kiro/steering/buildlock.md'))).toBe(false);
    expect(JSON.parse(readFileSync(resolve(home, '.claude/settings.json'), 'utf8')).permissions.allow).toEqual(['Bash(git status)']);
});

test('agents keep files that already mention buildlock unless forced', () => {
    const { env, home } = sandbox();
    mkdirSync(resolve(home, '.claude'), { recursive: true });
    writeFileSync(resolve(home, '.claude/CLAUDE.md'), 'Wrap tsc in buildlock.\n');
    const result = run(['agents', 'install', '--target', 'claude', '--yes', '--no-permissions'], env);
    expect(result.stdout).toContain('already mentions buildlock');
    expect(readFileSync(resolve(home, '.claude/CLAUDE.md'), 'utf8')).toBe('Wrap tsc in buildlock.\n');
    run(['agents', 'install', '--target', 'claude', '--yes', '--force', '--no-permissions'], env);
    expect(readFileSync(resolve(home, '.claude/CLAUDE.md'), 'utf8')).toContain('BUILDLOCK_START');
    expect(existsSync(resolve(home, '.claude/settings.json'))).toBe(false);
});

test('project install lists the project commands and writes shared files once', () => {
    const { env, root } = sandbox();
    const repo = resolve(root, 'repo');
    mkdirSync(resolve(repo, '.git'), { recursive: true });
    writeFileSync(resolve(repo, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', test: 'vitest run', typecheck: 'tsc --noEmit', build: 'vite build' } }, null, 2));
    writeFileSync(resolve(repo, 'bun.lock'), '');
    writeFileSync(resolve(repo, 'AGENTS.md'), '# Agents\n');
    symlinkSync('AGENTS.md', resolve(repo, 'CLAUDE.md'));
    const result = run(['agents', 'install', '--project', '--target', 'claude,codex,opencode,cursor', '--yes', '--no-permissions'], env, repo);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('same file as Claude Code');
    const agents = readFileSync(resolve(repo, 'AGENTS.md'), 'utf8');
    expect(agents.match(/BUILDLOCK_START/g)).toHaveLength(1);
    expect(agents).toContain('buildlock bun run test');
    expect(agents).toContain('buildlock bun run typecheck');
    expect(agents).not.toContain('bun run dev');
    expect(agents).toContain('When `buildlock` is installed');
    expect(lstatSync(resolve(repo, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(readFileSync(resolve(repo, '.cursor/rules/buildlock.mdc'), 'utf8')).toContain('alwaysApply: true');
    run(['agents', 'uninstall', '--project'], env, repo);
    expect(readFileSync(resolve(repo, 'AGENTS.md'), 'utf8')).toBe('# Agents\n');
    expect(existsSync(resolve(repo, '.cursor/rules/buildlock.mdc'))).toBe(false);
});

test('a project CLAUDE.md that imports AGENTS.md defers to it', () => {
    const { env, root } = sandbox();
    const repo = resolve(root, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(resolve(repo, 'CLAUDE.md'), '@AGENTS.md\n');
    run(['agents', 'install', '--project', '--target', 'claude', '--yes', '--no-permissions'], env, repo);
    expect(readFileSync(resolve(repo, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    expect(readFileSync(resolve(repo, 'AGENTS.md'), 'utf8')).toContain('BUILDLOCK_START');
});

test('completion scripts are valid shell', () => {
    const { env } = sandbox();
    const bash = run(['completion', 'bash'], env).stdout;
    expect(spawnSync('bash', ['-n'], { input: bash }).status).toBe(0);
    expect(run(['completion', 'zsh'], env).stdout).toContain('compdef _buildlock buildlock');
});

test('doctor passes on a supported machine', () => {
    const { env } = sandbox();
    const result = run(['doctor'], env);
    expect(result.stdout).toContain('bash');
    expect(result.code).toBe(0);
});

test('install.sh installs from a local file and upgrades in place', () => {
    const { env, root } = sandbox();
    const prefix = resolve(root, 'bin');
    const first = spawnSync('bash', [installer, '--from', script, '--prefix', prefix, '--yes'], { env, encoding: 'utf8' });
    expect(first.status).toBe(0);
    expect(first.stdout).toContain('installed buildlock');
    expect(first.stdout).toContain('not on your PATH');
    const second = spawnSync('bash', [installer, '--from', script, '--prefix', prefix, '--yes'], { env, encoding: 'utf8' });
    expect(second.stdout).toContain('reinstalled');
    expect(spawnSync(resolve(prefix, 'buildlock'), ['--version'], { env, encoding: 'utf8' }).stdout).toStartWith('buildlock ');
});

// Regressions found in review before the first release.

test('agents uninstall never deletes a user file that merely has frontmatter', () => {
    const { env, home } = sandbox();
    mkdirSync(resolve(home, '.claude'), { recursive: true });
    const file = resolve(home, '.claude/CLAUDE.md');
    const original = '---\nname: mine\n---\n\nMy rules.\n\n---\n';
    writeFileSync(file, original);
    run(['agents', 'install', '--target', 'claude', '--yes', '--no-permissions'], env);
    run(['agents', 'uninstall', '--global'], env);
    expect(readFileSync(file, 'utf8')).toBe(original);
});

test('damaged markers are reported and never edited', () => {
    const { env, home } = sandbox();
    mkdirSync(resolve(home, '.codex'), { recursive: true });
    const file = resolve(home, '.codex/AGENTS.md');
    const orphan = '# Notes\n<!-- BUILDLOCK_START -->\nold\n\n## My important section\nkeep me\n';
    writeFileSync(file, orphan);
    const install = run(['agents', 'install', '--target', 'codex', '--yes'], env);
    expect(install.stdout).toContain('damaged');
    expect(readFileSync(file, 'utf8')).toBe(orphan);
    expect(run(['agents', 'uninstall', '--global', '--target', 'codex'], env).stdout).toContain('damaged');
    expect(readFileSync(file, 'utf8')).toBe(orphan);
    // Markers inside a line (e.g. quoted in prose) are not a block.
    writeFileSync(file, 'Our block uses `<!-- BUILDLOCK_START -->` and `<!-- BUILDLOCK_END -->`.\n');
    run(['agents', 'install', '--target', 'codex', '--yes', '--force'], env);
    const written = readFileSync(file, 'utf8');
    expect(written).toStartWith('Our block uses');
    expect(written.match(/^<!-- BUILDLOCK_START -->$/gm)).toHaveLength(1);
    run(['agents', 'uninstall', '--global', '--target', 'codex'], env);
    expect(readFileSync(file, 'utf8')).toBe('Our block uses `<!-- BUILDLOCK_START -->` and `<!-- BUILDLOCK_END -->`.\n');
});

test('an unknown agent name stops before anything is written', () => {
    const { env, home } = sandbox();
    mkdirSync(resolve(home, '.claude'), { recursive: true });
    const result = run(['agents', 'install', '--target', 'claude,bogus', '--yes'], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("unknown agent 'bogus'");
    expect(existsSync(resolve(home, '.claude/CLAUDE.md'))).toBe(false);
});

test('Claude settings keep non-ASCII text, and odd shapes are skipped without failing', () => {
    const { env, home } = sandbox();
    mkdirSync(resolve(home, '.claude'), { recursive: true });
    mkdirSync(resolve(home, '.codex'), { recursive: true });
    const settings = resolve(home, '.claude/settings.json');
    writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(echo 状态)'] } }));
    run(['agents', 'install', '--target', 'claude', '--yes'], env);
    expect(readFileSync(settings, 'utf8')).toContain('echo 状态');
    writeFileSync(settings, '{"permissions": null}');
    const odd = run(['agents', 'install', '--target', 'claude,codex', '--yes'], env);
    expect(odd.code).toBe(0);
    expect(existsSync(resolve(home, '.codex/AGENTS.md'))).toBe(true);
    writeFileSync(settings, '{"permissions": {"allow": "nope"}}');
    expect(run(['agents', 'install', '--target', 'claude', '--yes'], env).stdout).toContain('skipped');
    expect(readFileSync(settings, 'utf8')).toBe('{"permissions": {"allow": "nope"}}');
});

test('a settings file that install created goes away on uninstall', () => {
    const { env, root } = sandbox();
    const repo = resolve(root, 'repo');
    mkdirSync(repo, { recursive: true });
    run(['agents', 'install', '--project', '--target', 'claude', '--yes'], env, repo);
    expect(existsSync(resolve(repo, '.claude/settings.local.json'))).toBe(true);
    run(['agents', 'uninstall', '--project'], env, repo);
    expect(existsSync(resolve(repo, '.claude/settings.local.json'))).toBe(false);
    expect(existsSync(resolve(repo, 'CLAUDE.md'))).toBe(false);
});

test('config refuses to edit a file with a damaged block', () => {
    const { env, config } = sandbox();
    mkdirSync(resolve(config, '..'), { recursive: true });
    const content = '# >>> buildlock config >>>\nBUILDLOCK_SLOTS=1\nif true; then\nBUILDLOCK_SLOTS=1\nfi\n';
    writeFileSync(config, content);
    const result = run(['config', 'set', 'SLOTS', '2'], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('markers');
    expect(readFileSync(config, 'utf8')).toBe(content);
});

test('config warns when its own code still decides a value', () => {
    const { env, config } = sandbox();
    mkdirSync(resolve(config, '..'), { recursive: true });
    writeFileSync(config, 'BUILDLOCK_SLOTS=3\n');
    const result = run(['config', 'set', 'SLOTS', '2'], env);
    expect(result.stdout).toContain("sets SLOTS to '3'");
    expect(run(['config', 'get', 'SLOTS'], env).stdout).toBe('3\n');
});

test('numbers buildlock cannot use fall back to their defaults', () => {
    const { env, config } = sandbox();
    expect(run(['config', 'set', 'WORKERS', '09'], env).code).toBe(1);
    mkdirSync(resolve(config, '..'), { recursive: true });
    writeFileSync(config, 'BUILDLOCK_WORKERS=abc\nBUILDLOCK_SLOTS=08\n');
    const result = run(['bash', '-c', 'printf %s "$VITEST_MAX_WORKERS"'], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('8');
    expect(result.stderr).toContain('ignoring BUILDLOCK_WORKERS');
    expect(result.stderr).toContain('ignoring BUILDLOCK_SLOTS');
    expect(JSON.parse(run(['status', '--json'], env).stdout).lanes.heavy.slots).toBe(2);
});

test('quiet slots also cap the idle fast path', () => {
    const { env } = sandbox();
    run(['config', 'set', 'MAX_JOBS', '6'], env);
    run(['config', 'set', 'QUIET_SLOTS', '1'], env);
    run(['config', 'set', 'QUIET_HOURS', '00-24'], env);
    expect(run(['--status'], env).stdout).toContain('max=1 ');
    run(['config', 'set', 'QUIET_MAX_JOBS', '3'], env);
    expect(run(['--status'], env).stdout).toContain('max=3 ');
});

test('options without a value fail with a message', () => {
    const { env } = sandbox();
    for (const args of [['--timeout'], ['history', '-n'], ['status', '-i'], ['agents', 'install', '--target'], ['--memory']]) {
        const result = run(args, env);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('needs a value');
    }
});

test('explain takes the same options as run', () => {
    const { env } = sandbox();
    const out = run(['explain', '--light', 'vitest', 'run'], env).stdout;
    expect(out).toContain('::vitest run::light');
    expect(out).toContain('class: light');
});

test('history and stats line up with older log lines and new commands', () => {
    const { env } = sandbox();
    mkdirSync(env.BUILDLOCK_JOB_LOG_DIR, { recursive: true });
    const month = new Date().toISOString().slice(0, 7);
    const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    writeFileSync(resolve(env.BUILDLOCK_JOB_LOG_DIR, `jobs-${month}.jsonl`),
        `{"at":"${at}","end":"${at}","pid":1,"cwd":"/r","class":"heavy","budgetMb":8192,"waitSeconds":3,"runSeconds":5,"exit":2,"cmd":"make","key":"/r::make"}\n`);
    const line = run(['history'], env).stdout.split('\n')[1];
    expect(line).toMatch(/3s\s+5s\s+-\s+2\s+heavy\s+\/r\s+make$/);
    expect(run(['stats'], env).stdout).toMatch(/\bnew\b.*r: make/);
});

test('update replaces the installed file after checking its checksum', () => {
    const { env, root } = sandbox();
    const bin = resolve(root, 'bin');
    const release = resolve(root, 'release/latest/download');
    mkdirSync(bin, { recursive: true });
    mkdirSync(release, { recursive: true });
    const installed = resolve(bin, 'buildlock');
    writeFileSync(installed, readFileSync(script, 'utf8'), { mode: 0o755 });
    const next = readFileSync(script, 'utf8').replace(/^bl_version=.*$/m, 'bl_version=9.9.9');
    writeFileSync(resolve(release, 'buildlock'), next);
    const sha = spawnSync('sha256sum', ['buildlock'], { cwd: release, encoding: 'utf8' }).stdout;
    writeFileSync(resolve(release, 'buildlock.sha256'), sha);
    const updateEnv = { ...env, BUILDLOCK_RELEASES_URL: `file://${resolve(root, 'release')}` };
    const result = spawnSync(installed, ['update'], { env: updateEnv, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('-> 9.9.9');
    expect(readFileSync(installed, 'utf8')).toContain('bl_version=9.9.9');
    writeFileSync(resolve(release, 'buildlock.sha256'), `${'0'.repeat(64)}  buildlock\n`);
    const tampered = spawnSync(installed, ['update', '--force'], { env: updateEnv, encoding: 'utf8' });
    expect(tampered.status).toBe(1);
    expect(tampered.stderr).toContain('checksum mismatch');
});

test('uninstall through a symlink removes only the link', () => {
    const { env, root } = sandbox();
    const checkout = resolve(root, 'checkout');
    const bin = resolve(root, 'bin');
    mkdirSync(checkout, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(resolve(checkout, 'buildlock'), readFileSync(script, 'utf8'), { mode: 0o755 });
    symlinkSync(resolve(checkout, 'buildlock'), resolve(bin, 'buildlock'));
    const result = spawnSync(resolve(bin, 'buildlock'), ['uninstall', '--yes', '--keep-agents'], { env, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(existsSync(resolve(bin, 'buildlock'))).toBe(false);
    expect(existsSync(resolve(checkout, 'buildlock'))).toBe(true);
    symlinkSync(resolve(checkout, 'buildlock'), resolve(bin, 'buildlock'));
    const update = spawnSync(resolve(bin, 'buildlock'), ['update'], { env, encoding: 'utf8' });
    expect(update.status).toBe(1);
    expect(update.stderr).toContain('is a symlink');
});

test('install.sh reads the installed version instead of running it', () => {
    const { env, root } = sandbox();
    const prefix = resolve(root, 'bin');
    mkdirSync(prefix, { recursive: true });
    // An old build that would hang if executed.
    writeFileSync(resolve(prefix, 'buildlock'), '#!/usr/bin/env bash\nsleep 30\n', { mode: 0o755 });
    const started = Date.now();
    const result = spawnSync('bash', [installer, '--from', script, '--prefix', prefix, '--yes'], { env, encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.stdout).toContain('updated buildlock unversioned ->');
});
