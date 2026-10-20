"""Output formats for `scrapier run`. The Node CLI produces byte-identical
output; tests/cli.test.mjs checks both."""

import json as _json
import re


def json(value):
    return _json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def compact(value):
    return _json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _is_object(x):
    return isinstance(x, (dict, list))


def list_key_of(data, result_key):
    """The list the rows sit under: the endpoint's result key, else the first list
    of objects. None for single lookups like a profile."""
    if result_key and isinstance(data.get(result_key), list):
        return result_key
    for key, value in data.items():
        if key != "raw_responses" and isinstance(value, list) and any(_is_object(x) for x in value):
            return key
    return None


def rows_of(data, list_key):
    """A single lookup is one row."""
    return data[list_key] if list_key else [data]


def jsonl(rows):
    return "".join(compact(r) + "\n" for r in rows)


def _cell(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (dict, list)):
        return compact(value)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _quote(text):
    return '"%s"' % text.replace('"', '""') if re.search(r'[",\r\n]', text) else text


def csv(rows):
    """One column per top-level field, in first-seen order. Nested values are JSON."""
    columns = []
    seen = set()
    as_dicts = [r if isinstance(r, dict) else {"value": r} for r in rows]
    for row in as_dicts:
        for key in row:
            if key not in seen:
                seen.add(key)
                columns.append(key)
    lines = [",".join(_quote(c) for c in columns)]
    for row in as_dicts:
        lines.append(",".join(_quote(_cell(row.get(c))) for c in columns))
    return "\r\n".join(lines) + "\r\n"
