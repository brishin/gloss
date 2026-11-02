import { describe, expect, it } from 'vitest';
import { updateAvailable } from './update.ts';

describe('updateAvailable', () => {
  it.each([
    [{ running: 'a', head: 'a', behind: 0 }, false],
    [{ running: 'a', head: 'a', behind: 2 }, true],
    // Pulled in a terminal, not restarted yet.
    [{ running: 'a', head: 'b', behind: 0 }, true],
    // Not a git checkout.
    [{ behind: 0 }, false],
  ])('%o → %s', (status, expected) => {
    expect(updateAvailable(status)).toBe(expected);
  });
});
