// The live endpoint catalog (GET /endpoints, free, no key), cached on disk for
// 15 minutes. Every endpoint and parameter the CLI knows comes from here, so a
// new Scrapier endpoint works without a CLI release.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request, baseUrl, CliError, EXIT } from './api.js';
import { cacheDir } from './config.js';

const TTL_MS = 15 * 60 * 1000;

const cachePath = (env) => join(cacheDir(env), 'endpoints.json');

export async function loadCatalog({ env = process.env, refresh = false, warn = () => {} } = {}) {
    let cached = null;
    try { cached = JSON.parse(readFileSync(cachePath(env), 'utf8')); } catch { /* no cache yet */ }
    // A cache from another base URL (staging, tests) is not this catalog.
    if (cached && cached.base !== baseUrl(env)) cached = null;
    if (cached && !refresh && Date.now() - cached.fetched_at < TTL_MS) return normalize(cached.body);

    try {
        const body = await request('/endpoints', { env, retries: 2, timeoutMs: 60_000 });
        try {
            mkdirSync(cacheDir(env), { recursive: true });
            writeFileSync(cachePath(env), JSON.stringify({ base: baseUrl(env), fetched_at: Date.now(), body }));
        } catch { /* a read-only home must not break the CLI */ }
        return normalize(body);
    } catch (err) {
        if (!cached) throw err;
        warn(`Could not refresh the endpoint catalog (${err.message}); using the cached copy.`);
        return normalize(cached.body);
    }
}

// The key the rows sit under (posts, places, products…), read from the sample.
function sampleResultKey(sample) {
    const formatted = sample && typeof sample === 'object' && 'formatted' in sample ? sample.formatted : sample;
    if (!formatted || typeof formatted !== 'object') return null;
    return Object.keys(formatted).find((k) => Array.isArray(formatted[k]) && k !== 'raw_responses') ?? null;
}

function normalize(body) {
    const endpoints = [];
    for (const group of body.endpoints ?? []) {
        for (const api of group.apis ?? []) {
            endpoints.push({
                slug: String(api.endpoint).replace(/^\/+|\/+$/g, ''),
                platform: group.platform,
                name: api.name ?? '',
                // An endpoint the catalog has not priced is billed at the default, 2 credits.
                cost: api.cost_credit ?? 2,
                pagination: api.pagination ?? 'cursor',
                disabled: Boolean(api.disabled),
                disabledReason: api.disabled_reason ?? '',
                longRunning: Boolean(api.long_running),
                input: api.input ?? {},
                resultKey: sampleResultKey(api.sample_output),
            });
        }
    }
    return { endpoints };
}

export const platformKey = (p) => String(p).toLowerCase().replace(/[\s_-]+/g, '');

export function findEndpoint(catalog, slug) {
    const want = String(slug).replace(/^\/+|\/+$/g, '').toLowerCase();
    const found = catalog.endpoints.find((e) => e.slug === want);
    if (found) return found;
    const near = suggest(catalog, want);
    throw new CliError(
        `Unknown endpoint "${slug}".${near.length ? ` Did you mean: ${near.join(', ')}?` : ''} `
        + 'Find endpoints with: scrapier search <words>', EXIT.USAGE);
}

// Closest slugs to a typo: shared words first, then the longest shared prefix.
function suggest(catalog, want) {
    const words = want.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
    const prefix = (a) => { let i = 0; while (i < a.length && a[i] === want[i]) i++; return i; };
    return catalog.endpoints
        .map((e) => ({ slug: e.slug, hits: words.filter((w) => e.slug.includes(w)).length, pre: prefix(e.slug) }))
        .filter((r) => r.hits > 0 || r.pre >= 4)
        .sort((a, b) => b.hits - a.hits || b.pre - a.pre || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
        .slice(0, 5)
        .map((r) => r.slug);
}

// A word matches as typed or without a plural "s" ("posts" finds post-scraper).
const has = (hay, w) => hay.includes(w) || (w.length > 3 && w.endsWith('s') && hay.includes(w.slice(0, -1)));

// Every query word must appear in the slug, name or platform.
export function search(catalog, query = '', { platform } = {}) {
    const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const wantPlatform = platform ? platformKey(platform) : null;
    return catalog.endpoints
        .filter((e) => !wantPlatform || platformKey(e.platform) === wantPlatform)
        .map((e) => {
            const hay = `${e.slug} ${e.name} ${e.platform}`.toLowerCase();
            const hits = words.filter((w) => has(hay, w)).length;
            const slugHits = words.filter((w) => has(e.slug, w)).length;
            return { e, hits, slugHits };
        })
        .filter((r) => r.hits === words.length)
        .sort((a, b) => b.slugHits - a.slugHits || a.e.disabled - b.e.disabled || (a.e.slug < b.e.slug ? -1 : a.e.slug > b.e.slug ? 1 : 0))
        .map((r) => r.e);
}

export function platforms(catalog) {
    const counts = new Map();
    for (const e of catalog.endpoints) counts.set(e.platform, (counts.get(e.platform) ?? 0) + 1);
    return [...counts].map(([platform, endpoints]) => ({ platform, endpoints }));
}

// Maps a name the user typed (--page-size, a documented alias) to the real param.
export function resolveParam(endpoint, name) {
    if (name in endpoint.input) return name;
    const underscored = name.replace(/-/g, '_');
    if (underscored in endpoint.input) return underscored;
    for (const [param, spec] of Object.entries(endpoint.input)) {
        if ((spec.aliases ?? []).includes(name) || (spec.aliases ?? []).includes(underscored)) return param;
    }
    return null;
}
