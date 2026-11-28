import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { agentSkill, claudeSkillDir, installAgentSkill, uninstallAgentSkill } from './agent.ts';

describe('agent skill', () => {
  test('names this checkout, quoting a path the shell would split', () => {
    expect(agentSkill('/src/gloss/packages/cli/src/bin.ts')).toContain(
      '`node /src/gloss/packages/cli/src/bin.ts tour <target>`',
    );
    expect(agentSkill("/My Code/it's/bin.ts")).toContain(`node '/My Code/it'\\''s/bin.ts' tour`);
    expect(agentSkill()).not.toContain('{{gloss}}');
  });

  test('installs under the Claude config dir and uninstalls cleanly', () => {
    const dir = claudeSkillDir({ CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'gloss-claude-')) });
    installAgentSkill(dir);
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toMatch(/^---\nname: gloss\n/);
    uninstallAgentSkill(dir);
    expect(existsSync(dir)).toBe(false);
  });
});
