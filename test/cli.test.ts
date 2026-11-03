import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
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
    expect(run(['bash', '-c', 'printf %s "$BUILDLOCK_WORKERS"'], env).stdout).toBe('2');
    expect(run(['--status'], env).stdout).toContain('running=0/1');
    expect(run(['quiet'], env).stdout).toContain('Quiet mode: on');
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
    // A job that starts at once prints nothing of its own.
    expect(ran.stderr).toBe('');
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
        expect(text).toContain('heavy: waits: the one heavy slot is busy');
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
        expect(waiter.stderr).toContain('buildlock: waiting (the one heavy slot is busy); starts on its own');
        expect(waiter.stderr.match(/waiting/g)).toHaveLength(1);
        expect(waiter.stderr).toMatch(/buildlock: waited \d+s \(slot 1 of 1\)/);
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
        const result = run(['bash', '-c', 'printf %s "$BUILDLOCK_WORKERS"'], { ...env, BUILDLOCK_BYPASS: '1', BUILDLOCK_TIMEOUT: '0.2' });
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

test('project install writes AGENTS.md once, at the repository root, and leaves a symlinked CLAUDE.md alone', () => {
    const { env, root } = sandbox();
    const repo = resolve(root, 'repo');
    mkdirSync(resolve(repo, '.git'), { recursive: true });
    mkdirSync(resolve(repo, 'packages/web'), { recursive: true });
    writeFileSync(resolve(repo, 'package.json'), JSON.stringify({ scripts: { dev: 'vite', test: 'vitest run', typecheck: 'tsc --noEmit', build: 'vite build' } }));
    writeFileSync(resolve(repo, 'bun.lock'), '');
    writeFileSync(resolve(repo, 'AGENTS.md'), '# Agents\n');
    symlinkSync('AGENTS.md', resolve(repo, 'CLAUDE.md'));
    // Run from a subdirectory: the files still go to the repository root.
    const result = run(['agents', 'install', '--project', '--target', 'claude,codex,opencode,cursor', '--yes'], env, resolve(repo, 'packages/web'));
    expect(result.code).toBe(0);
    const agents = readFileSync(resolve(repo, 'AGENTS.md'), 'utf8');
    expect(agents.match(/BUILDLOCK_START/g)).toHaveLength(1);
    expect(agents).toContain('buildlock bun run test');
    expect(agents).toContain('buildlock bun run typecheck');
    expect(agents).not.toContain('bun run dev');
    expect(agents).toContain("don't install it");
    expect(lstatSync(resolve(repo, 'CLAUDE.md')).isSymbolicLink()).toBe(true);
    expect(existsSync(resolve(repo, 'packages/web/AGENTS.md'))).toBe(false);
    // Cursor, Copilot and the rest read AGENTS.md: no per-agent copies.
    expect(existsSync(resolve(repo, '.cursor'))).toBe(false);
    expect(existsSync(resolve(repo, '.github'))).toBe(false);
    // No project permissions file (it would be committed by accident).
    expect(existsSync(resolve(repo, '.claude/settings.local.json'))).toBe(false);
    run(['agents', 'uninstall', '--project'], env, repo);
    expect(readFileSync(resolve(repo, 'AGENTS.md'), 'utf8')).toBe('# Agents\n');
});

test('project install never creates a CLAUDE.md, which would hide AGENTS.md from Claude Code', () => {
    const { env, root } = sandbox();
    const repo = resolve(root, 'repo');
    mkdirSync(repo, { recursive: true });
    writeFileSync(resolve(repo, 'AGENTS.md'), '# Rules\nUse pnpm.\n');
    run(['agents', 'install', '--project', '--yes'], env, repo);
    expect(existsSync(resolve(repo, 'CLAUDE.md'))).toBe(false);
    expect(readFileSync(resolve(repo, 'AGENTS.md'), 'utf8')).toContain('Use pnpm.');
    expect(readFileSync(resolve(repo, 'AGENTS.md'), 'utf8')).toContain('BUILDLOCK_START');
    // A CLAUDE.md of the project's own gets the section too: Claude reads it instead.
    writeFileSync(resolve(repo, 'CLAUDE.md'), '# Claude rules\n');
    run(['agents', 'install', '--project', '--yes'], env, repo);
    expect(readFileSync(resolve(repo, 'CLAUDE.md'), 'utf8')).toContain('BUILDLOCK_START');
});

test('project install cleans up what an older version wrote', () => {
    const { env, root } = sandbox();
    const repo = resolve(root, 'repo');
    mkdirSync(resolve(repo, '.cursor/rules'), { recursive: true });
    mkdirSync(resolve(repo, '.github'), { recursive: true });
    const block = '<!-- BUILDLOCK_START -->\nold\n<!-- BUILDLOCK_END -->\n';
    writeFileSync(resolve(repo, 'CLAUDE.md'), block);
    writeFileSync(resolve(repo, '.cursor/rules/buildlock.mdc'), `---\ndescription: Queue heavy commands (builds, type-checks, test suites) with buildlock\nalwaysApply: true\n---\n\n${block}`);
    writeFileSync(resolve(repo, '.github/copilot-instructions.md'), `# Copilot\n\n${block}`);
    const result = run(['agents', 'install', '--project', '--yes'], env, repo);
    expect(result.code).toBe(0);
    expect(existsSync(resolve(repo, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(resolve(repo, '.cursor'))).toBe(false);
    expect(readFileSync(resolve(repo, '.github/copilot-instructions.md'), 'utf8')).toBe('# Copilot\n');
    expect(readFileSync(resolve(repo, 'AGENTS.md'), 'utf8')).toContain('BUILDLOCK_START');
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
    const { env, home } = sandbox();
    mkdirSync(resolve(home, '.claude'), { recursive: true });
    run(['agents', 'install', '--target', 'claude', '--yes'], env);
    expect(existsSync(resolve(home, '.claude/settings.json'))).toBe(true);
    run(['agents', 'uninstall', '--global'], env);
    expect(existsSync(resolve(home, '.claude/settings.json'))).toBe(false);
    expect(existsSync(resolve(home, '.claude/CLAUDE.md'))).toBe(false);
});

test('Claude Code rules for wrapped commands are mirrored, never a blanket allow', () => {
    const { env, home } = sandbox();
    mkdirSync(resolve(home, '.claude'), { recursive: true });
    const settings = { model: 'x', permissions: { allow: ['Bash(npm test:*)', 'Bash(git status)'], deny: ['Bash(git push:*)'] } };
    writeFileSync(resolve(home, '.claude/settings.json'), JSON.stringify(settings));
    run(['agents', 'install', '--target', 'claude', '--yes'], env);
    const perms = JSON.parse(readFileSync(resolve(home, '.claude/settings.json'), 'utf8')).permissions;
    expect(perms.allow).toContain('Bash(buildlock npm test:*)');
    expect(perms.allow).toContain('Bash(buildlock status:*)');
    expect(perms.allow).not.toContain('Bash(buildlock git status)');
    expect(perms.allow).not.toContain('Bash(buildlock:*)');
    expect(perms.deny).toContain('Bash(buildlock git push:*)');
    run(['agents', 'uninstall', '--global'], env);
    expect(JSON.parse(readFileSync(resolve(home, '.claude/settings.json'), 'utf8'))).toEqual(settings);
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
    const result = run(['bash', '-c', 'printf %s "$BUILDLOCK_WORKERS"'], env);
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
    writeFileSync(resolve(prefix, 'buildlock'), '#!/usr/bin/env bash\n# buildlock, before versions\nsleep 30\n', { mode: 0o755 });
    const started = Date.now();
    const result = spawnSync('bash', [installer, '--from', script, '--prefix', prefix, '--yes'], { env, encoding: 'utf8', timeout: 15_000 });
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.stdout).toContain('updated buildlock unversioned ->');
});

// Regressions found in the second review (0.2.0).

test('buildlock runs when called through a symlink or under another name', () => {
    const { env, root } = sandbox();
    const link = resolve(root, 'bl');
    symlinkSync(script, link);
    const result = spawnSync(link, ['bash', '-c', 'echo via-link'], { env, encoding: 'utf8', timeout: 8_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('via-link\n');
});

test('the config file runs apart: exit, cd and echo in it cannot change the command', () => {
    const { env, config, home } = sandbox();
    mkdirSync(resolve(config, '..'), { recursive: true });
    writeFileSync(config, 'BUILDLOCK_SLOTS=3\necho noise-from-config\ncd /\nIFS=,\nexit 0\nBUILDLOCK_SLOTS=9\n');
    const result = run(['bash', '-c', 'pwd'], env, home);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${home}\n`);
    expect(result.stderr).toContain('noise-from-config');
    expect(run(['config', 'get', 'SLOTS'], env).stdout).toBe('3\n');
    expect(JSON.parse(run(['status', '--json'], env).stdout).lanes.heavy.slots).toBe(3);
});

test('an invalid timeout in the config falls back instead of failing every build', () => {
    const { env, config } = sandbox();
    mkdirSync(resolve(config, '..'), { recursive: true });
    writeFileSync(config, 'BUILDLOCK_TIMEOUT=10m\n');
    const result = run(['bash', '-c', 'echo ran'], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('ran\n');
    expect(result.stderr).toContain('ignoring BUILDLOCK_TIMEOUT');
});

test('a waiter whose queue file was removed puts it back and still runs', async () => {
    const { env } = sandbox({ BUILDLOCK_SLOTS: '1' });
    const holder = spawn(script, ['sleep', '1.5'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await waitFor(`${env.BUILDLOCK_LOCK_PATH}.holder`);
        const waiter = spawn(script, ['true'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        const entry = `${env.BUILDLOCK_LOCK_PATH}.queue/${waiter.pid}`;
        await waitFor(entry);
        unlinkSync(entry);
        expect((await finished(waiter, 10_000)).code).toBe(0);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
}, 15_000);

test('a stopped waiter keeps its place without blocking the ones behind it', async () => {
    const { env } = sandbox({ BUILDLOCK_SLOTS: '1' });
    const holder = spawn(script, ['sleep', '1'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(`${env.BUILDLOCK_LOCK_PATH}.holder`);
    const first = spawn(script, ['true'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await waitFor(`${env.BUILDLOCK_LOCK_PATH}.queue/${first.pid}`);
        first.kill('SIGTSTP');
        const second = spawn(script, ['true'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        expect((await finished(second, 8_000)).code).toBe(0);
    } finally {
        first.kill('SIGCONT');
        holder.kill('SIGTERM');
        await finished(holder);
    }
    expect((await finished(first, 8_000)).code).toBe(0);
}, 20_000);

test('a nested call passes through even when a wrapper dropped BUILDLOCK_HELD', () => {
    const { env } = sandbox({ BUILDLOCK_SLOTS: '1' });
    const result = run(['bash', '-c', 'env -u BUILDLOCK_HELD "$S" bash -c "echo inner"'], { ...env, S: script, BUILDLOCK_TIMEOUT: '3' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('inner\n');
});

test('a kill -9 of buildlock does not leave its command running outside the queue', async () => {
    const { env, root } = sandbox({ BUILDLOCK_SAMPLE_SECONDS: '0.5' });
    const pidFile = resolve(root, 'command.pid');
    const holder = spawn(script, ['bash', '-c', `echo $$ > ${pidFile}; exec sleep 30`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    await waitFor(pidFile);
    await Bun.sleep(100);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(pid) && pid > 1).toBe(true);
    try {
        holder.kill('SIGKILL');
        let gone = false;
        for (let i = 0; i < 80 && !gone; i++) {
            await Bun.sleep(100);
            gone = !existsSync(`/proc/${pid}`) || readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.startsWith('Z') === true;
        }
        expect(gone).toBe(true);
    } finally {
        if (Number.isInteger(pid) && pid > 1 && existsSync(`/proc/${pid}`)) {
            try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
        }
    }
}, 15_000);

test('a heavy job starved of memory gets its budget kept free by light jobs', async () => {
    const { env } = sandbox({ BUILDLOCK_SLOTS: '2', BUILDLOCK_LIGHT_SLOTS: '2', BUILDLOCK_RESERVE_MEMORY_MB: '2048', BUILDLOCK_HEAVY_STARVE_SECONDS: '1' });
    const holder = spawn(script, ['sleep', '2'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
        await waitFor(`${env.BUILDLOCK_LOCK_PATH}.holder`);
        const light = ['run', '--light', '--timeout', '0.5', 'true'];
        expect(run(light, env).code).toBe(0);
        // A heavy head waiting longer than the starvation limit for 40 GB. The
        // test process stands in for it: alive, and started before `since` + 60 s
        // (pid 1 is not, on a CI machine booted a minute ago).
        const since = Math.floor(Date.now() / 1000) - 5;
        writeFileSync(`${env.BUILDLOCK_LOCK_PATH}.heavywait`, `${process.pid}\t${since}\t40000\n`);
        const starved = run(light, env);
        expect(starved.code).toBe(73);
        expect(starved.stderr).toContain('not enough free memory');
        expect(starved.stderr).toContain('for a heavy job that has waited longer');
        // status agrees with what a light job meets.
        expect(run(['status'], env).stdout).toMatch(/light: waits: not enough free memory/);
        unlinkSync(`${env.BUILDLOCK_LOCK_PATH}.heavywait`);
        expect(run(light, env).code).toBe(0);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('quiet mode without its own limits halves the jobs at once', () => {
    const { env } = sandbox();
    const status = run(['--status'], { ...env, BUILDLOCK_QUIET: 'on' }).stdout;
    expect(status).toContain('running=0/1 ');
    expect(status).toContain('light=0/2 ');
    expect(status).toContain('max=1 ');
    expect(run(['--status'], env).stdout).toContain('running=0/2 ');
});

test('memory defaults scale down on a small machine', () => {
    const { env, root } = sandbox();
    writeFileSync(resolve(root, 'proc/meminfo'), 'MemTotal: 8388608 kB\nMemAvailable: 4194304 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n');
    expect(run(['config', 'get', 'CRITICAL_MEMORY_MB'], env).stdout).toBe('819\n');
    expect(run(['config', 'get', 'RESERVE_MEMORY_MB'], env).stdout).toBe('1024\n');
    expect(run(['config', 'get', 'DEFAULT_MEMORY_MB'], env).stdout).toBe('2048\n');
    // 4 GB free is plenty for a lone job here.
    expect(run(['bash', '-c', 'echo ok'], { ...env, BUILDLOCK_TIMEOUT: '1' }).code).toBe(0);
});

test('sizes take units, and unknown keys are refused', () => {
    const { env, config } = sandbox();
    expect(run(['config', 'set', 'RESERVE_MEMORY_MB', '2G'], env).code).toBe(0);
    expect(readFileSync(config, 'utf8')).toContain('BUILDLOCK_RESERVE_MEMORY_MB=2048');
    expect(run(['explain', '--memory', '1.5G', 'true'], env).stdout).toContain('budget=1536MB');
    expect(run(['config', 'unset', 'NOPE'], env).code).toBe(1);
    expect(run(['config', 'set', 'BYPASS', 'on'], env).code).toBe(0);
    expect(run(['config', 'unset', 'BYPASS'], env).code).toBe(0);
});

test('every subcommand answers --help, and stats has JSON', () => {
    const { env } = sandbox();
    for (const sub of ['explain', 'setup', 'status', 'history', 'stats', 'config', 'quiet', 'agents', 'doctor', 'update', 'uninstall', 'completion']) {
        const result = run([sub, '--help'], env);
        expect(`${sub}: ${result.code}`).toBe(`${sub}: 0`);
        expect(result.stdout).toContain('Usage');
    }
    run(['bash', '-c', 'exit 0'], env);
    const stats = JSON.parse(run(['stats', '--json'], env).stdout);
    expect(stats.jobs).toBe(1);
    expect(stats.commands[0].runs).toBe(1);
    expect(run(['history', '--days', '1'], env).stdout).toContain('bash -c exit 0');
    expect(run(['completion', 'fish'], env).stdout).toContain('complete -c buildlock');
});

test('bare agents without a terminal only shows the status', () => {
    const { env, home } = sandbox();
    mkdirSync(resolve(home, '.claude'), { recursive: true });
    const result = run(['agents'], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('buildlock agents');
    expect(existsSync(resolve(home, '.claude/CLAUDE.md'))).toBe(false);
});

test('a directory holding only skills/ does not count as an installed agent', () => {
    const { env, home } = sandbox();
    mkdirSync(resolve(home, '.qwen/skills/some-skill'), { recursive: true });
    mkdirSync(resolve(home, '.claude'), { recursive: true });
    writeFileSync(resolve(home, '.claude/settings.json'), '{}\n');
    run(['agents', 'install', '--yes', '--no-permissions'], env);
    expect(existsSync(resolve(home, '.qwen/QWEN.md'))).toBe(false);
    expect(readFileSync(resolve(home, '.claude/CLAUDE.md'), 'utf8')).toContain('BUILDLOCK_START');
    // An explicit target creates the agent's file; uninstall removes it and the directories it made.
    run(['agents', 'install', '--target', 'kiro', '--yes'], env);
    expect(existsSync(resolve(home, '.kiro/steering/buildlock.md'))).toBe(true);
    run(['agents', 'uninstall', '--global'], env);
    expect(existsSync(resolve(home, '.kiro'))).toBe(false);
    expect(existsSync(resolve(home, '.qwen/skills/some-skill'))).toBe(true);
});

test('uninstall cleans global files only, and stops before removing anything it cannot finish', () => {
    const { env, root, home } = sandbox();
    const prefix = resolve(root, 'prefix');
    mkdirSync(prefix, { recursive: true });
    const copy = resolve(prefix, 'buildlock');
    copyFileSync(script, copy);
    chmodSync(copy, 0o755);
    mkdirSync(resolve(home, '.claude'), { recursive: true });
    run(['agents', 'install', '--target', 'claude', '--yes', '--no-permissions'], env);
    const repo = resolve(root, 'repo');
    mkdirSync(repo, { recursive: true });
    run(['agents', 'install', '--project', '--yes'], env, repo);
    chmodSync(prefix, 0o555);
    try {
        const refused = spawnSync(copy, ['uninstall', '--yes'], { env, cwd: repo, encoding: 'utf8' });
        expect(refused.status).toBe(1);
        expect(refused.stderr).toContain("can't write");
        expect(readFileSync(resolve(home, '.claude/CLAUDE.md'), 'utf8')).toContain('BUILDLOCK_START');
    } finally {
        chmodSync(prefix, 0o755);
    }
    expect(spawnSync(copy, ['uninstall', '--yes'], { env, cwd: repo, encoding: 'utf8' }).status).toBe(0);
    expect(existsSync(copy)).toBe(false);
    expect(existsSync(resolve(home, '.claude/CLAUDE.md'))).toBe(false);
    expect(readFileSync(resolve(repo, 'AGENTS.md'), 'utf8')).toContain('BUILDLOCK_START');
});

test('update explains that main comes from the installer', () => {
    const { env } = sandbox();
    const result = run(['update', '--version', 'main'], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('install.sh');
});

test('a full or closed stderr never stops the command', () => {
    const { env, root } = sandbox();
    const marker = resolve(root, 'ran');
    const full = openSync('/dev/full', 'w');
    try {
        const result = spawnSync(script, ['bash', '-c', `touch ${marker}`], { env, stdio: ['ignore', 'pipe', full] });
        expect(result.status).toBe(0);
    } finally {
        closeSync(full);
    }
    expect(existsSync(marker)).toBe(true);
});

test('command-not-found errors say what to do', () => {
    const { env, root } = sandbox();
    expect(run(['FOO=1', 'node'], env).stderr).toContain('buildlock env FOO=1');
    expect(run(['make -j8'], env).stderr).toContain('sh -c');
    const file = resolve(root, 'not-executable.sh');
    writeFileSync(file, 'echo hi\n');
    expect(run([file], env).code).toBe(126);
});

test('install.sh expands ~ in --prefix=, refuses links and foreign files, and explains a root-owned prefix', () => {
    const { env, root, home } = sandbox();
    const tilde = spawnSync('bash', [installer, '--from', script, '--prefix=~/tbin', '--yes'], { env, cwd: root, encoding: 'utf8' });
    expect(tilde.status).toBe(0);
    expect(existsSync(resolve(home, 'tbin/buildlock'))).toBe(true);
    expect(existsSync(resolve(root, '~'))).toBe(false);
    const links = resolve(root, 'links');
    mkdirSync(links, { recursive: true });
    symlinkSync(script, resolve(links, 'buildlock'));
    const link = spawnSync('bash', [installer, '--from', script, '--prefix', links, '--yes'], { env, encoding: 'utf8' });
    expect(link.status).toBe(1);
    expect(link.stderr).toContain('symlink');
    const foreign = resolve(root, 'foreign');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(resolve(foreign, 'buildlock'), '#!/bin/sh\necho something else\n');
    expect(spawnSync('bash', [installer, '--from', script, '--prefix', foreign, '--yes'], { env, encoding: 'utf8' }).status).toBe(1);
    expect(readFileSync(resolve(foreign, 'buildlock'), 'utf8')).toContain('something else');
    const locked = resolve(root, 'locked');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o555);
    try {
        const denied = spawnSync('bash', [installer, '--from', script, '--prefix', resolve(locked, 'bin'), '--yes'], { env, encoding: 'utf8' });
        expect(denied.status).toBe(1);
        expect(denied.stderr).toContain('sudo bash');
    } finally {
        chmodSync(locked, 0o755);
    }
});

test('a copy that a package manager installed is left to that package manager', () => {
    const { env, root, home } = sandbox();
    const place = (dir: string) => {
        mkdirSync(dir, { recursive: true });
        copyFileSync(script, resolve(dir, 'buildlock'));
        chmodSync(resolve(dir, 'buildlock'), 0o755);
        return resolve(dir, 'buildlock');
    };
    // npm's global layout: <prefix>/bin/buildlock -> ../lib/node_modules/buildlock/bin/buildlock
    const real = place(resolve(root, 'npm/lib/node_modules/buildlock/bin'));
    mkdirSync(resolve(root, 'npm/bin'), { recursive: true });
    const link = resolve(root, 'npm/bin/buildlock');
    symlinkSync('../lib/node_modules/buildlock/bin/buildlock', link);
    const update = spawnSync(link, ['update'], { env, encoding: 'utf8' });
    expect(update.status).toBe(1);
    expect(update.stderr).toContain('npm install -g buildlock@latest');
    // --check still checks, and names the same command.
    const release = resolve(root, 'release/latest/download');
    mkdirSync(release, { recursive: true });
    writeFileSync(resolve(release, 'buildlock'), readFileSync(script, 'utf8').replace(/^bl_version=.*$/m, 'bl_version=9.9.9'));
    writeFileSync(resolve(release, 'buildlock.sha256'), spawnSync('sha256sum', ['buildlock'], { cwd: release, encoding: 'utf8' }).stdout);
    const check = spawnSync(link, ['update', '--check'], { env: { ...env, BUILDLOCK_RELEASES_URL: `file://${resolve(root, 'release')}` }, encoding: 'utf8' });
    expect(check.status).toBe(0);
    expect(check.stdout).toContain('-> 9.9.9 (run: npm install -g buildlock@latest)');
    expect(spawnSync(link, ['doctor'], { env, encoding: 'utf8' }).stdout).toContain('update: npm install -g buildlock@latest');
    // Uninstall cleans up after buildlock but leaves the package to npm.
    mkdirSync(resolve(home, '.claude'), { recursive: true });
    run(['agents', 'install', '--target', 'claude', '--yes'], env);
    const removed = spawnSync(link, ['uninstall', '--yes'], { env, encoding: 'utf8' });
    expect(removed.status).toBe(0);
    expect(removed.stdout).toContain('npm uninstall -g buildlock');
    expect(existsSync(link)).toBe(true);
    expect(existsSync(real)).toBe(true);
    expect(existsSync(resolve(home, '.claude/CLAUDE.md'))).toBe(false);
    // bun's global copy, a project dependency and npx's cache.
    const bun = place(resolve(home, '.bun/install/global/node_modules/buildlock/bin'));
    expect(spawnSync(bun, ['update'], { env, encoding: 'utf8' }).stderr).toContain('bun add -g buildlock@latest');
    const dependency = place(resolve(root, 'app/node_modules/buildlock/bin'));
    expect(spawnSync(dependency, ['update'], { env, encoding: 'utf8' }).stderr).toContain(`a dependency of ${resolve(root, 'app')}`);
    const npx = place(resolve(home, '.npm/_npx/0a1b2c/node_modules/buildlock/bin'));
    expect(spawnSync(npx, ['update'], { env, encoding: 'utf8' }).stderr).toContain('npx buildlock@latest');
    const kept = spawnSync(npx, ['uninstall', '--yes', '--keep-agents'], { env, encoding: 'utf8' });
    expect(kept.status).toBe(0);
    expect(kept.stdout).toContain('Nothing to remove');
    expect(existsSync(npx)).toBe(true);
});

test('install.sh points a package manager copy back to it', () => {
    const { env, root } = sandbox();
    const pkg = resolve(root, 'lib/node_modules/buildlock/bin');
    mkdirSync(pkg, { recursive: true });
    copyFileSync(script, resolve(pkg, 'buildlock'));
    mkdirSync(resolve(root, 'bin'), { recursive: true });
    symlinkSync(resolve(pkg, 'buildlock'), resolve(root, 'bin/buildlock'));
    const result = spawnSync('bash', [installer, '--from', script, '--prefix', resolve(root, 'bin'), '--yes'], { env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm install -g buildlock@latest');
});
