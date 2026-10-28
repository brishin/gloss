import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

/** Where gloss keeps its cache, credentials and config. Override with `GLOSS_HOME`. */
export function glossHome(): string {
  return process.env.GLOSS_HOME || join(homedir(), '.gloss');
}

export const glossPath = (...parts: string[]) => join(glossHome(), ...parts);
