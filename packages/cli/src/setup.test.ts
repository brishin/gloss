import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NATIVE_HOST, nativeHostDirs } from './extension.ts';
import { nativeHostInstalled, parseDeviceCode, upsertEnv } from './setup.ts';

describe('setup', () => {
  it('reads the one-time code from gh auth login --web', () => {
    const output =
      '! First copy your one-time code: 1A2B-C3D4\nPress Enter to open https://github.com/login/device in your browser... ';
    expect(parseDeviceCode(output)).toBe('1A2B-C3D4');
    expect(parseDeviceCode('! First copy your one-time')).toBeUndefined();
  });

  it.each([
    ['', 'TYPESAFE_API_KEY="k"\n'],
    ['A=1', 'A=1\nTYPESAFE_API_KEY="k"\n'],
    ['A=1\n\n', 'A=1\nTYPESAFE_API_KEY="k"\n'],
    ['A=1\nTYPESAFE_API_KEY=old\nB=2\n', 'A=1\nTYPESAFE_API_KEY="k"\nB=2\n'],
    ['export TYPESAFE_API_KEY=old\n', 'TYPESAFE_API_KEY="k"\n'],
    ['TYPESAFE_API_KEY_2=x\n', 'TYPESAFE_API_KEY_2=x\nTYPESAFE_API_KEY="k"\n'],
  ])('sets the key in %j', (before, after) => {
    expect(upsertEnv(before, 'TYPESAFE_API_KEY', 'k')).toBe(after);
  });

  it('finds a registered native host in any browser profile', () => {
    const home = mkdtempSync(join(tmpdir(), 'gloss-home-'));
    expect(nativeHostInstalled('darwin', home)).toBe(false);
    const { dir } = nativeHostDirs('darwin', home).find(({ browser }) => browser.includes('Dia'))!;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${NATIVE_HOST}.json`), '{}');
    expect(nativeHostInstalled('darwin', home)).toBe(true);
  });
});
