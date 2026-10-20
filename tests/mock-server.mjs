// A stand-in for proxy.scrapier.io/api/v2, with scenarios picked by the input
// value (queries=429 answers 429 once, and so on). Every call is logged so tests
// can check what the CLI sent and how often it retried.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const CATALOG = readFileSync(new URL('./fixtures/catalog.json', import.meta.url), 'utf8');
export const GOOD_KEY = 'sk_live_good';

const PLACES = {
    first: { queries: 'coffee', places: [{ name: 'Blue Bottle', rating: 4.4, tags: ['wifi'] }, { name: 'Café "Ö", Berlin', rating: null, open: true }], next_cursor: 'c2' },
    c2: { queries: 'coffee', places: [{ name: 'Third', rating: 5, address: { city: 'Austin' } }], next_cursor: 'c3' },
    c3: { queries: 'coffee', places: [], next_cursor: null },
};

export function startMock() {
    const log = [];
    const seen = new Map(); // scenario -> times hit, for "fail once" cases
    const once = (name) => { const n = seen.get(name) ?? 0; seen.set(name, n + 1); return n === 0; };

    const server = createServer(async (req, res) => {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : null;
        const key = req.headers['x-api-key'];
        log.push({ method: req.method, url: req.url, key, body, ua: req.headers['user-agent'] });
        const send = (status, payload, headers = {}) => {
            res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
            res.end(JSON.stringify(payload));
        };

        if (req.url === '/api/v2/endpoints') return res.end(CATALOG);
        if (req.url === '/api/v2/me') {
            if (key === GOOD_KEY) return send(200, { user_id: 'u1', email: 'dev@example.com', name: 'Dev', credits: { balance: 42 }, plan: 'Pro' });
            return send(403, { detail: 'Authentication service unavailable or invalid API key.' });
        }
        if (key === 'sk_live_broke') return send(402, { error: 'Insufficient credits. Buy more to scrape more.', balance: 0, required: 1 });
        if (key !== GOOD_KEY) return send(403, { detail: 'API key has been revoked.' });

        if (req.url === '/api/v2/google-maps/') {
            const q = body?.queries;
            const cursor = body?.cursor;
            if (q === '429' && once('429')) return send(429, { detail: 'Request was throttled.' }, { 'Retry-After': '1' });
            if (q === '500' && once('500')) return send(500, { success: false, error: 'Internal server error: boom' });
            if (q === '402' && once('402')) return send(402, { success: false, error: 'Payment Required (from target site)' });
            if (q === '400') return send(400, { success: false, error: 'Unusable query.' });
            if (cursor === 'boom') return send(400, { success: false, error: 'Cursor expired.' });
            if (q === 'broke-later') return send(200, { success: true, data: { ...PLACES.first, next_cursor: 'boom' } });
            if (cursor) return send(200, { success: true, data: PLACES[cursor] ?? PLACES.c3 });
            return send(200, { success: true, data: PLACES.first });
        }
        if (req.url === '/api/v2/instagram-profile/') {
            return send(200, { success: true, data: { usernames: body.usernames, profile: { username: body.usernames, followers: 10, about: body.include_about === 'true' ? { country: 'US' } : null }, next_cursor: null } });
        }
        if (req.url === '/api/v2/instagram-hashtag-posts/') {
            if (!body.session_id) return send(400, { success: false, error: 'session_id is required.' });
            if (body.cursor) return send(200, { success: true, data: { posts: [{ id: 'p2' }], next_cursor: null } });
            return send(200, { success: true, data: { hashtag: body.hashtag, posts: [{ id: 'p1' }], next_cursor: 'h2' } });
        }
        if (req.url === '/api/v2/airbnb-listings/') {
            return send(200, { success: true, data: { query: body.query ?? null, listings: [{ id: 1 }], next_cursor: body.cursor ? null : 'a2' } });
        }
        send(404, { success: false, error: `Unknown v2 endpoint: ${req.url}` });
    });

    return new Promise((resolve) => {
        server.unref();
        server.listen(0, '127.0.0.1', () => {
            const base = `http://127.0.0.1:${server.address().port}/api/v2`;
            resolve({
                base, log,
                reset() { log.length = 0; seen.clear(); },
                calls(path) { return log.filter((l) => l.url === `/api/v2${path}`); },
                // Node 18 keeps idle keep-alive sockets open, which stops the test runner exiting.
                close() { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
            });
        });
    });
}
