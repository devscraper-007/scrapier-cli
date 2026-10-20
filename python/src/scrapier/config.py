"""Where the CLI keeps the saved API key and the catalog cache.

The Node CLI uses the same paths, so `scrapier login` in one works for the other.
"""

import json
import os
import sys
from pathlib import Path


def config_dir(env=None):
    env = os.environ if env is None else env
    if env.get("SCRAPIER_CONFIG_DIR"):
        return Path(env["SCRAPIER_CONFIG_DIR"])
    if sys.platform == "win32":
        return Path(env.get("APPDATA") or Path.home() / "AppData" / "Roaming") / "scrapier"
    return Path(env.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "scrapier"


def cache_dir(env=None):
    env = os.environ if env is None else env
    if env.get("SCRAPIER_CACHE_DIR"):
        return Path(env["SCRAPIER_CACHE_DIR"])
    if sys.platform == "win32":
        return Path(env.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "scrapier" / "cache"
    return Path(env.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "scrapier"


def config_path(env=None):
    return config_dir(env) / "config.json"


def read_config(env=None):
    try:
        return json.loads(config_path(env).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def write_config(config, env=None):
    directory = config_dir(env)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = config_path(env)
    # The file holds a live API key: owner-only, also when it already existed.
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(json.dumps(config, indent=2) + "\n")
    try:
        os.chmod(str(path), 0o600)
    except OSError:
        pass  # not supported on Windows
    return path


def delete_config(env=None):
    try:
        config_path(env).unlink()
    except FileNotFoundError:
        pass


def resolve_key(flag_key, env=None):
    """--api-key beats SCRAPIER_API_KEY beats the saved key."""
    env = os.environ if env is None else env
    if isinstance(flag_key, str) and flag_key:
        return flag_key, "--api-key"
    if env.get("SCRAPIER_API_KEY"):
        return env["SCRAPIER_API_KEY"], "SCRAPIER_API_KEY"
    saved = read_config(env).get("api_key")
    if saved:
        return saved, str(config_path(env))
    return None, None
