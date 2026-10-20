"""`scrapier` command line. Data goes to stdout, progress and errors to stderr,
and the exit code says what went wrong (see EXIT), so scripts and AI agents can
drive it. node/src/cli.js mirrors this file; keep them in step."""

import getpass
import os
import re
import sys
import traceback

from . import __version__
from .api import EXIT, KEYS_URL, CliError, request
from .catalog import find_endpoint, load_catalog, platforms, resolve_param, search
from .config import config_path, delete_config, resolve_key, write_config
from .help import HELP
from .output import csv, json, jsonl, list_key_of, rows_of

# Options that never take a value, so `--yes instagram-profile` stays two tokens.
BOOLEAN_OPTIONS = {"help", "version", "yes", "quiet", "json", "refresh"}
SHORT = {"h": "help", "v": "version", "y": "yes", "q": "quiet", "o": "output", "p": "param"}
# Options of `run`. Anything else on a run is an endpoint parameter.
RUN_OPTIONS = {"pages", "format", "output", "api-key", "yes", "quiet", "max-time", "param", "help"}
CONFIRM_AT = 10
COOKIE_PARAM = re.compile(r"session|cookie", re.I)


def parse_args(argv):
    positionals, flags = [], []
    i = 0
    while i < len(argv):
        token = argv[i]
        if token == "--":
            positionals.extend(argv[i + 1:])
            break
        name = None
        if token.startswith("--") and len(token) > 2:
            name = token[2:]
        elif re.match(r"^-[a-zA-Z]$", token):
            name = SHORT.get(token[1], token[1])
        if name is None:
            positionals.append(token)
        elif "=" in name and name.index("=") > 0:
            key, _, value = name.partition("=")
            flags.append((key, value))
        elif name not in BOOLEAN_OPTIONS and i + 1 < len(argv) and not argv[i + 1].startswith("-"):
            flags.append((name, argv[i + 1]))
            i += 1
        else:
            flags.append((name, True))
        i += 1
    return positionals, flags


def flag_value(flags, name, default=None):
    values = [v for k, v in flags if k == name]
    return values[-1] if values else default


class Io:
    def __init__(self, stdout=None, stderr=None, stdin=None, env=None):
        self.stdout = stdout or sys.stdout
        self.stderr = stderr or sys.stderr
        self.stdin = stdin or sys.stdin
        self.env = os.environ if env is None else env

    def out(self, text):
        self.stdout.write(text)

    def err(self, text):
        self.stderr.write(text if text.endswith("\n") else text + "\n")
        self.stderr.flush()


def _text(value):
    return str(value)


def table(rows, headers):
    widths = [max([len(h)] + [len(_text(r[i])) for r in rows]) for i, h in enumerate(headers)]

    def line(cells):
        return "  ".join(_text(c) if i == len(cells) - 1 else _text(c).ljust(widths[i]) for i, c in enumerate(cells))

    return "\n".join([line(headers)] + [line(r) for r in rows]) + "\n"


def need_key(flags, io):
    key, source = resolve_key(flag_value(flags, "api-key"), io.env)
    if not key:
        raise CliError(
            "No API key. Run `scrapier login` or set SCRAPIER_API_KEY. Create a key at %s" % KEYS_URL, EXIT.AUTH)
    return key, source


def on_retry(io):
    def report(reason, wait, attempt):
        io.err("%s; retrying in %.1fs (attempt %d)" % (reason, wait, attempt + 1))
    return report


def credits(n):
    return "%s credit%s" % (n, "" if n == 1 else "s")


# ── commands ────────────────────────────────────────────────────────────────

def cmd_me(positionals, flags, io):
    key, source = need_key(flags, io)
    me = request("/me", api_key=key, env=io.env, on_retry=on_retry(io))
    if flag_value(flags, "json"):
        return io.out(json(me))
    balance = (me.get("credits") or {}).get("balance") if isinstance(me.get("credits"), dict) else None
    rows = [("Email", me.get("email")), ("Name", me.get("name")), ("Plan", me.get("plan")),
            ("Credits", balance), ("Key from", source)]
    rows = [(k, v) for k, v in rows if v is not None and v != ""]
    io.out("\n".join(("%s:" % k).ljust(10) + _text(v) for k, v in rows) + "\n")


def cmd_login(positionals, flags, io):
    key = flag_value(flags, "api-key")
    if not isinstance(key, str) or not key:
        if io.stdin.isatty():
            key = getpass.getpass("Paste your API key (create one at %s): " % KEYS_URL, stream=io.stderr)
        else:
            key = io.stdin.read()
    key = str(key).strip()
    if not key:
        raise CliError("No key given.", EXIT.USAGE)
    me = request("/me", api_key=key, env=io.env, on_retry=on_retry(io))
    path = write_config({"api_key": key}, io.env)
    balance = (me.get("credits") or {}).get("balance") if isinstance(me.get("credits"), dict) else None
    who = ", ".join(x for x in [me.get("plan"), "%s credits" % balance if balance is not None else None] if x)
    io.err("Logged in%s%s. Key saved to %s" % (
        " as %s" % me["email"] if me.get("email") else "", " (%s)" % who if who else "", path))
    if io.env.get("SCRAPIER_API_KEY"):
        io.err("Note: SCRAPIER_API_KEY is set and takes precedence over the saved key.")


def cmd_logout(positionals, flags, io):
    delete_config(io.env)
    io.err("Removed the saved key (%s)." % config_path(io.env))
    if io.env.get("SCRAPIER_API_KEY"):
        io.err("SCRAPIER_API_KEY is still set in your environment.")


def catalog_for(flags, io):
    return load_catalog(env=io.env, refresh=bool(flag_value(flags, "refresh")), warn=io.err)


def cmd_platforms(positionals, flags, io):
    items = platforms(catalog_for(flags, io))
    if flag_value(flags, "json"):
        return io.out(json(items))
    io.out(table([(p["platform"], p["endpoints"]) for p in items], ["PLATFORM", "ENDPOINTS"]))


def cmd_search(positionals, flags, io):
    query = " ".join(positionals)
    platform = flag_value(flags, "platform")
    if not query and not isinstance(platform, str):
        raise CliError("Usage: scrapier search <words> [--platform <name>]", EXIT.USAGE)
    catalog = catalog_for(flags, io)
    found = search(catalog, query, platform=platform if isinstance(platform, str) else None)
    try:
        limit = int(flag_value(flags, "limit", 25))
    except (TypeError, ValueError):
        limit = 0
    if limit > 0:
        found = found[:limit]
    if flag_value(flags, "json"):
        return io.out(json([{
            "endpoint": e["slug"], "name": e["name"], "platform": e["platform"], "cost_credit": e["cost"],
            "pagination": e["pagination"], "disabled": e["disabled"],
        } for e in found]))
    if not found:
        return io.err('No endpoints match "%s". Try fewer words, or: scrapier platforms' % query)
    io.out(table([(e["slug"], e["cost"], "%s (disabled)" % e["name"] if e["disabled"] else e["name"]) for e in found],
                 ["ENDPOINT", "COST", "NAME"]))
    io.err("Parameters and cost: scrapier info <endpoint>")


def shell_quote(value):
    value = str(value)
    if re.match(r"^[\w@%+=:,./-]+$", value, re.A):
        return value
    return '"%s"' % re.sub(r'(["\\$`])', r"\\\1", value)


def example_for(e):
    names = [k for k, spec in e["input"].items() if spec.get("required")]
    if not names:
        first = next((k for k, spec in e["input"].items()
                      if k not in ("cursor", "use_proxy", "raw_data") and spec.get("default_value")), None)
        names = [first] if first else []
    return "scrapier run %s%s" % (e["slug"], "".join(
        " --%s %s" % (k, shell_quote(e["input"][k].get("default_value") or "<value>")) for k in names))


def cmd_info(positionals, flags, io):
    if not positionals:
        raise CliError("Usage: scrapier info <endpoint>", EXIT.USAGE)
    e = find_endpoint(catalog_for(flags, io), positionals[0])
    if flag_value(flags, "json"):
        return io.out(json({
            "endpoint": e["slug"], "name": e["name"], "platform": e["platform"], "cost_credit": e["cost"],
            "pagination": e["pagination"], "long_running": e["long_running"], "disabled": e["disabled"],
            "disabled_reason": e["disabled_reason"] or None, "result_key": e["result_key"], "input": e["input"],
        }))
    lines = [
        "%s: %s" % (e["slug"], e["name"]),
        "Platform:    %s" % e["platform"],
        "Cost:        %s per successful call" % credits(e["cost"]),
        "Pagination:  %s" % ("single (one call, no pages)" if e["pagination"] == "single"
                             else "cursor (--pages N follows next_cursor)"),
    ]
    if e["result_key"]:
        lines.append("Results in:  %s" % e["result_key"])
    if e["disabled"]:
        lines.append("Status:      disabled: %s" % e["disabled_reason"])
    if e["long_running"]:
        lines.append("Note:        long-running; a call can take several minutes")
    lines += ["", "Parameters:"]
    for name, spec in e["input"].items():
        lines.append("  --%s  %s%s" % (name, spec.get("type") or "string", ", required" if spec.get("required") else ""))
        extra = []
        if spec.get("default_value"):
            extra.append("default: %s" % spec["default_value"])
        if spec.get("options"):
            extra.append("one of: %s" % ", ".join(spec["options"]))
        if spec.get("description"):
            lines.append("      %s%s" % (spec["description"], " (%s)" % "; ".join(extra) if extra else ""))
        elif extra:
            lines.append("      %s" % "; ".join(extra))
        if spec.get("aliases"):
            lines.append("      Aliases: %s" % ", ".join("--%s" % a for a in spec["aliases"]))
    lines += ["", "Example:", "  %s" % example_for(e)]
    io.out("\n".join(lines) + "\n")


def normalize_value(endpoint, param, value):
    kind = endpoint["input"][param].get("type") or "string"
    if kind == "boolean":
        if value is True:
            return "true"
        v = str(value).lower()
        if v in ("true", "1", "yes", "on"):
            return "true"
        if v in ("false", "0", "no", "off"):
            return "false"
        raise CliError('--%s is true or false, not "%s". Use --%s or --%s=false' % (param, value, param, param),
                       EXIT.USAGE)
    if value is True:
        raise CliError("--%s needs a value." % param, EXIT.USAGE)
    if kind == "integer" and not re.match(r"^-?\d+$", str(value)):
        raise CliError('--%s must be a whole number, not "%s".' % (param, value), EXIT.USAGE)
    return str(value)


def collect_params(endpoint, flags):
    params = {}

    def add(name, value):
        param = resolve_param(endpoint, name)
        if not param:
            raise CliError("Unknown parameter --%s for %s. Valid: %s" % (
                name, endpoint["slug"], ", ".join("--%s" % k for k in endpoint["input"])), EXIT.USAGE)
        params[param] = normalize_value(endpoint, param, value)

    for name, value in flags:
        if name == "param":
            text = str(value)
            eq = text.find("=")
            if value is True or eq < 1:
                raise CliError("--param takes key=value, e.g. -p timeout=30", EXIT.USAGE)
            add(text[:eq], text[eq + 1:])
        elif name not in RUN_OPTIONS:
            add(name, value)
    return params


def confirm(question, io):
    io.stderr.write(question)
    io.stderr.flush()
    return re.match(r"^y(es)?$", io.stdin.readline().strip(), re.I) is not None


def _number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return float("nan")


def cmd_run(positionals, flags, io):
    if not positionals:
        raise CliError("Usage: scrapier run <endpoint> [--<param> <value> ...]. See: scrapier run --help", EXIT.USAGE)
    endpoint = find_endpoint(catalog_for(flags, io), positionals[0])
    quiet = bool(flag_value(flags, "quiet"))

    def note(message):
        if not quiet:
            io.err(message)

    params = collect_params(endpoint, flags)
    if endpoint["disabled"]:
        raise CliError("%s is disabled: %s Nothing was charged." % (endpoint["slug"], endpoint["disabled_reason"]),
                       EXIT.API)
    if "cursor" not in params:
        missing = [k for k, spec in endpoint["input"].items() if spec.get("required") and k not in params]
        if missing:
            raise CliError("Missing required %s for %s. Example: %s" % (
                ", ".join("--%s" % k for k in missing), endpoint["slug"], example_for(endpoint)), EXIT.USAGE)

    fmt = flag_value(flags, "format", "json")
    if fmt not in ("json", "jsonl", "csv"):
        raise CliError("--format is json, jsonl or csv.", EXIT.USAGE)
    pages_number = _number(flag_value(flags, "pages", "1"))
    if not pages_number.is_integer() or pages_number < 1:
        raise CliError("--pages must be a whole number of 1 or more.", EXIT.USAGE)
    pages = int(pages_number)
    if pages > 1 and endpoint["pagination"] == "single":
        note("%s returns a single result; ignoring --pages." % endpoint["slug"])
        pages = 1
    max_time = _number(flag_value(flags, "max-time", 300))
    if not max_time > 0:
        raise CliError("--max-time must be a number of seconds.", EXIT.USAGE)

    estimate = endpoint["cost"] * pages
    if estimate >= CONFIRM_AT and not flag_value(flags, "yes"):
        what = "This run can cost up to %s (%s per call x %d page%s)." % (
            credits(estimate), credits(endpoint["cost"]), pages, "" if pages == 1 else "s")
        if not (io.stdin.isatty() and io.stderr.isatty()):
            raise CliError("%s Re-run with --yes to confirm." % what, EXIT.USAGE)
        if not confirm("%s Continue? [y/N] " % what, io):
            raise CliError("Cancelled. Nothing was charged.", EXIT.USAGE)

    key, _ = need_key(flags, io)
    if endpoint["long_running"]:
        note("%s is long-running; a call can take several minutes." % endpoint["slug"])

    # Pages after the first send only the cursor, plus any session cookie (not stored in the cursor).
    cookies = {k: v for k, v in params.items() if COOKIE_PARAM.search(k)}
    merged, list_key, calls, cursor, failure = None, None, 0, None, None
    for page in range(1, pages + 1):
        try:
            body = request("/%s/" % endpoint["slug"], method="POST",
                           body=params if page == 1 else dict(cookies, cursor=cursor),
                           api_key=key, env=io.env, timeout=max_time, on_retry=on_retry(io))
        except CliError as err:
            if calls == 0:
                raise
            failure = err
            break
        calls += 1
        data = body.get("data") if isinstance(body.get("data"), dict) else {}
        if merged is None:
            merged = dict(data)
            list_key = list_key_of(data, endpoint["result_key"])
        elif list_key:
            more = data.get(list_key)
            merged[list_key] = merged[list_key] + (more if isinstance(more, list) else [])
        cursor = data.get("next_cursor")
        if pages > 1:
            note("page %d: %s" % (page, "%d %s" % (len(data.get(list_key) or []), list_key) if list_key else "done"))
        if not cursor or not list_key:
            break
    if "next_cursor" in merged or cursor:
        merged["next_cursor"] = cursor

    rows = rows_of(merged, list_key)
    text = json(merged) if fmt == "json" else jsonl(rows) if fmt == "jsonl" else csv(rows)
    out_path = flag_value(flags, "output")
    if isinstance(out_path, str):
        with open(out_path, "w", encoding="utf-8", newline="") as f:
            f.write(text)
    else:
        io.out(text)

    counted = ", %d %s" % (len(rows), list_key) if list_key else ""
    note("Done: %d call%s%s, %s.%s" % (calls, "" if calls == 1 else "s", counted, credits(calls * endpoint["cost"]),
                                       " Saved to %s" % out_path if isinstance(out_path, str) else ""))
    if cursor:
        note("More results: scrapier run %s --cursor %s" % (endpoint["slug"], cursor))
    if failure:
        failure.message = "Stopped after %d page%s (results above were kept): %s" % (
            calls, "" if calls == 1 else "s", failure.message)
        raise failure


COMMANDS = {"me": cmd_me, "login": cmd_login, "logout": cmd_logout, "platforms": cmd_platforms,
            "search": cmd_search, "info": cmd_info, "run": cmd_run}


def main(argv=None, io=None):
    io = io or Io()
    argv = sys.argv[1:] if argv is None else argv
    command, rest = (argv[0], argv[1:]) if argv else (None, [])
    positionals, flags = parse_args(rest)
    try:
        if command in (None, "help", "--help", "-h"):
            io.out(HELP.get(rest[0], HELP["main"]) if rest else HELP["main"])
            return EXIT.OK
        if command in ("--version", "-v", "version"):
            io.out(__version__ + "\n")
            return EXIT.OK
        handler = COMMANDS.get(command)
        if not handler:
            raise CliError('Unknown command "%s". See: scrapier --help' % command, EXIT.USAGE)
        if flag_value(flags, "help"):
            io.out(HELP[command])
            return EXIT.OK
        handler(positionals, flags, io)
        return EXIT.OK
    except CliError as err:
        io.err("error: %s" % err.message)
        return err.exit_code
    except KeyboardInterrupt:
        io.err("error: Cancelled.")
        return EXIT.USAGE
    except Exception:  # noqa: BLE001 - last-resort report, never a silent crash
        io.err("error: %s" % traceback.format_exc())
        return EXIT.API


def run_main():
    # UTF-8 everywhere, and no "\n" -> "\r\n" on Windows, so output matches the Node CLI byte for byte.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", newline="\n")
        except (AttributeError, ValueError):
            pass
    sys.exit(main())
