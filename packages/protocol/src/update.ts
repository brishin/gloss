import * as v from 'valibot';

/** Whether the backend's own checkout has newer code than the server runs (`/api/update`). */
export const UpdateStatusSchema = v.object({
  /** The commit the server started on. */
  running: v.optional(v.string()),
  /** The checkout's commit now; it differs from `running` after a pull without a restart. */
  head: v.optional(v.string()),
  /** Commits on the checkout's upstream branch that it does not have yet. */
  behind: v.number(),
});
export type UpdateStatus = v.InferOutput<typeof UpdateStatusSchema>;

/** An update pulls `behind` commits, or restarts the server on a checkout that moved on without it. */
export const updateAvailable = (status: UpdateStatus): boolean =>
  status.behind > 0 || (status.running !== undefined && status.head !== undefined && status.head !== status.running);
