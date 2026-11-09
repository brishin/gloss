import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/** Where gloss keeps its cache, credentials and config. Override with `GLOSS_HOME`. */
export function glossHome(): string {
  return process.env.GLOSS_HOME || join(homedir(), '.gloss');
}

export const glossPath = (...parts: string[]) => join(glossHome(), ...parts);

/**
 * Where gloss keeps data it can fetch again (repository clones): the OS cache dir, which backups
 * skip and cleanup tools may empty. Override with `GLOSS_CACHE_DIR`.
 */
export function glossCacheDir(platform = process.platform, env = process.env, home = homedir()): string {
  if (env.GLOSS_CACHE_DIR) {
    return env.GLOSS_CACHE_DIR;
  }
  if (platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'gloss');
  }
  if (platform === 'win32') {
    return join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'gloss', 'Cache');
  }
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'gloss');
}
