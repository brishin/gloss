import * as v from 'valibot';

/** A `gh auth login --web` the backend runs: the one-time code to enter at `url`. */
export const GithubLoginSchema = v.object({ code: v.string(), url: v.string() });
export type GithubLogin = v.InferOutput<typeof GithubLoginSchema>;

/**
 * What the setup page shows besides `Health`: GitHub (through the `gh` CLI), the browser
 * extension's native host, and whether a Jev key is saved. Read from the backend's machine.
 */
export const SetupStatusSchema = v.object({
  github: v.object({
    /** `missing`: no `gh` on the backend's PATH. */
    state: v.picklist(['missing', 'signed-out', 'signed-in']),
    login: v.optional(v.string()),
    /** A web sign-in that is still waiting for the code. */
    pending: v.optional(GithubLoginSchema),
  }),
  extension: v.object({
    /** The unpacked extension's folder, for Load unpacked. */
    dir: v.string(),
    /** The extension's id (from its manifest key), which the page pings. */
    id: v.string(),
    /** The native host is registered, so the extension can start the server. */
    hostInstalled: v.boolean(),
  }),
});
export type SetupStatus = v.InferOutput<typeof SetupStatusSchema>;

export const JudgeKeyRequestSchema = v.object({ key: v.pipe(v.string(), v.trim(), v.minLength(1)) });
