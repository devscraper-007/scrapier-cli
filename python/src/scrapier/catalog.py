"""The live endpoint catalog (GET /endpoints, free, no key), cached on disk for
15 minutes. Every endpoint and parameter the CLI knows comes from here, so a
new Scrapier endpoint works without a CLI release."""

import json
import re
import time

from .api import CliError, EXIT, base_url, request
from .config import cache_dir

TTL_SECONDS = 15 * 60


def _cache_path(env):
    return cache_dir(env) / "endpoints.json"


def load_catalog(env=None, refresh=False, warn=lambda message: None):
    cached = None
    try:
        cached = json.loads(_cache_path(env).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    # A cache from another base URL (staging, tests) is not this catalog.
    if cached and cached.get("base") != base_url(env):
        cached = None
    if cached and not refresh and time.time() * 1000 - cached["fetched_at"] < TTL_SECONDS * 1000:
        return _normalize(cached["body"])

    try:
        body = request("/endpoints", env=env, retries=2, timeout=60.0)
    except CliError as err:
        if not cached:
            raise
        warn("Could not refresh the endpoint catalog (%s); using the cached copy." % err.message)
        return _normalize(cached["body"])
    try:
        cache_dir(env).mkdir(parents=True, exist_ok=True)
        _cache_path(env).write_text(
            json.dumps({"base": base_url(env), "fetched_at": int(time.time() * 1000), "body": body}),
            encoding="utf-8")
    except OSError:
        pass  # a read-only home must not break the CLI
    return _normalize(body)


def _sample_result_key(sample):
    """The key the rows sit under (posts, places, products...), read from the sample."""
    formatted = sample.get("formatted") if isinstance(sample, dict) and "formatted" in sample else sample
    if not isinstance(formatted, dict):
        return None
    for key, value in formatted.items():
        if isinstance(value, list) and key != "raw_responses":
            return key
    return None


def _normalize(body):
    endpoints = []
    for group in body.get("endpoints") or []:
        for api in group.get("apis") or []:
            cost = api.get("cost_credit")
            endpoints.append({
                "slug": str(api.get("endpoint")).strip("/"),
                "platform": group.get("platform"),
                "name": api.get("name") or "",
                "cost": 1 if cost is None else cost,
                "pagination": api.get("pagination") or "cursor",
                "disabled": bool(api.get("disabled")),
                "disabled_reason": api.get("disabled_reason") or "",
                "long_running": bool(api.get("long_running")),
                "input": api.get("input") or {},
                "result_key": _sample_result_key(api.get("sample_output")),
            })
    return {"endpoints": endpoints}


def platform_key(platform):
    return re.sub(r"[\s_-]+", "", str(platform).lower())


def find_endpoint(catalog, slug):
    want = str(slug).strip("/").lower()
    for endpoint in catalog["endpoints"]:
        if endpoint["slug"] == want:
            return endpoint
    near = _suggest(catalog, want)
    raise CliError(
        'Unknown endpoint "%s".%s Find endpoints with: scrapier search <words>'
        % (slug, " Did you mean: %s?" % ", ".join(near) if near else ""), EXIT.USAGE)


def _suggest(catalog, want):
    """Closest slugs to a typo: shared words first, then the longest shared prefix."""
    words = [w for w in re.split(r"[^a-z0-9]+", want) if len(w) >= 3]

    def prefix(slug):
        i = 0
        while i < len(slug) and i < len(want) and slug[i] == want[i]:
            i += 1
        return i

    scored = []
    for e in catalog["endpoints"]:
        hits = sum(1 for w in words if w in e["slug"])
        pre = prefix(e["slug"])
        if hits > 0 or pre >= 4:
            scored.append((-hits, -pre, e["slug"]))
    return [r[2] for r in sorted(scored)[:5]]


def _has(hay, word):
    """A word matches as typed or without a plural "s" ("posts" finds post-scraper)."""
    return word in hay or (len(word) > 3 and word.endswith("s") and word[:-1] in hay)


def search(catalog, query="", platform=None):
    """Every query word must appear in the slug, name or platform."""
    words = [w for w in re.split(r"[^a-z0-9]+", str(query).lower()) if w]
    want_platform = platform_key(platform) if platform else None
    scored = []
    for e in catalog["endpoints"]:
        if want_platform and platform_key(e["platform"]) != want_platform:
            continue
        hay = ("%s %s %s" % (e["slug"], e["name"], e["platform"])).lower()
        if all(_has(hay, w) for w in words):
            slug_hits = sum(1 for w in words if _has(e["slug"], w))
            scored.append((-slug_hits, e["disabled"], e["slug"], e))
    scored.sort(key=lambda r: r[:3])
    return [r[3] for r in scored]


def platforms(catalog):
    counts = {}
    for e in catalog["endpoints"]:
        counts[e["platform"]] = counts.get(e["platform"], 0) + 1
    return [{"platform": p, "endpoints": n} for p, n in counts.items()]


def resolve_param(endpoint, name):
    """Maps a name the user typed (--page-size, a documented alias) to the real param."""
    if name in endpoint["input"]:
        return name
    underscored = name.replace("-", "_")
    if underscored in endpoint["input"]:
        return underscored
    for param, spec in endpoint["input"].items():
        aliases = spec.get("aliases") or []
        if name in aliases or underscored in aliases:
            return param
    return None
