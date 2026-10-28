import * as v from 'valibot';

/**
 * Files attached to a PR body (`github.com/user-attachments/assets/<id>`, or the older
 * `github.com/<owner>/<repo>/assets/<user>/<id>`). On private repos they need the viewer's
 * GitHub login, so the page asks the backend to resolve them instead of loading them directly.
 */
const GITHUB_ASSET_PATH = /^\/(?:user-attachments\/assets\/[\w-]+|[\w.-]+\/[\w.-]+\/assets\/\d+\/[\w-]+)$/;

export function isGithubAssetUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com' && GITHUB_ASSET_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** A short-lived URL the browser can load without credentials, and what it serves. */
export const ResolvedAssetSchema = v.object({
  url: v.string(),
  contentType: v.optional(v.string()),
});
export type ResolvedAsset = v.InferOutput<typeof ResolvedAssetSchema>;
