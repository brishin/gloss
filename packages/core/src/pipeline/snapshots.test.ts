import type { FileChange } from '@gloss/protocol';
import { describe, expect, it } from 'vitest';
import { isSnapshot, snapshotNames, snapshotSubjects } from './snapshots.ts';

const file = (id: string, path: string): FileChange => ({
  id,
  path,
  status: 'modified',
  additions: 1,
  deletions: 0,
  isBinary: false,
  truncated: false,
  hunks: [],
});

describe('isSnapshot', () => {
  it.each([
    ['Apps/Mobile/snapshots/sessions/Card/applied.png', true],
    ['Apps/Mobile/snapshots-dark/sessions/Card/applied.png', true],
    ['Tests/UITests/__Snapshots__/CardViewSnapshotTests/empty.image.png', true],
    ['src/__snapshots__/Button.test.tsx.snap', true],
    ['tests/core/ai/__snapshots__/test_prompt_snapshots/test_render__seed.json', true],
    ['e2e/home.spec.ts-snapshots/hero-chromium-darwin.png', true],
    ['src/Button.test.tsx.snap', true],
    ['scripts/snapshots/record.sh', false],
    ['scripts/snapshots/compare.ts', false],
    ['modules/memory-snapshot/src/index.ts', false],
    ['src/snapshot/store.ts', false],
    ['src/snapshots.ts', false],
    ['docs/screenshots/home.png', false],
    ['src/assets/logo.png', false],
  ])('%s -> %s', (path, expected) => {
    expect(isSnapshot(path)).toBe(expected);
  });
});

describe('snapshotNames', () => {
  it('lists the names a snapshot is recorded under, nearest first, without test words', () => {
    expect(snapshotNames('Apps/Mobile/snapshots/sessions/BentoAddToCollection/in-bulk.png')).toEqual([
      'bentoaddtocollection',
      'inbulk',
    ]);
    expect(snapshotNames('Tests/__Snapshots__/MobileAppQRCodeSnapshotTests/branded.image.png')).toEqual([
      'mobileappqrcode',
      'branded',
    ]);
    expect(snapshotNames('tests/__snapshots__/test_prompt_snapshots/test_suggest_topics__with_seed.json')).toEqual([
      'prompt',
      'suggesttopics',
    ]);
    expect(snapshotNames('e2e/home.spec.ts-snapshots/hero-chromium-darwin.png')).toEqual([
      'home',
      'herochromiumdarwin',
    ]);
  });
});

describe('snapshotSubjects', () => {
  it('points each snapshot at the code that draws it, never at its story or test', () => {
    const files = [
      file('dark', 'app/snapshots-dark/sessions/BentoAddToCollection/applied.png'),
      file('light', 'app/snapshots/sessions/BentoAddToCollection/applied.png'),
      file('story', 'app/src/sessions/BentoAddToCollection.stories.tsx'),
      file('code', 'app/src/sessions/BentoAddToCollection.tsx'),
      file('web', 'ui/src/sessions/BentoAddToCollection/BentoAddToCollection.web.tsx'),
      file('swiftShot', 'UI/Tests/__Snapshots__/SessionMessageRowsSnapshotTests/answer.image.png'),
      file('swiftTest', 'UI/Tests/SessionMessageRowsSnapshotTests.swift'),
      file('row', 'UI/Sources/Views/SessionMessageRow.swift'),
      file('qrShot', 'UI/Tests/__Snapshots__/QRCodeSnapshotTests/branded.image.png'),
      file('prompt', 'svc/tests/__snapshots__/test_prompt_snapshots/test_suggest_onboarding_topics__seed.json'),
      file('template', 'svc/app/templates/prompts/suggestOnboardingTopics.jinja'),
      file('orphan', 'app/snapshots/search/SearchResultsList/results.png'),
    ];
    expect(snapshotSubjects(files)).toEqual({
      dark: ['code'],
      light: ['code'],
      swiftShot: ['row'],
      prompt: ['template'],
    });
  });

  it('prefers the component folder over a state name, and the nearest platform', () => {
    const files = [
      file('shot', 'web/snapshots/home/BriefingHome/error-state.png'),
      file('home', 'web/src/home/BriefingHome.tsx'),
      file('error', 'shared/src/ErrorState.tsx'),
      file('macShot', 'mac/Tests/__Snapshots__/RibbonSnapshotTests/one.image.png'),
      file('macRibbon', 'mac/Sources/Views/Ribbon.swift'),
      file('webRibbon', 'web/src/briefings/Ribbon.tsx'),
    ];
    expect(snapshotSubjects(files)).toEqual({ shot: ['home'], macShot: ['macRibbon'] });
  });

  it('falls back to the story or test when no code file has the name', () => {
    const files = [
      file('shot', 'web/snapshots/sessions/BentoCarousel/saving.png'),
      file('story', 'web/src/sessions/BentoCarousel.stories.tsx'),
      file('shared', 'web/snapshots/captures/SharedCompactCaptureCard/filled.png'),
      file('card', 'shared/src/captures/CompactCaptureCard.tsx'),
    ];
    expect(snapshotSubjects(files)).toEqual({ shot: ['story'], shared: ['card'] });
  });

  it('needs a long shared start for a near name', () => {
    const files = [
      file('shot', 'snapshots/Card/x.png'),
      file('cards', 'src/Cards.tsx'),
      file('row', 'src/CardRow.tsx'),
    ];
    expect(snapshotSubjects(files)).toEqual({});
  });
});
