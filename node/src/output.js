// Output formats for `scrapier run`. The Python CLI produces byte-identical
// output; tests/cli.test.mjs checks both.

export const json = (value) => JSON.stringify(value, null, 2) + '\n';

// The list the rows sit under: the endpoint's result key, else the first list
// of objects. null for single lookups like a profile.
export function listKeyOf(data, resultKey) {
    if (resultKey && Array.isArray(data?.[resultKey])) return resultKey;
    return Object.keys(data ?? {}).find((k) => k !== 'raw_responses'
        && Array.isArray(data[k]) && data[k].some((x) => x && typeof x === 'object')) ?? null;
}

// A single lookup is one row.
export function rowsOf(data, listKey) {
    return listKey ? data[listKey] : [data];
}

export const jsonl = (rows) => rows.map((r) => JSON.stringify(r) + '\n').join('');

function cell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

function quote(text) {
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const isRecord = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// One column per top-level field, in first-seen order. Nested values are JSON.
export function csv(rows) {
    const columns = [];
    const seen = new Set();
    for (const row of rows) {
        for (const k of Object.keys(isRecord(row) ? row : { value: row })) {
            if (!seen.has(k)) { seen.add(k); columns.push(k); }
        }
    }
    const lines = [columns.map(quote).join(',')];
    for (const row of rows) {
        const r = isRecord(row) ? row : { value: row };
        lines.push(columns.map((c) => quote(cell(r[c]))).join(','));
    }
    return lines.join('\r\n') + '\r\n';
}
