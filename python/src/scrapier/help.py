"""Help text. node/src/help.js holds the same text; the parity test compares the two."""

MAIN = """scrapier: the Scrapier web-scraping API from your terminal

Usage:
  scrapier <command> [options]

Commands:
  login              Save your API key (it is checked first)
  logout             Remove the saved API key
  me                 Show your plan and credit balance (free)
  platforms          List platforms and their endpoint counts (free)
  search <words>     Find endpoints, e.g. scrapier search instagram posts (free)
  info <endpoint>    Show an endpoint's parameters, cost and result key (free)
  run <endpoint>     Run a scrape (1 or 2 credits per successful call)

Global options:
  --api-key <key>    Use this key instead of SCRAPIER_API_KEY or the saved one
  --json             Machine-readable output for me, platforms, search and info
  --refresh          Re-download the endpoint catalog (cached for 15 minutes)
  -h, --help         Show help; scrapier <command> --help for details
  -v, --version      Show the version

Exit codes: 0 ok, 1 usage error, 2 API error, 3 bad or missing key, 4 out of credits

Get an API key: https://app.scrapier.io/dashboard/api-keys
Docs: https://docs.scrapier.io
"""

LOGIN = """Usage:
  scrapier login [--api-key <key>]

Checks the key with GET /me (free), then saves it to your user config folder.
Without --api-key it asks for the key, or reads it from stdin when piped:
  echo "$SCRAPIER_API_KEY" | scrapier login

The key is used in this order: --api-key, then SCRAPIER_API_KEY, then the saved key.
Create a key at https://app.scrapier.io/dashboard/api-keys
"""

LOGOUT = """Usage:
  scrapier logout

Deletes the saved API key. SCRAPIER_API_KEY, if set, still works.
"""

ME = """Usage:
  scrapier me [--json]

Shows your account, plan and credit balance. Free.
"""

PLATFORMS = """Usage:
  scrapier platforms [--json]

Lists every platform with its number of endpoints. Free, no key needed.
"""

SEARCH = """Usage:
  scrapier search <words> [--platform <name>] [--limit <n>] [--json]

Finds endpoints whose name contains every word. Free, no key needed.

Examples:
  scrapier search instagram posts
  scrapier search --platform tiktok
"""

INFO = """Usage:
  scrapier info <endpoint> [--json]

Shows an endpoint's parameters, cost per call, pagination and the key its
results sit under, with an example command. Free, no key needed.
"""

RUN = """Usage:
  scrapier run <endpoint> [--<param> <value> ...] [options]

Endpoint parameters are flags named after the endpoint's inputs; see
scrapier info <endpoint>. Dashes and documented aliases work too.
Boolean parameters can be given bare (--include_about) or as --name=false.

Options:
  --pages <n>          Follow next_cursor for up to n pages (default 1)
  --cursor <c>         Continue from a previous run's next_cursor
  --format <f>         json (default), jsonl (one row per line) or csv
  -o, --output <file>  Write results to a file instead of stdout
  -y, --yes            Confirm a run that can cost 10 credits or more
  -q, --quiet          No progress or summary on stderr
  --max-time <s>       Seconds to wait for each call (default 300)
  -p, --param <k=v>    Pass a parameter whose name clashes with an option above
  --api-key <key>      Use this key for this run

Billing: each successful call costs the endpoint's cost_credit (1 or 2
credits, depending on the endpoint), however many results it returns,
including a page with no results. Failed calls are free. Every page is a call.

Examples:
  scrapier run instagram-profile --usernames mrbeast
  scrapier run google-maps --queries "coffee shops" --pages 3 --format csv -o shops.csv
"""

HELP = {"main": MAIN, "login": LOGIN, "logout": LOGOUT, "me": ME, "platforms": PLATFORMS, "search": SEARCH, "info": INFO, "run": RUN}
