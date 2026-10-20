// `scrapier` command line. Data goes to stdout, progress and errors to stderr,
// and the exit code says what went wrong (see EXIT), so scripts and AI agents
// can drive it. python/src/scrapier/cli.py mirrors this file; keep them in step.

import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { request, CliError, EXIT, KEYS_URL } from './api.js';
import { resolveKey, writeConfig, deleteConfig, configPath } from './config.js';
import { loadCatalog, findEndpoint, search, platforms, resolveParam } from './catalog.js';
import { json, jsonl, csv, listKeyOf, rowsOf } from './output.js';
import { VERSION } from './version.js';
import { HELP } from './help.js';

// Options that never take a value, so `--yes instagram-profile` stays two tokens.
const BOOLEAN_OPTIONS = new Set(['help', 'version', 'yes', 'quiet', 'json', 'refresh']);
const SHORT = { h: 'help', v: 'version', y: 'yes', q: 'quiet', o: 'output', p: 'param' };
// Options of `run`. Anything else on a run is an endpoint parameter.
const RUN_OPTIONS = new Set(['pages', 'format', 'output', 'api-key', 'yes', 'quiet', 'max-time', 'param', 'help']);
const CONFIRM_AT = 10;
const COOKIE_PARAM = /session|cookie/i;

export function parseArgs(argv) {
    const positionals = [];
    const flags = [];
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token === '--') { positionals.push(...argv.slice(i + 1)); break; }
        let name = null;
        if (token.startsWith('--') && token.length > 2) name = token.slice(2);
        else if (/^-[a-zA-Z]$/.test(token)) name = SHORT[token[1]] ?? token[1];
        if (name === null) { positionals.push(token); continue; }
        const eq = name.indexOf('=');
        if (eq > 0) { flags.push({ name: name.slice(0, eq), value: name.slice(eq + 1) }); continue; }
        if (!BOOLEAN_OPTIONS.has(name) && i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
            flags.push({ name, value: argv[++i] });
        } else {
            flags.push({ name, value: true });
        }
    }
    return { positionals, flags };
}

const flagValue = (flags, name) => flags.filter((f) => f.name === name).map((f) => f.value).pop();

class Io {
    constructor({ stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, env = process.env } = {}) {
        Object.assign(this, { stdout, stderr, stdin, env });
    }
    out(text) { this.stdout.write(text); }
    err(text) { this.stderr.write(text.endsWith('\n') ? text : `${text}\n`); }
}

function table(rows, headers) {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
    const line = (cells) => cells.map((c, i) => (i === cells.length - 1 ? String(c) : String(c).padEnd(widths[i]))).join('  ');
    return [line(headers), ...rows.map(line)].join('\n') + '\n';
}

function needKey(flags, io) {
    const { key, source } = resolveKey(flagValue(flags, 'api-key'), io.env);
    if (!key) {
        throw new CliError(
            `No API key. Run \`scrapier login\` or set SCRAPIER_API_KEY. Create a key at ${KEYS_URL}`, EXIT.AUTH);
    }
    return { key, source };
}

const onRetry = (io) => ({ reason, waitMs, attempt }) => io.err(
    `${reason}; retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1})`);

// ── commands ────────────────────────────────────────────────────────────────

async function cmdMe({ flags }, io) {
    const { key, source } = needKey(flags, io);
    const me = await request('/me', { apiKey: key, env: io.env, onRetry: onRetry(io) });
    if (flagValue(flags, 'json')) return io.out(json(me));
    const rows = [
        ['Email', me.email], ['Name', me.name], ['Plan', me.plan],
        ['Credits', me.credits?.balance], ['Key from', source],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');
    io.out(rows.map(([k, v]) => `${`${k}:`.padEnd(10)}${v}`).join('\n') + '\n');
}

async function readHidden(prompt, io) {
    const { stdin } = io;
    io.stderr.write(prompt);
    return new Promise((resolve, reject) => {
        let value = '';
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        const done = (fn) => { stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); io.stderr.write('\n'); fn(); };
        const onData = (chunk) => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n') return done(() => resolve(value));
                if (ch === '\u0003') return done(() => reject(new CliError('Cancelled.', EXIT.USAGE)));
                if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
                else value += ch;
            }
        };
        stdin.on('data', onData);
    });
}

async function readAll(stream) {
    let text = '';
    for await (const chunk of stream) text += chunk;
    return text;
}

async function cmdLogin({ flags }, io) {
    let key = flagValue(flags, 'api-key');
    if (typeof key !== 'string' || !key) {
        key = io.stdin.isTTY
            ? await readHidden(`Paste your API key (create one at ${KEYS_URL}): `, io)
            : await readAll(io.stdin);
    }
    key = String(key).trim();
    if (!key) throw new CliError('No key given.', EXIT.USAGE);
    const me = await request('/me', { apiKey: key, env: io.env, onRetry: onRetry(io) });
    const path = writeConfig({ api_key: key }, io.env);
    const who = [me.plan, me.credits?.balance !== undefined ? `${me.credits.balance} credits` : null].filter(Boolean).join(', ');
    io.err(`Logged in${me.email ? ` as ${me.email}` : ''}${who ? ` (${who})` : ''}. Key saved to ${path}`);
    if (io.env.SCRAPIER_API_KEY) io.err('Note: SCRAPIER_API_KEY is set and takes precedence over the saved key.');
}

async function cmdLogout(_args, io) {
    deleteConfig(io.env);
    io.err(`Removed the saved key (${configPath(io.env)}).`);
    if (io.env.SCRAPIER_API_KEY) io.err('SCRAPIER_API_KEY is still set in your environment.');
}

const catalogFor = (flags, io) => loadCatalog({ env: io.env, refresh: Boolean(flagValue(flags, 'refresh')), warn: (m) => io.err(m) });

async function cmdPlatforms({ flags }, io) {
    const list = platforms(await catalogFor(flags, io));
    if (flagValue(flags, 'json')) return io.out(json(list));
    io.out(table(list.map((p) => [p.platform, p.endpoints]), ['PLATFORM', 'ENDPOINTS']));
}

const credits = (n) => `${n} credit${n === 1 ? '' : 's'}`;

async function cmdSearch({ positionals, flags }, io) {
    const query = positionals.join(' ');
    const platform = flagValue(flags, 'platform');
    if (!query && typeof platform !== 'string') throw new CliError('Usage: scrapier search <words> [--platform <name>]', EXIT.USAGE);
    const catalog = await catalogFor(flags, io);
    let found = search(catalog, query, { platform: typeof platform === 'string' ? platform : undefined });
    const limit = Number(flagValue(flags, 'limit') ?? 25);
    if (Number.isInteger(limit) && limit > 0) found = found.slice(0, limit);
    if (flagValue(flags, 'json')) {
        return io.out(json(found.map((e) => ({
            endpoint: e.slug, name: e.name, platform: e.platform, cost_credit: e.cost,
            pagination: e.pagination, disabled: e.disabled,
        }))));
    }
    if (found.length === 0) return io.err(`No endpoints match "${query}". Try fewer words, or: scrapier platforms`);
    io.out(table(found.map((e) => [e.slug, e.cost, e.disabled ? `${e.name} (disabled)` : e.name]), ['ENDPOINT', 'COST', 'NAME']));
    io.err('Parameters and cost: scrapier info <endpoint>');
}

const shellQuote = (v) => (/^[\w@%+=:,./-]+$/.test(v) ? v : `"${String(v).replace(/(["\\$`])/g, '\\$1')}"`);

function exampleFor(e) {
    let names = Object.keys(e.input).filter((k) => e.input[k].required);
    if (names.length === 0) {
        const first = Object.keys(e.input).find((k) => !['cursor', 'use_proxy', 'raw_data'].includes(k) && e.input[k].default_value);
        names = first ? [first] : [];
    }
    return `scrapier run ${e.slug}${names.map((k) => ` --${k} ${shellQuote(e.input[k].default_value || '<value>')}`).join('')}`;
}

async function cmdInfo({ positionals, flags }, io) {
    if (!positionals[0]) throw new CliError('Usage: scrapier info <endpoint>', EXIT.USAGE);
    const e = findEndpoint(await catalogFor(flags, io), positionals[0]);
    if (flagValue(flags, 'json')) {
        return io.out(json({
            endpoint: e.slug, name: e.name, platform: e.platform, cost_credit: e.cost, pagination: e.pagination,
            long_running: e.longRunning, disabled: e.disabled, disabled_reason: e.disabledReason || null,
            result_key: e.resultKey, input: e.input,
        }));
    }
    const lines = [
        `${e.slug}: ${e.name}`,
        `Platform:    ${e.platform}`,
        `Cost:        ${credits(e.cost)} per successful call`,
        `Pagination:  ${e.pagination === 'single' ? 'single (one call, no pages)' : 'cursor (--pages N follows next_cursor)'}`,
    ];
    if (e.resultKey) lines.push(`Results in:  ${e.resultKey}`);
    if (e.disabled) lines.push(`Status:      disabled: ${e.disabledReason}`);
    if (e.longRunning) lines.push('Note:        long-running; a call can take several minutes');
    lines.push('', 'Parameters:');
    for (const [name, spec] of Object.entries(e.input)) {
        lines.push(`  --${name}  ${spec.type ?? 'string'}${spec.required ? ', required' : ''}`);
        const extra = [];
        if (spec.default_value) extra.push(`default: ${spec.default_value}`);
        if (spec.options?.length) extra.push(`one of: ${spec.options.join(', ')}`);
        if (spec.description) lines.push(`      ${spec.description}${extra.length ? ` (${extra.join('; ')})` : ''}`);
        else if (extra.length) lines.push(`      ${extra.join('; ')}`);
        if (spec.aliases?.length) lines.push(`      Aliases: ${spec.aliases.map((a) => `--${a}`).join(', ')}`);
    }
    lines.push('', 'Example:', `  ${exampleFor(e)}`);
    io.out(lines.join('\n') + '\n');
}

function normalizeValue(endpoint, param, value) {
    const spec = endpoint.input[param];
    const type = spec.type ?? 'string';
    if (type === 'boolean') {
        if (value === true) return 'true';
        const v = String(value).toLowerCase();
        if (['true', '1', 'yes', 'on'].includes(v)) return 'true';
        if (['false', '0', 'no', 'off'].includes(v)) return 'false';
        throw new CliError(`--${param} is true or false, not "${value}". Use --${param} or --${param}=false`, EXIT.USAGE);
    }
    if (value === true) throw new CliError(`--${param} needs a value.`, EXIT.USAGE);
    if (type === 'integer' && !/^-?\d+$/.test(String(value))) {
        throw new CliError(`--${param} must be a whole number, not "${value}".`, EXIT.USAGE);
    }
    return String(value);
}

function collectParams(endpoint, flags) {
    const params = {};
    const add = (name, value) => {
        const param = resolveParam(endpoint, name);
        if (!param) {
            throw new CliError(
                `Unknown parameter --${name} for ${endpoint.slug}. Valid: ${Object.keys(endpoint.input).map((k) => `--${k}`).join(', ')}`,
                EXIT.USAGE);
        }
        params[param] = normalizeValue(endpoint, param, value);
    };
    for (const { name, value } of flags) {
        if (name === 'param') {
            const text = String(value);
            const eq = text.indexOf('=');
            if (value === true || eq < 1) throw new CliError('--param takes key=value, e.g. -p timeout=30', EXIT.USAGE);
            add(text.slice(0, eq), text.slice(eq + 1));
        } else if (!RUN_OPTIONS.has(name)) {
            add(name, value);
        }
    }
    return params;
}

async function confirm(question, io) {
    const rl = createInterface({ input: io.stdin, output: io.stderr });
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
}

async function cmdRun({ positionals, flags }, io) {
    if (!positionals[0]) throw new CliError('Usage: scrapier run <endpoint> [--<param> <value> ...]. See: scrapier run --help', EXIT.USAGE);
    const endpoint = findEndpoint(await catalogFor(flags, io), positionals[0]);
    const quiet = Boolean(flagValue(flags, 'quiet'));
    const note = (m) => { if (!quiet) io.err(m); };

    const params = collectParams(endpoint, flags);
    if (endpoint.disabled) {
        throw new CliError(`${endpoint.slug} is disabled: ${endpoint.disabledReason} Nothing was charged.`, EXIT.API);
    }
    if (!('cursor' in params)) {
        const missing = Object.keys(endpoint.input).filter((k) => endpoint.input[k].required && !(k in params));
        if (missing.length) {
            throw new CliError(
                `Missing required ${missing.map((k) => `--${k}`).join(', ')} for ${endpoint.slug}. Example: ${exampleFor(endpoint)}`,
                EXIT.USAGE);
        }
    }

    const format = flagValue(flags, 'format') ?? 'json';
    if (!['json', 'jsonl', 'csv'].includes(format)) throw new CliError('--format is json, jsonl or csv.', EXIT.USAGE);
    const pagesFlag = flagValue(flags, 'pages') ?? '1';
    let pages = Number(pagesFlag);
    if (!Number.isInteger(pages) || pages < 1) throw new CliError('--pages must be a whole number of 1 or more.', EXIT.USAGE);
    if (pages > 1 && endpoint.pagination === 'single') {
        note(`${endpoint.slug} returns a single result; ignoring --pages.`);
        pages = 1;
    }
    const maxTime = Number(flagValue(flags, 'max-time') ?? 300);
    if (!(maxTime > 0)) throw new CliError('--max-time must be a number of seconds.', EXIT.USAGE);

    const estimate = endpoint.cost * pages;
    if (estimate >= CONFIRM_AT && !flagValue(flags, 'yes')) {
        const what = `This run can cost up to ${credits(estimate)} (${credits(endpoint.cost)} per call x ${pages} page${pages === 1 ? '' : 's'}).`;
        if (!(io.stdin.isTTY && io.stderr.isTTY)) throw new CliError(`${what} Re-run with --yes to confirm.`, EXIT.USAGE);
        if (!(await confirm(`${what} Continue? [y/N] `, io))) throw new CliError('Cancelled. Nothing was charged.', EXIT.USAGE);
    }

    const { key } = needKey(flags, io);
    if (endpoint.longRunning) note(`${endpoint.slug} is long-running; a call can take several minutes.`);

    // Pages after the first send only the cursor, plus any session cookie (not stored in the cursor).
    const cookies = Object.fromEntries(Object.entries(params).filter(([k]) => COOKIE_PARAM.test(k)));
    let merged = null;
    let listKey = null;
    let calls = 0;
    let cursor = null;
    let failure = null;
    for (let page = 1; page <= pages; page++) {
        let body;
        try {
            body = await request(`/${endpoint.slug}/`, {
                method: 'POST', body: page === 1 ? params : { ...cookies, cursor }, apiKey: key, env: io.env,
                timeoutMs: maxTime * 1000, onRetry: onRetry(io),
            });
        } catch (err) {
            if (calls === 0) throw err;
            failure = err;
            break;
        }
        calls++;
        const data = body?.data && typeof body.data === 'object' ? body.data : {};
        if (merged === null) {
            merged = { ...data };
            listKey = listKeyOf(data, endpoint.resultKey);
        } else if (listKey) {
            merged[listKey] = [...merged[listKey], ...(Array.isArray(data[listKey]) ? data[listKey] : [])];
        }
        cursor = data.next_cursor ?? null;
        if (pages > 1) note(`page ${page}: ${listKey ? `${(data[listKey] ?? []).length} ${listKey}` : 'done'}`);
        if (!cursor || !listKey) break;
    }
    if ('next_cursor' in merged || cursor) merged.next_cursor = cursor;

    const rows = rowsOf(merged, listKey);
    const text = format === 'json' ? json(merged) : format === 'jsonl' ? jsonl(rows) : csv(rows);
    const outPath = flagValue(flags, 'output');
    if (typeof outPath === 'string') writeFileSync(outPath, text);
    else io.out(text);

    const counted = listKey ? `, ${rows.length} ${listKey}` : '';
    note(`Done: ${calls} call${calls === 1 ? '' : 's'}${counted}, ${credits(calls * endpoint.cost)}.${typeof outPath === 'string' ? ` Saved to ${outPath}` : ''}`);
    if (cursor) note(`More results: scrapier run ${endpoint.slug} --cursor ${cursor}`);
    if (failure) {
        failure.message = `Stopped after ${calls} page${calls === 1 ? '' : 's'} (results above were kept): ${failure.message}`;
        throw failure;
    }
}

const COMMANDS = { me: cmdMe, login: cmdLogin, logout: cmdLogout, platforms: cmdPlatforms, search: cmdSearch, info: cmdInfo, run: cmdRun };

export async function main(argv, streams = {}) {
    const io = new Io(streams);
    const [command, ...rest] = argv;
    const args = parseArgs(rest);
    try {
        if (!command || command === 'help' || command === '--help' || command === '-h') {
            io.out(HELP[rest[0]] ?? HELP.main);
            return EXIT.OK;
        }
        if (command === '--version' || command === '-v' || command === 'version') {
            io.out(`${VERSION}\n`);
            return EXIT.OK;
        }
        const handler = COMMANDS[command];
        if (!handler) throw new CliError(`Unknown command "${command}". See: scrapier --help`, EXIT.USAGE);
        if (flagValue(args.flags, 'help')) {
            io.out(HELP[command]);
            return EXIT.OK;
        }
        await handler(args, io);
        return EXIT.OK;
    } catch (err) {
        if (err instanceof CliError) {
            io.err(`error: ${err.message}`);
            return err.exitCode;
        }
        io.err(`error: ${err?.stack ?? err}`);
        return EXIT.API;
    }
}
