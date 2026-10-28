import { describe, expect, it } from 'vitest';
import { isGithubAssetUrl } from './asset.ts';

describe('isGithubAssetUrl', () => {
  it.each([
    ['https://github.com/user-attachments/assets/eaf91621-cd04-455d-af6c-31d305e81247', true],
    ['https://github.com/scuba-app/flashback/assets/110783/eaf91621-cd04-455d-af6c-31d305e81247', true],
    ['http://github.com/user-attachments/assets/eaf91621', false],
    ['https://github.com.evil.test/user-attachments/assets/eaf91621', false],
    ['https://evil.test/user-attachments/assets/eaf91621', false],
    ['https://github.com/user-attachments/assets/eaf91621/../../settings', false],
    ['https://github.com/scuba-app/flashback/pull/15375', false],
    ['not a url', false],
  ])('%s → %s', (url, expected) => {
    expect(isGithubAssetUrl(url)).toBe(expected);
  });
});
