import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
            // The caller's own buildlock settings (a test run inside buildlock) stay out.
            ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(BUILDLOCK_|VITEST_MAX_|JEST_MAX_)/.test(key))),
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

function start(args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
    return spawn(script, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
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
    for (let attempt = 0; attempt < 300; attempt++) {
        if (existsSync(path)) {
            return;
        }
        await Bun.sleep(10);
    }
    throw new Error(`Timed out waiting for ${path}`);
}

test('nested calls by the live holder finish without taking the lock twice', async () => {
    const { env } = fixture();
    const result = await finished(start(['bash', '-c', '"$BUILDLOCK_SCRIPT" true'], { ...env, BUILDLOCK_SCRIPT: script }));
    expect(result.code).toBe(0);
});

test('an unrelated process cannot use an inherited holder pid to bypass the queue', async () => {
    const { lock, env } = fixture();
    const holder = start(['sleep', '1'], env);
    try {
        await waitFor(`${lock}.holder`);
        const result = await finished(start(['true'], { ...env, BUILDLOCK_HELD: String(holder.pid), BUILDLOCK_TIMEOUT: '0.1' }));
        expect(result.code).toBe(73);
        expect(result.stderr).toContain('the command did not run');
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

test('the Vitest worker cap is exported only when asked for', async () => {
    // WORKERS defaults to min(8, cores): pin the cores so a 4-core CI runner agrees.
    const env = { ...fixture().env, BUILDLOCK_CORES: '16' };
    const show = ['bash', '-c', 'printf "%s,%s" "$BUILDLOCK_WORKERS" "${VITEST_MAX_WORKERS:-unset}"'];
    expect((await finished(start(show, env))).stdout).toBe('8,unset');
    expect((await finished(start(show, { ...env, BUILDLOCK_EXPORT_WORKERS: 'on' }))).stdout).toBe('8,8');
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
        expect(result.stderr).toContain('not enough free memory');
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
        expect(result.stderr).toContain('CPU pressure 60%, limit 25%');
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('critically short memory holds back even a lone job', async () => {
    const { env } = fixture({ availableMb: 1_000 }, 2);
    const result = await finished(start(['true'], { ...env, BUILDLOCK_TIMEOUT: '0.3' }));
    expect(result.code).toBe(73);
    expect(result.stderr).toContain('memory is critically low');
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
    expect(result.stderr).toContain('memory is critically low');
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

function jobLog(env: NodeJS.ProcessEnv): Array<Record<string, unknown>> {
    const logDir = env.BUILDLOCK_JOB_LOG_DIR as string;
    return readdirSync(logDir).filter((name) => name.endsWith('.jsonl'))
        .flatMap((name) => readFileSync(resolve(logDir, name), 'utf8').trim().split('\n'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('a job held back by memory, then admitted, logs the seconds under waitReasons.memory', async () => {
    // 3500 MB free is above the critical floor but below job (2048) + reserve (2048) once a job runs.
    const { root, lock, env } = fixture({ availableMb: 3_500 }, 2, 1);
    const holder = start(['sleep', '30'], env);
    try {
        await waitFor(`${lock}.holder`);
        const waiter = start(['true'], env);
        await Bun.sleep(2_200);
        writeMachine(resolve(root, 'proc'), { availableMb: 40_000, cpuPressure: 1 });
        const result = await finished(waiter, 8_000);
        expect(result.code).toBe(0);
        const entry = jobLog(env).find((line) => line.cmd === 'true') as Record<string, unknown>;
        const reasons = entry.waitReasons as Record<string, number>;
        expect(Object.keys(reasons)).toEqual(['memory']);
        expect(reasons.memory).toBeGreaterThanOrEqual(2);
        expect(Math.abs(reasons.memory - (entry.waitSeconds as number))).toBeLessThanOrEqual(1);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('a job admitted at once logs no waitReasons', async () => {
    const { env } = fixture();
    expect((await finished(start(['true'], env))).code).toBe(0);
    const [entry] = jobLog(env);
    expect(entry.waitSeconds).toBe(0);
    expect('waitReasons' in entry).toBe(false);
});

test('a job queued behind another one logs its wait as order', async () => {
    const { lock, env } = fixture({}, 1, 1);
    const holder = start(['sleep', '30'], env);
    try {
        await waitFor(`${lock}.holder`);
        const first = start(['true'], env);
        await Bun.sleep(300);
        const second = start(['true'], env);
        await Bun.sleep(1_800);
        holder.kill('SIGTERM');
        await finished(holder);
        expect((await finished(first, 8_000)).code).toBe(0);
        expect((await finished(second, 8_000)).code).toBe(0);
        const waited = jobLog(env).filter((line) => line.cmd === 'true');
        const orders = waited.map((line) => (line.waitReasons as Record<string, number>).order ?? 0);
        expect(Math.max(...orders)).toBeGreaterThanOrEqual(1);
    } finally {
        holder.kill('SIGTERM');
    }
});

/** Three job-log runs of `cmd` in `cwd` (not a git checkout, so its key is `cwd::cmd`): a learned profile. */
function learn(env: NodeJS.ProcessEnv, cwd: string, cmd: string, peakMb: number, runSeconds: number): void {
    const logDir = env.BUILDLOCK_JOB_LOG_DIR as string;
    mkdirSync(logDir, { recursive: true });
    const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    const line = `{"at":"${at}","end":"${at}","pid":1,"cwd":"${cwd}","class":"heavy","budgetMb":2048,"waitSeconds":0,"runSeconds":${runSeconds},"exit":0,"cmd":"${cmd}","key":"${cwd}::${cmd}","peakMb":${peakMb},"budgetSource":"default","admission":"free"}\n`;
    appendFileSync(resolve(logDir, `jobs-${new Date().toISOString().slice(0, 7)}.jsonl`), line.repeat(3));
}

function queued(lock: string): string[] {
    return existsSync(`${lock}.queue`) ? readdirSync(`${lock}.queue`).filter((name) => /^\d+$/.test(name)) : [];
}

/** Memory-wait cases: no ramp-up growth (so only the budgets count) and a 1 GB critical floor. */
function memoryFixture(availableMb: number, extra: NodeJS.ProcessEnv = {}) {
    const fx = fixture({ availableMb }, 3, 1);
    fx.env = { ...fx.env, BUILDLOCK_RAMP_SECONDS: '0', BUILDLOCK_CRITICAL_MEMORY_MB: '1024', ...extra };
    return fx;
}

test('a short learned job backfills past a head waiting on memory; an unknown one does not', async () => {
    // 10000 MB free - 9000 MB for the head < 2048 MB reserve. The short job
    // needs 2756 MB and is learned to run 90 s: too big and long for the light lane.
    const { root, lock, env } = memoryFixture(10_000);
    learn(env, root, 'sleep 0.3', 2_000, 90);
    const holder = start(['sleep', '30'], env, root);
    await waitFor(`${lock}.holder`);
    const head = start(['sleep', '0.1'], { ...env, BUILDLOCK_JOB_MEMORY_MB: '9000' }, root);
    try {
        await waitFor(`${lock}.queue/${head.pid}`);
        await Bun.sleep(300);
        const unknown = await finished(start(['true'], { ...env, BUILDLOCK_TIMEOUT: '1.5' }, root), 4_000);
        expect(unknown.code).toBe(73);
        const short = await finished(start(['sleep', '0.3'], env, root), 6_000);
        expect(short.code).toBe(0);
        expect(queued(lock)).toContain(String(head.pid));
        const entry = jobLog(env).find((line) => line.cmd === 'sleep 0.3' && line.pid !== 1) as Record<string, unknown>;
        expect(entry.admission).toBe('backfill');
        const status = await finished(start(['--status'], env, root));
        expect(status.stdout).toContain('backfill=yes');
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
    expect((await finished(head, 6_000)).code).toBe(0);
}, 20_000);

test('backfill keeps arrival order: a later candidate never passes an earlier one that does not fit', async () => {
    const { root, lock, env } = memoryFixture(10_000);
    learn(env, root, 'sleep 0.2', 7_000, 90);
    learn(env, root, 'sleep 0.3', 2_000, 90);
    const holder = start(['sleep', '30'], env, root);
    await waitFor(`${lock}.holder`);
    const head = start(['true'], { ...env, BUILDLOCK_JOB_MEMORY_MB: '9000' }, root);
    try {
        await waitFor(`${lock}.queue/${head.pid}`);
        const big = start(['sleep', '0.2'], { ...env, BUILDLOCK_TIMEOUT: '2' }, root);
        const bigDone = finished(big, 6_000);
        await waitFor(`${lock}.queue/${big.pid}`);
        const small = await finished(start(['sleep', '0.3'], { ...env, BUILDLOCK_TIMEOUT: '1.5' }, root), 4_000);
        expect(small.code).toBe(73);
        expect((await bigDone).code).toBe(73);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
        head.kill('SIGTERM');
        await finished(head);
    }
}, 15_000);

test('a head protected after the starvation limit stops backfill, unless even the floor cannot fit it', async () => {
    const { root, lock, env } = memoryFixture(10_000, { BUILDLOCK_HEAVY_STARVE_SECONDS: '0' });
    learn(env, root, 'sleep 0.3', 2_000, 90);
    const holder = start(['sleep', '30'], env, root);
    try {
        await waitFor(`${lock}.holder`);
        // 10000 - 8500 >= the 1024 MB floor: the head can still get in soon, so it is protected.
        const head = start(['true'], { ...env, BUILDLOCK_JOB_MEMORY_MB: '8500' }, root);
        await waitFor(`${lock}.queue/${head.pid}`);
        await Bun.sleep(300);
        expect((await finished(start(['sleep', '0.3'], { ...env, BUILDLOCK_TIMEOUT: '1.5' }, root), 4_000)).code).toBe(73);
        head.kill('SIGTERM');
        await finished(head);
        // 10000 - 9500 < 1024: only memory outside buildlock can help this head, so short jobs go.
        const hopeless = start(['true'], { ...env, BUILDLOCK_JOB_MEMORY_MB: '9500' }, root);
        await waitFor(`${lock}.queue/${hopeless.pid}`);
        await Bun.sleep(300);
        expect((await finished(start(['sleep', '0.3'], env, root), 6_000)).code).toBe(0);
        hopeless.kill('SIGTERM');
        await finished(hopeless);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
}, 20_000);

test('a head waiting on memory nobody in buildlock will free starts on the critical floor after the relax time', async () => {
    // 8500 - 7000 < 2048 reserve, but >= the 1024 MB floor.
    const { root, lock, env } = memoryFixture(8_500, { BUILDLOCK_MEMORY_RELAX_SECONDS: '2' });
    const holder = start(['sleep', '30'], env, root);
    try {
        await waitFor(`${lock}.holder`);
        const head = await finished(start(['true'], { ...env, BUILDLOCK_JOB_MEMORY_MB: '7000' }, root), 8_000);
        expect(head.code).toBe(0);
        expect(head.stderr).toContain('only the critical floor was kept free');
        const entry = jobLog(env).find((line) => line.cmd === 'true') as Record<string, unknown>;
        expect(entry.admission).toBe('memory-relaxed');
        expect(entry.waitSeconds as number).toBeGreaterThanOrEqual(1);
        expect((entry.waitReasons as Record<string, number>).memory).toBeGreaterThanOrEqual(1);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
}, 15_000);

test('MEMORY_RELAX_SECONDS=0 turns the relaxed memory check off', async () => {
    const { root, lock, env } = memoryFixture(8_500, { BUILDLOCK_MEMORY_RELAX_SECONDS: '0' });
    const holder = start(['sleep', '30'], env, root);
    try {
        await waitFor(`${lock}.holder`);
        const head = await finished(start(['true'], { ...env, BUILDLOCK_JOB_MEMORY_MB: '7000', BUILDLOCK_TIMEOUT: '2' }, root), 6_000);
        expect(head.code).toBe(73);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
}, 15_000);

test('only one backfilled job runs at a time past a hopeless head', async () => {
    const { root, lock, env } = memoryFixture(10_000, { BUILDLOCK_HEAVY_STARVE_SECONDS: '0' });
    learn(env, root, 'sleep 2', 2_000, 90);
    learn(env, root, 'sleep 0.3', 2_000, 90);
    const holder = start(['sleep', '30'], env, root);
    try {
        await waitFor(`${lock}.holder`);
        // 10000 - 9500 < the 1024 MB floor: hopeless, so short jobs may go, but one at a time.
        const hopeless = start(['true'], { ...env, BUILDLOCK_JOB_MEMORY_MB: '9500' }, root);
        await waitFor(`${lock}.queue/${hopeless.pid}`);
        await Bun.sleep(300);
        const first = start(['sleep', '2'], env, root);
        await waitFor(`${lock}.backfilled.${first.pid}`);
        expect((await finished(start(['sleep', '0.3'], { ...env, BUILDLOCK_TIMEOUT: '1' }, root), 4_000)).code).toBe(73);
        expect((await finished(first, 6_000)).code).toBe(0);
        expect(existsSync(`${lock}.backfilled.${first.pid}`)).toBe(false);
        hopeless.kill('SIGTERM');
        await finished(hopeless);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
}, 20_000);

test('a short-light job above LIGHT_MAX_MB keeps the start gap', async () => {
    const { root, lock, env } = memoryFixture(60_000, { BUILDLOCK_START_GAP: '30', BUILDLOCK_LIGHT_SHORT_MAX_MB: '5120' });
    learn(env, root, 'sleep 0.2', 3_000, 10);
    const holder = start(['sleep', '30'], env, root);
    try {
        await waitFor(`${lock}.holder`);
        const short = await finished(start(['sleep', '0.2'], { ...env, BUILDLOCK_TIMEOUT: '1.5' }, root), 5_000);
        expect(short.code).toBe(73);
        expect(short.stderr).toMatch(/gap|ago/);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
}, 15_000);

test('the relaxed memory check waits while a job is still ramping up, and status says so', async () => {
    const { root, lock, env } = memoryFixture(8_500, { BUILDLOCK_MEMORY_RELAX_SECONDS: '1', BUILDLOCK_RAMP_SECONDS: '240', BUILDLOCK_JOB_MEMORY_MB: '512' });
    const holder = start(['sleep', '30'], env, root);
    try {
        await waitFor(`${lock}.holder`);
        const head = start(['true'], { ...env, BUILDLOCK_JOB_MEMORY_MB: '7000', BUILDLOCK_TIMEOUT: '3' }, root);
        await waitFor(`${lock}.heavywait`);
        await Bun.sleep(1_500);
        const status = await finished(start(['--status'], env, root));
        expect(status.stdout).toContain('relaxed=no');
        expect(status.stdout).toMatch(/next=memory: 8500MB available - \d+MB growth of ramping jobs - 7000MB/);
        const human = await finished(start(['status'], env, root));
        expect(human.stdout).toContain('once 1 job(s) starting up settle');
        expect((await finished(head, 6_000)).code).toBe(73);
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
}, 15_000);

test('status and explain say when the relaxed memory check applies', async () => {
    const { root, lock, env } = memoryFixture(8_500, { BUILDLOCK_MEMORY_RELAX_SECONDS: '2' });
    const holder = start(['sleep', '30'], env, root);
    try {
        await waitFor(`${lock}.holder`);
        // A head (the test process stands in for it) on memory for 5 seconds with a 7000 MB budget.
        writeFileSync(`${lock}.heavywait`, `${process.pid}\t${Math.floor(Date.now() / 1000) - 5}\t7000\n`);
        const stable = await finished(start(['--status'], env, root));
        expect(stable.stdout).toContain('next=start');
        expect(stable.stdout).toContain('relaxed=yes');
        expect((await finished(start(['status'], env, root))).stdout).toContain('memory relaxed');
        const explain = await finished(start(['--explain', 'true'], { ...env, BUILDLOCK_JOB_MEMORY_MB: '7000' }, root));
        expect(explain.stdout).toContain('verdict: memory: ');
        expect(explain.stdout).toContain('relaxed: start after 2s on memory');
        expect(explain.stdout).toContain('backfill: no (fewer than 3 runs)');
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
});

test('a short command takes the light lane with a larger memory cap; a long or larger one stays heavy', async () => {
    const { root, env } = fixture();
    const explain = async (cmd: string) => (await finished(start(['--explain', ...cmd.split(' ')], env, root))).stdout;
    learn(env, root, 'sleep 1', 3_000, 9);
    learn(env, root, 'sleep 2', 3_000, 150);
    learn(env, root, 'sleep 3', 4_500, 9);
    expect(await explain('sleep 1')).toContain('class: light budget=4006MB');
    expect(await explain('sleep 2')).toContain('class: heavy budget=4006MB');
    expect(await explain('sleep 3')).toContain('class: heavy budget=5881MB');
    expect(await explain('sleep 3')).toContain('backfill: yes (learned p90 run 9s <= 120s)');
    expect(await explain('sleep 2')).toContain('backfill: no (learned p90 run 150s > 120s)');
    expect(await explain('sleep 1')).toContain('backfill: no (light lane)');
});

test('a short light job still leaves a protected heavy head its memory', async () => {
    const { root, lock, env } = fixture({}, 2, 2);
    env.BUILDLOCK_HEAVY_STARVE_SECONDS = '1';
    learn(env, root, 'sleep 0.1', 3_000, 2);
    const holder = start(['sleep', '30'], env, root);
    try {
        await waitFor(`${lock}.holder`);
        expect((await finished(start(['sleep', '0.1'], { ...env, BUILDLOCK_TIMEOUT: '2' }, root), 4_000)).code).toBe(0);
        // A head on memory for a while with a 35 GB budget; the holder is still ramping up, so it is protected.
        writeFileSync(`${lock}.heavywait`, `${process.pid}\t${Math.floor(Date.now() / 1000) - 5}\t35000\n`);
        const starved = await finished(start(['sleep', '0.1'], { ...env, BUILDLOCK_TIMEOUT: '0.5' }, root));
        expect(starved.code).toBe(73);
        expect(starved.stderr).toContain('for a heavy job that has waited longer');
    } finally {
        holder.kill('SIGTERM');
        await finished(holder);
    }
}, 10_000);
