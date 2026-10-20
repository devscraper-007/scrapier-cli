// HTTP client for the Scrapier REST API: auth header, timeouts, and the retry
// rules from https://docs.scrapier.io/errors/ (failed calls are never billed).

import { VERSION } from './version.js';

export const DEFAULT_BASE = 'https://proxy.scrapier.io/api/v2';
export const KEYS_URL = 'https://app.scrapier.io/dashboard/api-keys';
export const BILLING_URL = 'https://app.scrapier.io/dashboard/billing';

// Process exit codes. Documented in the README; scripts and agents branch on them.
export const EXIT = { OK: 0, USAGE: 1, API: 2, AUTH: 3, CREDITS: 4 };

export class CliError extends Error {
    constructor(message, exitCode = EXIT.USAGE, extra = {}) {
        super(message);
        this.exitCode = exitCode;
        Object.assign(this, extra);
    }
}

export const baseUrl = (env = process.env) => (env.SCRAPIER_API_BASE || DEFAULT_BASE).replace(/\/+$/, '');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function classify(status, body) {
    const message = body.error ?? body.detail ?? `HTTP ${status}`;
    if (status === 402 && 'balance' in body) {
        return { retry: false, error: new CliError(
            `Out of credits (balance ${body.balance}, this call needs ${body.required}). Top up at ${BILLING_URL}`,
            EXIT.CREDITS, { status }) };
    }
    if (status === 401 || status === 403) {
        return { retry: false, error: new CliError(
            `${message} Check your API key (create one at ${KEYS_URL}).`, EXIT.AUTH, { status }) };
    }
    // 429, any 5xx, and a 402 passed through from the target site are free to retry.
    const retry = status === 429 || status >= 500 || status === 402;
    return { retry, error: new CliError(`HTTP ${status}: ${message}`, EXIT.API, { status }) };
}

/**
 * Call the API and return the parsed JSON body of a 2xx response.
 * POST sends `body` as JSON; GET sends no body.
 */
export async function request(path, {
    method = 'GET', body, apiKey, env = process.env, timeoutMs = 300_000, retries = 3, onRetry = () => {},
} = {}) {
    const url = `${baseUrl(env)}${path}`;
    const headers = { 'User-Agent': `scrapier-cli/${VERSION} (node)`, Accept: 'application/json' };
    if (apiKey) headers['X-API-Key'] = apiKey;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
        let res;
        try {
            res = await fetch(url, {
                method, headers,
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            if (err?.name === 'TimeoutError') {
                // Not retried: the scrape may have finished server-side and been billed.
                throw new CliError(
                    `No response after ${Math.round(timeoutMs / 1000)}s. The scrape may still have completed `
                    + 'and been billed, so it was not retried. Raise the limit with --max-time.', EXIT.API);
            }
            if (attempt >= retries) throw new CliError(`Could not reach ${url}: ${err?.cause?.message ?? err.message}`, EXIT.API);
            const waitMs = backoff(attempt);
            onRetry({ reason: 'network error', waitMs, attempt: attempt + 1 });
            await sleep(waitMs);
            continue;
        }

        const text = await res.text();
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: text.slice(0, 200) }; }
        if (res.ok) return parsed;

        const { retry, error } = classify(res.status, parsed);
        if (!retry || attempt >= retries) throw error;
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
        onRetry({ reason: `HTTP ${res.status}`, waitMs, attempt: attempt + 1 });
        await sleep(waitMs);
    }
}

// Exponential backoff with jitter: about 1 s, 2 s, 4 s… capped at 30 s.
function backoff(attempt) {
    return Math.min(30_000, 2 ** attempt * 1000) * (0.5 + Math.random());
}
