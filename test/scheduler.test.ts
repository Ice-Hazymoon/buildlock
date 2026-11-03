import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// BUILDLOCK_SCRIPT_UNDER_TEST runs these cases against another copy (e.g. the previous version).
const script = process.env.BUILDLOCK_SCRIPT_UNDER_TEST ?? resolve(import.meta.dirname, '../bin/buildlock');
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

interface IMachine {
    availableMb: number;
    cpuPressure: number;
}

/** Fake /proc metrics; the defaults are an idle machine. */
function writeMachine(procRoot: string, { availableMb, cpuPressure }: IMachine): void {
    mkdirSync(resolve(procRoot, 'pressure'), { recursive: true });
    writeFileSync(resolve(procRoot, 'loadavg'), '1.00 1.00 1.00 1/100 1\n');
    writeFileSync(resolve(procRoot, 'meminfo'), `MemTotal: 64000000 kB\nMemAvailable: ${availableMb * 1024} kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n`);
    writeFileSync(resolve(procRoot, 'pressure/cpu'), `some avg10=${cpuPressure} avg60=0 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0\n`);
    writeFileSync(resolve(procRoot, 'pressure/memory'), 'some avg10=0 avg60=0 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0\n');
    writeFileSync(resolve(procRoot, 'pressure/io'), 'some avg10=0 avg60=0 avg300=0 total=0\nfull avg10=0 avg60=0 avg300=0 total=0\n');
}

/** One slot (and one light slot) unless a case asks for more, so the queueing cases stay deterministic. */
function fixture(machine: Partial<IMachine> = {}, slots = 1, lightSlots = 1): { root: string; lock: string; env: NodeJS.ProcessEnv } {
    const root = mkdtempSync(resolve(tmpdir(), 'buildlock-test-'));
    roots.push(root);
    const procRoot = resolve(root, 'proc');
    writeMachine(procRoot, { availableMb: 40_000, cpuPressure: 1, ...machine });
    return {
        root,
        lock: resolve(root, 'buildlock.lock'),
        env: {
            ...process.env,
            BUILDLOCK_LOCK_PATH: resolve(root, 'buildlock.lock'),
            BUILDLOCK_PROC_ROOT: procRoot,
            // Ignore the machine's ~/.config/buildlock/config so tests see stock defaults.
            BUILDLOCK_CONFIG: '',
            BUILDLOCK_SLOTS: String(slots),
            BUILDLOCK_LIGHT_SLOTS: String(lightSlots),
            BUILDLOCK_START_GAP: '0',
            BUILDLOCK_JOB_MEMORY_MB: '2048',
            BUILDLOCK_RESERVE_MEMORY_MB: '2048',
            // Isolated so test runs never append to the real machine-wide job log.
            BUILDLOCK_JOB_LOG_DIR: resolve(root, 'joblog'),
        },
    };
}

function start(args: string[], env: NodeJS.ProcessEnv) {
    return spawn(script, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function finished(child: ReturnType<typeof start>, timeoutMs = 3_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, stdout, stderr };
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    try {
        const [code] = await once(child, 'close') as [number | null];
        return { code, stdout, stderr };
    } finally {
        clearTimeout(timer);
    }
}

async function waitFor(path: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (existsSync(path)) {
            return;
        }
        await Bun.sleep(10);
    }
    throw new Error(`Timed out waiting for ${path}`);
}

test('nested calls by the live holder finish without taking the lock twice', async () => {
    const { env } = fixture();
    const result = await finished(start(['bash', '-c', '"$BUILDLOCK_SCRIPT" bash -c "test \"$VITEST_MAX_WORKERS\" = 8"'], { ...env, BUILDLOCK_SCRIPT: script }));
    expect(result.code).toBe(0);
});

test('an unrelated process cannot use an inherited holder pid to bypass the queue', async () => {
    const { lock, env } = fixture();
    const holder = start(['sleep', '1'], env);
    try {
        await waitFor(`${lock}.holder`);
        const result = await finished(start(['true'], { ...env, BUILDLOCK_HELD: String(holder.pid), BUILDLOCK_TIMEOUT: '0.1' }));
        expect(result.code).toBe(73);
        expect(result.stderr).toContain('holder');
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('default callers wait and status shows holder and queued process', async () => {
    const { lock, env } = fixture();
    const holder = start(['sleep', '0.6'], env);
    try {
        await waitFor(`${lock}.holder`);
        const waiter = start(['true'], env);
        await waitFor(`${lock}.queue/${waiter.pid}`);
        const status = await finished(start(['--status'], env));
        expect(status.code).toBe(0);
        expect(status.stdout).toContain(String(holder.pid));
        expect(status.stdout).toContain(String(waiter.pid));
        expect((await finished(holder)).code).toBe(0);
        expect((await finished(waiter)).code).toBe(0);
    } finally {
        holder.kill('SIGTERM');
    }
});

test('a caller-specified timeout exits differently from task-lock busy', async () => {
    const { lock, env } = fixture();
    const holder = start(['sleep', '1'], env);
    try {
        await waitFor(`${lock}.holder`);
        const result = await finished(start(['true'], { ...env, BUILDLOCK_TIMEOUT: '0.1' }));
        expect(result.code).toBe(73);
        expect(result.code).not.toBe(75);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('the existing worker limits remain exported to the command', async () => {
    const { env } = fixture();
    const result = await finished(start(['bash', '-c', 'printf "%s,%s,%s,%s" "$VITEST_MAX_WORKERS" "$VITEST_MAX_FORKS" "$VITEST_MAX_THREADS" "$JEST_MAX_WORKERS"'], env));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('8,8,8,8');
});

test('a second job starts beside a running one while the machine has room', async () => {
    const { lock, env } = fixture({}, 2);
    const holder = start(['sleep', '1'], env);
    try {
        await waitFor(`${lock}.holder`);
        const result = await finished(start(['true'], { ...env, BUILDLOCK_TIMEOUT: '0.5' }));
        expect(result.code).toBe(0);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('a second job waits while running jobs may still need the memory', async () => {
    // 5000 MB available - ~2 GB the holder may still grow - 2 GB for the new job < 2 GB reserve.
    const { lock, env } = fixture({ availableMb: 5_000 }, 2);
    const holder = start(['sleep', '1'], env);
    try {
        await waitFor(`${lock}.holder`);
        const result = await finished(start(['true'], { ...env, BUILDLOCK_TIMEOUT: '0.3' }));
        expect(result.code).toBe(73);
        expect(result.stderr).toContain('next=memory:');
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('a second job waits while the CPU is contended, but a lone job still runs', async () => {
    const { lock, env } = fixture({ cpuPressure: 60 }, 2);
    expect((await finished(start(['true'], env))).code).toBe(0);
    const holder = start(['sleep', '1'], env);
    try {
        await waitFor(`${lock}.holder`);
        const result = await finished(start(['true'], { ...env, BUILDLOCK_TIMEOUT: '0.3' }));
        expect(result.code).toBe(73);
        expect(result.stderr).toContain('next=cpu pressure 60% > 25%');
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('critically short memory holds back even a lone job', async () => {
    const { env } = fixture({ availableMb: 1_000 }, 2);
    const result = await finished(start(['true'], { ...env, BUILDLOCK_TIMEOUT: '0.3' }));
    expect(result.code).toBe(73);
    expect(result.stderr).toContain('next=memory critical');
});

test('waiters start in arrival order', async () => {
    const { root, lock, env } = fixture();
    const order = resolve(root, 'order');
    const holder = start(['sleep', '0.5'], env);
    const waiters: ReturnType<typeof start>[] = [];
    try {
        await waitFor(`${lock}.holder`);
        for (const name of ['A', 'B', 'C', 'D']) {
            const waiter = start(['bash', '-c', `printf ${name} >> "${order}"`], env);
            waiters.push(waiter);
            await waitFor(`${lock}.queue/${waiter.pid}`);
        }
        for (const waiter of waiters) {
            expect((await finished(waiter, 6_000)).code).toBe(0);
        }
        expect(readFileSync(order, 'utf8')).toBe('ABCD');
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
}, 10_000);

test('status lists every running job and the verdict for the next one', async () => {
    const { lock, env } = fixture({}, 2);
    const first = start(['sleep', '1'], env);
    const second = start(['sleep', '1'], env);
    try {
        await waitFor(`${lock}.holder`);
        await waitFor(`${lock}.slot1.holder`);
        const status = await finished(start(['--status'], env));
        expect(status.stdout).toContain(`holder pid=${first.pid}`);
        expect(status.stdout).toContain(`holder pid=${second.pid}`);
        expect(status.stdout).toContain('scheduler running=2/2 next=all 2 slots busy');
    } finally {
        first.kill('SIGTERM');
        second.kill('SIGTERM');
        await finished(first);
        await finished(second);
    }
});

test('a job past its ramp-up window no longer reserves memory growth', async () => {
    const { lock, env } = fixture({ availableMb: 5_000 }, 2);
    const holder = start(['sleep', '1'], env);
    try {
        await waitFor(`${lock}.holder`);
        const result = await finished(start(['true'], { ...env, BUILDLOCK_RAMP_SECONDS: '0', BUILDLOCK_TIMEOUT: '0.5' }));
        expect(result.code).toBe(0);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('a running job reserves growth up to its own declared memory, not the default', async () => {
    const { lock, env } = fixture({ availableMb: 5_000 }, 2);
    const holder = start(['sleep', '1'], { ...env, BUILDLOCK_JOB_MEMORY_MB: '512' });
    try {
        await waitFor(`${lock}.holder`);
        const result = await finished(start(['true'], { ...env, BUILDLOCK_TIMEOUT: '0.5' }));
        expect(result.code).toBe(0);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('a light job starts on its own slot while a heavy job holds all heavy slots', async () => {
    const { lock, env } = fixture({}, 1, 1);
    const holder = start(['sleep', '1'], env);
    try {
        await waitFor(`${lock}.holder`);
        const result = await finished(start(['true'], { ...env, BUILDLOCK_CLASS: 'light', BUILDLOCK_TIMEOUT: '0.5' }));
        expect(result.code).toBe(0);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('a light job waits when memory is critical, just like a heavy one', async () => {
    const { env } = fixture({ availableMb: 1_000 }, 2, 2);
    const result = await finished(start(['true'], { ...env, BUILDLOCK_CLASS: 'light', BUILDLOCK_TIMEOUT: '0.3' }));
    expect(result.code).toBe(73);
    expect(result.stderr).toContain('next=memory critical');
});

test('a light job waits once its own slot cap is full, independent of free heavy slots', async () => {
    const { lock, env } = fixture({}, 2, 1);
    const holder = start(['sleep', '1'], { ...env, BUILDLOCK_CLASS: 'light' });
    try {
        await waitFor(`${lock}.light0.holder`);
        const status = await finished(start(['--status'], env));
        expect(status.stdout).toContain('holder');
        expect(status.stdout).toContain('class=light');
        expect(status.stdout).toContain('light=1/1');
        const result = await finished(start(['true'], { ...env, BUILDLOCK_CLASS: 'light', BUILDLOCK_TIMEOUT: '0.3' }));
        expect(result.code).toBe(73);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('a heavy call nested inside a light holder queues as heavy instead of passing through', async () => {
    const { lock, env } = fixture({}, 1, 1);
    // The only heavy slot stays busy, so a heavy job that bypassed the queue
    // via the light holder's BUILDLOCK_HELD would still finish almost
    // instantly (`true`); one that correctly queues instead times out.
    const heavyHolder = start(['sleep', '1'], env);
    try {
        await waitFor(`${lock}.holder`);
        const outer = start(
            ['bash', '-c', 'unset BUILDLOCK_CLASS; "$BUILDLOCK_SCRIPT" true'],
            { ...env, BUILDLOCK_SCRIPT: script, BUILDLOCK_CLASS: 'light', BUILDLOCK_TIMEOUT: '0.3' },
        );
        const result = await finished(outer);
        expect(result.code).toBe(73);
    } finally {
        heavyHolder.kill('SIGTERM');
        await finished(heavyHolder);
    }
});

test('a finished job appends a valid job-log line with its exit code', async () => {
    const { env } = fixture();
    const logDir = env.BUILDLOCK_JOB_LOG_DIR as string;
    const result = await finished(start(['bash', '-c', 'exit 7'], env));
    expect(result.code).toBe(7);
    const files = readdirSync(logDir).filter((name) => name.startsWith('jobs-') && name.endsWith('.jsonl'));
    expect(files).toHaveLength(1);
    const lines = readFileSync(resolve(logDir, files[0]), 'utf8').trim().split('\n');
    const entry = JSON.parse(lines.at(-1) as string) as Record<string, unknown>;
    expect(entry.exit).toBe(7);
    expect(entry.class).toBe('heavy');
    expect(typeof entry.pid).toBe('number');
    expect(typeof entry.at).toBe('string');
    expect(typeof entry.end).toBe('string');
    expect(typeof entry.waitSeconds).toBe('number');
    expect(typeof entry.runSeconds).toBe('number');
    expect(entry.budgetMb).toBe(2048);
    expect(entry.cmd).toContain('exit 7');
});
