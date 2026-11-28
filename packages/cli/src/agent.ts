import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const TEMPLATE = fileURLToPath(new URL('./agent-skill.md', import.meta.url));
const BIN = fileURLToPath(new URL('./bin.ts', import.meta.url));

/** Where Claude Code looks for this user's skills. */
export function claudeSkillDir(env = process.env, home = homedir()): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), 'skills', 'gloss');
}

/** The skill with this checkout's command in it, since `gloss` may not be on the agent's PATH. */
export function agentSkill(bin = BIN): string {
  const command = `node ${/^[\w./-]+$/.test(bin) ? bin : `'${bin.replaceAll("'", "'\\''")}'`}`;
  return readFileSync(TEMPLATE, 'utf8').replaceAll('{{gloss}}', command);
}

/** Writes the skill; run it again after moving the checkout. */
export function installAgentSkill(dir = claudeSkillDir()): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), agentSkill());
  return dir;
}

export function uninstallAgentSkill(dir = claudeSkillDir()): void {
  rmSync(dir, { recursive: true, force: true });
}
