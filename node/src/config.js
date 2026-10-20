// Where the CLI keeps the saved API key and the catalog cache. The Python CLI
// uses the same paths, so `scrapier login` in one works for the other.

import { mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function configDir(env = process.env) {
    if (env.SCRAPIER_CONFIG_DIR) return env.SCRAPIER_CONFIG_DIR;
    if (process.platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'scrapier');
    return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'scrapier');
}

export function cacheDir(env = process.env) {
    if (env.SCRAPIER_CACHE_DIR) return env.SCRAPIER_CACHE_DIR;
    if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'scrapier', 'cache');
    return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'scrapier');
}

export const configPath = (env) => join(configDir(env), 'config.json');

export function readConfig(env) {
    try {
        return JSON.parse(readFileSync(configPath(env), 'utf8'));
    } catch {
        return {};
    }
}

export function writeConfig(config, env) {
    const dir = configDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = configPath(env);
    // The file holds a live API key: owner-only, also when it already existed.
    writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* not supported on Windows */ }
    return path;
}

export function deleteConfig(env) {
    rmSync(configPath(env), { force: true });
}

// --api-key beats SCRAPIER_API_KEY beats the saved key.
export function resolveKey(flagKey, env = process.env) {
    if (typeof flagKey === 'string' && flagKey) return { key: flagKey, source: '--api-key' };
    if (env.SCRAPIER_API_KEY) return { key: env.SCRAPIER_API_KEY, source: 'SCRAPIER_API_KEY' };
    const saved = readConfig(env).api_key;
    if (saved) return { key: saved, source: configPath(env) };
    return { key: null, source: null };
}
