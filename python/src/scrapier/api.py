"""HTTP client for the Scrapier REST API: auth header, timeouts, and the retry
rules from https://docs.scrapier.io/errors/ (failed calls are never billed)."""

import json
import os
import random
import socket
import time
import urllib.error
import urllib.request

from . import __version__

DEFAULT_BASE = "https://proxy.scrapier.io/api/v2"
KEYS_URL = "https://app.scrapier.io/dashboard/api-keys"
BILLING_URL = "https://app.scrapier.io/dashboard/billing"


class EXIT:
    """Process exit codes. Documented in the README; scripts and agents branch on them."""

    OK = 0
    USAGE = 1
    API = 2
    AUTH = 3
    CREDITS = 4


class CliError(Exception):
    def __init__(self, message, exit_code=EXIT.USAGE, status=None):
        super().__init__(message)
        self.message = message
        self.exit_code = exit_code
        self.status = status


def base_url(env=None):
    env = os.environ if env is None else env
    return (env.get("SCRAPIER_API_BASE") or DEFAULT_BASE).rstrip("/")


def _classify(status, body):
    message = body.get("error")
    if message is None:
        message = body.get("detail")
    if message is None:
        message = "HTTP %d" % status
    if status == 402 and "balance" in body:
        return False, CliError(
            "Out of credits (balance %s, this call needs %s). Top up at %s"
            % (_js(body.get("balance")), _js(body.get("required")), BILLING_URL),
            EXIT.CREDITS, status)
    if status in (401, 403):
        return False, CliError(
            "%s Check your API key (create one at %s)." % (message, KEYS_URL), EXIT.AUTH, status)
    # 429, any 5xx, and a 402 passed through from the target site are free to retry.
    retry = status == 429 or status >= 500 or status == 402
    return retry, CliError("HTTP %d: %s" % (status, message), EXIT.API, status)


def _js(value):
    """Format a JSON value the way JavaScript's String() does, for identical messages."""
    if value is None:
        return "undefined"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _backoff(attempt):
    """Exponential backoff with jitter: about 1 s, 2 s, 4 s... capped at 30 s."""
    return min(30.0, 2 ** attempt) * (0.5 + random.random())


def request(path, method="GET", body=None, api_key=None, env=None, timeout=300.0, retries=3,
            on_retry=lambda reason, wait, attempt: None):
    """Call the API and return the parsed JSON body of a 2xx response."""
    url = base_url(env) + path
    headers = {"User-Agent": "scrapier-cli/%s (python)" % __version__, "Accept": "application/json"}
    if api_key:
        headers["X-API-Key"] = api_key
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")

    attempt = 0
    while True:
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return _parse(res.read())
        except urllib.error.HTTPError as err:
            parsed = _parse(err.read())
            retry, error = _classify(err.code, parsed)
            if not retry or attempt >= retries:
                raise error
            try:
                retry_after = float(err.headers.get("Retry-After") or 0)
            except ValueError:
                retry_after = 0
            wait = retry_after if retry_after > 0 else _backoff(attempt)
            on_retry("HTTP %d" % err.code, wait, attempt + 1)
        except (socket.timeout, TimeoutError) as err:
            raise _timeout_error(timeout) from err
        except urllib.error.URLError as err:
            if isinstance(err.reason, (socket.timeout, TimeoutError)):
                raise _timeout_error(timeout) from err
            if attempt >= retries:
                raise CliError("Could not reach %s: %s" % (url, err.reason), EXIT.API) from err
            wait = _backoff(attempt)
            on_retry("network error", wait, attempt + 1)
        time.sleep(wait)
        attempt += 1


def _timeout_error(timeout):
    # Not retried: the scrape may have finished server-side and been billed.
    return CliError(
        "No response after %ds. The scrape may still have completed and been billed, so it was "
        "not retried. Raise the limit with --max-time." % round(timeout), EXIT.API)


def _parse(raw):
    text = raw.decode("utf-8", errors="replace") if raw else ""
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except ValueError:
        return {"error": text[:200]}
    return parsed if isinstance(parsed, dict) else {"data": parsed}
