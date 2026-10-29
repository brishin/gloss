import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bundledExtensionId,
  decodeMessage,
  encodeMessage,
  EXTENSION_DIR,
  extensionId,
  NATIVE_HOST,
  nativeHostDirs,
  nativeHostManifest,
} from './extension.ts';

describe('extension', () => {
  it('derives the id Chrome gives the unpacked extension from its key', () => {
    // The id is pinned: the native host manifest allows only this origin.
    expect(bundledExtensionId()).toBe('haanbblmmehmlmpnglfdhfcohajkhbcn');
    expect(extensionId(Buffer.from('x').toString('base64'))).toMatch(/^[a-p]{32}$/);
  });

  it('agrees with the extension on the host name', () => {
    const source = readFileSync(join(EXTENSION_DIR, 'gloss.js'), 'utf8');
    expect(source).toContain(`NATIVE_HOST = '${NATIVE_HOST}'`);
    expect(nativeHostManifest('/x/native-host', 'abc')).toMatchObject({
      name: NATIVE_HOST,
      path: '/x/native-host',
      allowed_origins: ['chrome-extension://abc/'],
    });
  });

  it('round-trips length-prefixed messages and waits for a whole one', () => {
    const frame = encodeMessage({ type: 'start', note: 'é' });
    expect(decodeMessage(frame)).toEqual({ type: 'start', note: 'é' });
    expect(decodeMessage(frame.subarray(0, 3))).toBeUndefined();
    expect(decodeMessage(frame.subarray(0, frame.length - 1))).toBeUndefined();
  });

  it('knows where each platform keeps native hosts', () => {
    expect(nativeHostDirs('darwin', '/h').map(({ dir }) => dir)).toContain(
      '/h/Library/Application Support/Google/Chrome/NativeMessagingHosts',
    );
    expect(nativeHostDirs('linux', '/h').map(({ dir }) => dir)).toContain('/h/.config/chromium/NativeMessagingHosts');
    expect(nativeHostDirs('win32', '/h')).toEqual([]);
  });
});
