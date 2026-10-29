import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { glossPath } from '@gloss/models';

/** Must match `NATIVE_HOST` in apps/extension/gloss.js. */
export const NATIVE_HOST = 'dev.gloss.launcher';

export const EXTENSION_DIR = fileURLToPath(new URL('../../../apps/extension', import.meta.url));
const NATIVE_HOST_ENTRY = fileURLToPath(new URL('./native-host.ts', import.meta.url));

/** The extension's id, derived from the public `key` in its manifest (as Chrome does). */
export function extensionId(manifestKey: string): string {
  const hex = createHash('sha256').update(Buffer.from(manifestKey, 'base64')).digest('hex').slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));
}

export function bundledExtensionId(): string {
  const manifest = JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')) as { key: string };
  return extensionId(manifest.key);
}

/** Per-user `NativeMessagingHosts` folders of Chromium browsers, by the browser's own folder. */
export function nativeHostDirs(platform: NodeJS.Platform, home = homedir()): { browser: string; dir: string }[] {
  const browsers =
    platform === 'darwin'
      ? {
          root: join(home, 'Library/Application Support'),
          dirs: [
            'Google/Chrome',
            'Google/Chrome Beta',
            'Google/Chrome Canary',
            'Chromium',
            'BraveSoftware/Brave-Browser',
            'Microsoft Edge',
            'Arc/User Data',
            'Dia/User Data',
            'Vivaldi',
          ],
        }
      : platform === 'linux'
        ? {
            root: join(home, '.config'),
            dirs: [
              'google-chrome',
              'google-chrome-beta',
              'chromium',
              'BraveSoftware/Brave-Browser',
              'microsoft-edge',
              'vivaldi',
            ],
          }
        : { root: '', dirs: [] };
  return browsers.dirs.map((browser) => ({
    browser: join(browsers.root, browser),
    dir: join(browsers.root, browser, 'NativeMessagingHosts'),
  }));
}

/** The host manifest Chrome reads to launch `path` for the extension. */
export function nativeHostManifest(path: string, id: string) {
  return {
    name: NATIVE_HOST,
    description: 'Starts the local gloss server for the gloss extension',
    path,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${id}/`],
  };
}

/** Native messaging frames a JSON message with its byte length (32-bit, native order: little-endian here). */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

/** The first complete message in `buffer`, or undefined while it is still arriving. */
export function decodeMessage(buffer: Buffer): unknown {
  if (buffer.length < 4) {
    return undefined;
  }
  const length = buffer.readUInt32LE(0);
  return buffer.length < 4 + length ? undefined : JSON.parse(buffer.subarray(4, 4 + length).toString());
}

const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * Registers the native host with every installed Chromium browser. Chrome starts hosts with a
 * bare environment, so the wrapper pins this Node and PATH (for `gh` and `git`).
 */
export function installExtension(platform = process.platform): { wrapper: string; browsers: string[] } {
  const targets = nativeHostDirs(platform).filter(({ browser }) => existsSync(browser));
  if (targets.length === 0) {
    throw new Error(
      'No Chromium browser profile found (Chrome, Arc, Dia, Brave, Edge, Chromium or Vivaldi on macOS or Linux).',
    );
  }
  const wrapper = glossPath('native-host');
  mkdirSync(dirname(wrapper), { recursive: true });
  const env = [`export PATH=${quote(process.env.PATH ?? '/usr/bin:/bin')}`];
  if (process.env.GLOSS_HOME) env.push(`export GLOSS_HOME=${quote(process.env.GLOSS_HOME)}`);
  if (process.env.GLOSS_PORT) env.push(`export GLOSS_PORT=${quote(process.env.GLOSS_PORT)}`);
  writeFileSync(
    wrapper,
    `#!/bin/sh\n# Written by \`gloss extension install\`.\n${env.join('\n')}\nexec ${quote(process.execPath)} ${quote(NATIVE_HOST_ENTRY)}\n`,
    { mode: 0o755 },
  );
  const manifest = JSON.stringify(nativeHostManifest(wrapper, bundledExtensionId()), null, 2);
  for (const { dir } of targets) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${NATIVE_HOST}.json`), manifest);
  }
  return { wrapper, browsers: targets.map(({ browser }) => browser) };
}

export function uninstallExtension(platform = process.platform): void {
  for (const { dir } of nativeHostDirs(platform)) {
    rmSync(join(dir, `${NATIVE_HOST}.json`), { force: true });
  }
  rmSync(glossPath('native-host'), { force: true });
}
