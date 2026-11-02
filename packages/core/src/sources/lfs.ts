import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { DiffPayload, LfsObject } from '@gloss/protocol';
import { sha256 } from '../hash.ts';
import { git, run, runBytes } from './exec.ts';

interface BatchResponse {
  objects?: {
    oid: string;
    actions?: { download?: { href: string; header?: Record<string, string> } };
    error?: { message: string };
  }[];
  message?: string;
}

/** The object through the LFS batch API of the PR's repository, with the `gh` login's token. */
async function fromGithub(owner: string, repo: string, object: LfsObject, signal?: AbortSignal): Promise<Uint8Array> {
  const token = (await run('gh', ['auth', 'token'], { signal })).trim();
  const auth = `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const response = await fetch(`https://github.com/${owner}/${repo}.git/info/lfs/objects/batch`, {
    method: 'POST',
    signal,
    headers: {
      Accept: 'application/vnd.git-lfs+json',
      'Content-Type': 'application/vnd.git-lfs+json',
      Authorization: auth,
    },
    body: JSON.stringify({ operation: 'download', transfers: ['basic'], objects: [object] }),
  });
  const batch = (await response.json()) as BatchResponse;
  const entry = batch.objects?.find((candidate) => candidate.oid === object.oid);
  const download = entry?.actions?.download;
  if (!response.ok || !download) {
    throw new Error(entry?.error?.message ?? batch.message ?? `LFS batch request failed (${response.status})`);
  }
  const body = await fetch(download.href, { signal, headers: download.header });
  if (!body.ok) {
    throw new Error(`LFS download failed (${body.status})`);
  }
  return new Uint8Array(await body.arrayBuffer());
}

/** The object from the repository's LFS store, or through `git lfs smudge`, which fetches it from the remote. */
async function fromLocal(repo: string, object: LfsObject, signal?: AbortSignal): Promise<Uint8Array> {
  const common = (await git(repo, ['rev-parse', '--git-common-dir'], { signal })).trim();
  const store = join(isAbsolute(common) ? common : join(repo, common), 'lfs', 'objects');
  try {
    return new Uint8Array(await readFile(join(store, object.oid.slice(0, 2), object.oid.slice(2, 4), object.oid)));
  } catch {
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${object.oid}\nsize ${object.size}\n`;
    return runBytes('git', ['lfs', 'smudge'], { cwd: repo, input: pointer, signal });
  }
}

/** A Git LFS object's bytes, checked against its oid. */
export async function readLfsObject(diff: DiffPayload, object: LfsObject, signal?: AbortSignal): Promise<Uint8Array> {
  const { ref } = diff;
  const bytes =
    ref.kind === 'github-pr'
      ? await fromGithub(ref.owner, ref.repo, object, signal)
      : await fromLocal(ref.repo, object, signal);
  if (sha256(bytes) !== object.oid) {
    throw new Error(`The LFS object ${object.oid.slice(0, 12)} does not match its oid`);
  }
  return bytes;
}
