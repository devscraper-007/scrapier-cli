// Black-box tests: every scenario runs against both CLIs (Node and Python) and a
// mock API, and the parity tests require byte-identical output from the two.
// Run: node --test tests/cli.test.mjs   (needs node >= 18 and python3 >= 3.8)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock, GOOD_KEY } from './mock-server.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IMPLS = [
    { name: 'node', cmd: process.execPath, args: [join(ROOT, 'node/bin/scrapier.js')] },
    { name: 'python', cmd: process.env.PYTHON || 'python3', args: ['-m', 'scrapier'] },
];

// The runner's environment minus anything that would leak a real key or API.
const INHERITED = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('SCRAPIER_')));

let mock;
before(async () => { mock = await startMock(); });
after(async () => { await mock.close(); });

function freshDirs() {
    const dir = mkdtempSync(join(tmpdir(), 'scrapier-cli-test-'));
    return { SCRAPIER_CONFIG_DIR: join(dir, 'config'), SCRAPIER_CACHE_DIR: join(dir, 'cache'), dir };
}

// Async spawn: the mock server lives in this process, so a sync spawn would deadlock.
function cli(impl, args, { env = {}, input, dirs = freshDirs() } = {}) {
    return new Promise((resolve) => {
        const child = spawn(impl.cmd, [...impl.args, ...args], {
            cwd: dirs.dir,
            env: {
                ...INHERITED, PYTHONPATH: join(ROOT, 'python/src'),
                SCRAPIER_API_BASE: mock.base, SCRAPIER_CONFIG_DIR: dirs.SCRAPIER_CONFIG_DIR,
                SCRAPIER_CACHE_DIR: dirs.SCRAPIER_CACHE_DIR, ...env,
            },
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => { stdout += d; });
        child.stderr.on('data', (d) => { stderr += d; });
        child.stdin.end(input ?? '');
        child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
}

const KEY = { SCRAPIER_API_KEY: GOOD_KEY };

async function both(args, opts) {
    const out = {};
    for (const impl of IMPLS) {
        mock.reset();
        out[impl.name] = { ...(await cli(impl, args, opts)), calls: [...mock.log] };
    }
    return out;
}

// ── parity ──────────────────────────────────────────────────────────────────

const PARITY = [
    ['--help'], ['run', '--help'], ['help', 'search'], ['--version'],
    ['platforms'], ['platforms', '--json'],
    ['search', 'instagram'], ['search', 'posts', '--json'], ['search', '--platform', 'truth-social'], ['search', 'zzz'],
    ['info', 'google-maps'], ['info', 'airbnb-listings'], ['info', 'truth-social-posts'], ['info', 'instagram-profile', '--json'],
    ['run', 'google-maps', '--queries', 'coffee', '--pages', '5'],
    ['run', 'google-maps', '--queries', 'coffee', '--pages', '2', '--format', 'csv'],
    ['run', 'google-maps', '--queries', 'coffee', '--pages', '3', '--format', 'jsonl'],
    ['run', 'instagram-profile', '--username', 'nasa', '--include_about'],
    ['run', 'instagram-profile', '--usernames', 'nasa', '--format', 'csv'],
    ['me'], ['me', '--json'],
    ['run', 'google-maps', '--queries', 'broke-later', '--pages', '3'],
    ['run', 'nope'], ['run', 'google-mapz'], ['run', 'instagram-profil'], ['run', 'google-maps'], ['run', 'google-maps', '--queries', 'x', '--pages', 'two'],
    ['bogus-command'],
];

for (const args of PARITY) {
    test(`parity: scrapier ${args.join(' ')}`, async () => {
        const r = await both(args, { env: KEY });
        assert.equal(r.python.stdout, r.node.stdout, 'stdout differs');
        assert.equal(r.python.stderr, r.node.stderr, 'stderr differs');
        assert.equal(r.python.code, r.node.code, 'exit code differs');
        assert.deepEqual(r.python.calls.map((c) => [c.method, c.url, c.body]), r.node.calls.map((c) => [c.method, c.url, c.body]), 'requests differ');
    });
}

// ── behaviour, per implementation ───────────────────────────────────────────

for (const impl of IMPLS) {
    const run = async (args, opts = {}) => { mock.reset(); return cli(impl, args, { env: KEY, ...opts }); };
    const t = (name, fn) => test(`${impl.name}: ${name}`, fn);

    t('a run POSTs JSON to the slug with a trailing slash and the key header', async () => {
        const r = await run(['run', 'google-maps', '--queries', 'coffee', '--use-proxy', 'no']);
        assert.equal(r.code, 0, r.stderr);
        const [call] = mock.calls('/google-maps/');
        assert.equal(call.method, 'POST');
        assert.equal(call.key, GOOD_KEY);
        assert.deepEqual(call.body, { queries: 'coffee', use_proxy: 'false' });
        assert.match(call.ua, new RegExp(`^scrapier-cli/0\\.1\\.0 \\(${impl.name}\\)$`));
        const out = JSON.parse(r.stdout);
        assert.equal(out.places.length, 2);
        assert.equal(out.next_cursor, 'c2');
        assert.match(r.stderr, /Done: 1 call, 2 places, 1 credit\./);
        assert.match(r.stderr, /More results: scrapier run google-maps --cursor c2/);
    });

    t('--pages follows next_cursor, sends only the cursor, and stops at null', async () => {
        const r = await run(['run', 'google-maps', '--queries', 'coffee', '--location', 'Austin', '--pages', '9']);
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(mock.calls('/google-maps/').map((c) => c.body), [
            { queries: 'coffee', location: 'Austin' }, { cursor: 'c2' }, { cursor: 'c3' },
        ]);
        const out = JSON.parse(r.stdout);
        assert.deepEqual(out.places.map((p) => p.name), ['Blue Bottle', 'Café "Ö", Berlin', 'Third']);
        assert.equal(out.next_cursor, null);
        assert.match(r.stderr, /Done: 3 calls, 3 places, 3 credits\./);
        assert.doesNotMatch(r.stderr, /More results/);
    });

    t('session cookies are re-sent with every cursor', async () => {
        const r = await run(['run', 'instagram-hashtag-posts', '--hashtag', 'travel', '--session_id', 'abc', '--pages', '2']);
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(mock.calls('/instagram-hashtag-posts/').map((c) => c.body), [
            { hashtag: 'travel', session_id: 'abc' }, { session_id: 'abc', cursor: 'h2' },
        ]);
        assert.deepEqual(JSON.parse(r.stdout).posts, [{ id: 'p1' }, { id: 'p2' }]);
    });

    t('--cursor alone continues a run without the required inputs', async () => {
        const r = await run(['run', 'google-maps', '--cursor', 'c2']);
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(mock.calls('/google-maps/')[0].body, { cursor: 'c2' });
    });

    t('csv flattens nested values and quotes commas and quotes', async () => {
        const r = await run(['run', 'google-maps', '--queries', 'coffee', '--pages', '2', '--format', 'csv']);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.stdout, [
            'name,rating,tags,open,address',
            'Blue Bottle,4.4,"[""wifi""]",,',
            '"Café ""Ö"", Berlin",,,true,',
            'Third,5,,,"{""city"":""Austin""}"',
            '',
        ].join('\r\n'));
    });

    t('jsonl writes one row per line, and -o writes to a file', async () => {
        const dirs = freshDirs();
        const r = await run(['run', 'google-maps', '--queries', 'coffee', '--format', 'jsonl', '-o', 'out.jsonl'], { dirs });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(r.stdout, '');
        const lines = readFileSync(join(dirs.dir, 'out.jsonl'), 'utf8').trim().split('\n');
        assert.deepEqual(lines.map((l) => JSON.parse(l).name), ['Blue Bottle', 'Café "Ö", Berlin']);
        assert.match(r.stderr, /Saved to out\.jsonl/);
    });

    t('a single lookup ignores --pages and is one row', async () => {
        const r = await run(['run', 'instagram-profile', '--usernames', 'nasa', '--pages', '3', '--format', 'jsonl']);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(mock.calls('/instagram-profile/').length, 1);
        assert.match(r.stderr, /returns a single result; ignoring --pages/);
        assert.equal(r.stdout.trim().split('\n').length, 1);
        assert.match(r.stderr, /Done: 1 call, .*2 credits\./);
    });

    t('aliases, dashes and -p map to real params; booleans normalize', async () => {
        const r = await run(['run', 'airbnb-listings', '--q', 'Paris', '-p', 'page_size=5']);
        assert.equal(r.code, 0, r.stderr);
        assert.deepEqual(mock.calls('/airbnb-listings/')[0].body, { query: 'Paris', page_size: '5' });
        assert.match(r.stderr, /long-running/);
    });

    t('bad input is rejected before any paid call', async () => {
        for (const [args, pattern] of [
            [['run', 'google-maps', '--queries', 'x', '--nope', '1'], /Unknown parameter --nope/],
            [['run', 'google-maps'], /Missing required --queries/],
            [['run', 'google-maps', '--queries', 'x', '--use_proxy', 'maybe'], /--use_proxy is true or false/],
            [['run', 'airbnb-listings', '--query', 'x', '--page_size', 'ten'], /--page_size must be a whole number/],
            [['run', 'google-maps', '--queries'], /--queries needs a value/],
            [['run', 'google-maps', '--queries', 'x', '--format', 'xml'], /--format is json, jsonl or csv/],
            [['run', 'google-mapz', '--queries', 'x'], /Did you mean: google-maps/],
        ]) {
            const r = await run(args);
            assert.equal(r.code, 1, `${args.join(' ')}: ${r.stderr}`);
            assert.match(r.stderr, pattern);
            assert.equal(mock.calls('/google-maps/').length + mock.calls('/airbnb-listings/').length, 0);
        }
    });

    t('a disabled endpoint is refused without a call', async () => {
        const r = await run(['run', 'truth-social-posts', '--username', 'x']);
        assert.equal(r.code, 2);
        assert.match(r.stderr, /disabled: Upstream is down\. Nothing was charged\./);
        assert.equal(mock.calls('/truth-social-posts/').length, 0);
    });

    t('runs that can cost 10+ credits need --yes when not interactive', async () => {
        let r = await run(['run', 'airbnb-listings', '--query', 'x', '--pages', '4']);
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stderr, /Done: 2 calls, 2 listings, 4 credits\./);
        r = await run(['run', 'airbnb-listings', '--query', 'x', '--pages', '5']);
        assert.equal(r.code, 1);
        assert.match(r.stderr, /can cost up to 10 credits \(2 credits per call x 5 pages\)\. Re-run with --yes/);
        assert.equal(mock.calls('/airbnb-listings/').length, 0);
        r = await run(['run', 'airbnb-listings', '--query', 'x', '--pages', '5', '--yes']);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(mock.calls('/airbnb-listings/').length, 2);
        assert.match(r.stderr, /Done: 2 calls, 2 listings, 4 credits\./);
    });

    t('an endpoint the catalog does not price costs 2 credits', async () => {
        const env = { ...KEY, SCRAPIER_API_BASE: mock.base.replace('/api/v2', '/unpriced/api/v2') };
        let r = await run(['info', 'google-maps', '--json'], { env });
        assert.equal(r.code, 0, r.stderr);
        assert.equal(JSON.parse(r.stdout).cost_credit, 2);
        r = await run(['info', 'google-maps'], { env });
        assert.match(r.stdout, /Cost: +2 credits per successful call/);
    });

    t('429 waits for Retry-After and retries', async () => {
        const r = await run(['run', 'google-maps', '--queries', '429']);
        assert.equal(r.code, 0, r.stderr);
        assert.equal(mock.calls('/google-maps/').length, 2);
        assert.match(r.stderr, /HTTP 429; retrying in 1\.0s \(attempt 2\)/);
    });

    t('5xx and a target-site 402 (no balance) are retried', async () => {
        for (const q of ['500', '402']) {
            const r = await run(['run', 'google-maps', '--queries', q]);
            assert.equal(r.code, 0, r.stderr);
            assert.equal(mock.calls('/google-maps/').length, 2, q);
        }
    });

    t('400 is not retried and exits 2', async () => {
        const r = await run(['run', 'google-maps', '--queries', '400']);
        assert.equal(r.code, 2);
        assert.match(r.stderr, /error: HTTP 400: Unusable query\./);
        assert.equal(mock.calls('/google-maps/').length, 1);
    });

    t('out of credits exits 4 without retrying', async () => {
        const r = await run(['run', 'google-maps', '--queries', 'x'], { env: { SCRAPIER_API_KEY: 'sk_live_broke' } });
        assert.equal(r.code, 4);
        assert.match(r.stderr, /Out of credits \(balance 0, this call needs 1\)/);
        assert.equal(mock.calls('/google-maps/').length, 1);
    });

    t('a bad key exits 3; no key exits 3 before any call', async () => {
        let r = await run(['me'], { env: { SCRAPIER_API_KEY: 'sk_live_nope' } });
        assert.equal(r.code, 3);
        assert.match(r.stderr, /invalid API key\. Check your API key/);
        r = await run(['run', 'google-maps', '--queries', 'x'], { env: {} });
        assert.equal(r.code, 3);
        assert.match(r.stderr, /No API key\. Run `scrapier login`/);
        assert.equal(mock.calls('/google-maps/').length, 0);
    });

    t('a failure mid-pagination keeps the pages already paid for', async () => {
        const r = await run(['run', 'google-maps', '--queries', 'broke-later', '--pages', '3']);
        assert.equal(r.code, 2);
        assert.equal(JSON.parse(r.stdout).places.length, 2);
        assert.match(r.stderr, /Stopped after 1 page \(results above were kept\): HTTP 400: Cursor expired\./);
    });

    t('login checks the key, saves it owner-only, and logout removes it', async () => {
        const dirs = freshDirs();
        let r = await run(['login'], { env: {}, dirs, input: `${GOOD_KEY}\n` });
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stderr, /Logged in as dev@example\.com \(Pro, 42 credits\)/);
        const path = join(dirs.SCRAPIER_CONFIG_DIR, 'config.json');
        assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { api_key: GOOD_KEY });
        if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);

        r = await run(['me'], { env: {}, dirs });
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /Credits:  42/);
        assert.match(r.stdout, /Key from: .*config\.json/);

        r = await run(['logout'], { env: {}, dirs });
        assert.equal(r.code, 0);
        assert.equal(existsSync(path), false);
    });

    t('login rejects a bad key and saves nothing', async () => {
        const dirs = freshDirs();
        const r = await run(['login', '--api-key', 'sk_live_nope'], { env: {}, dirs });
        assert.equal(r.code, 3);
        assert.equal(existsSync(join(dirs.SCRAPIER_CONFIG_DIR, 'config.json')), false);
    });

    t('--api-key beats SCRAPIER_API_KEY', async () => {
        const r = await run(['me', '--api-key', 'sk_live_nope']);
        assert.equal(r.code, 3);
    });

    t('the catalog is cached and reused', async () => {
        const dirs = freshDirs();
        await run(['search', 'maps'], { dirs });
        assert.equal(mock.calls('/endpoints').length, 1);
        await run(['info', 'google-maps'], { dirs });
        assert.equal(mock.calls('/endpoints').length, 0);
        await run(['info', 'google-maps', '--refresh'], { dirs });
        assert.equal(mock.calls('/endpoints').length, 1);
        rmSync(dirs.dir, { recursive: true, force: true });
    });
}

test('a key saved by one CLI works in the other', async () => {
    const dirs = freshDirs();
    mock.reset();
    let r = await cli(IMPLS[0], ['login'], { dirs, input: GOOD_KEY });
    assert.equal(r.code, 0, r.stderr);
    r = await cli(IMPLS[1], ['me', '--json'], { dirs });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(JSON.parse(r.stdout).credits.balance, 42);
});

test('both packages carry the same version and README', () => {
    const nodeVersion = JSON.parse(readFileSync(join(ROOT, 'node/package.json'), 'utf8')).version;
    const pyVersion = readFileSync(join(ROOT, 'python/src/scrapier/__init__.py'), 'utf8').match(/__version__ = "(.+)"/)[1];
    assert.equal(pyVersion, nodeVersion);
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    assert.equal(readFileSync(join(ROOT, 'node/README.md'), 'utf8'), readme, 'run: cp README.md node/README.md');
    assert.equal(readFileSync(join(ROOT, 'python/README.md'), 'utf8'), readme, 'run: cp README.md python/README.md');
});
