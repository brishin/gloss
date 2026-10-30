import { Icon, type IconType } from '@astryxdesign/core/Icon';
import type { Category, PullState } from '@gloss/protocol';
import type { ReactNode } from 'react';
import { FLAG_LABEL, FLAG_LEVELS, type FlagLevel } from '../lib/tour-view.ts';

/**
 * Glyphs Astryx's icon set lacks (categories, PR, folder), drawn as 16px stroke icons and
 * rendered through Astryx `Icon` so size and color follow the design system.
 */
function strokeIcon(paths: ReactNode): IconType {
  return function StrokeIcon(props) {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeLinejoin="round"
        {...props}
      >
        {paths}
      </svg>
    );
  };
}

const CATEGORY_GLYPHS = {
  ui: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 6h12M6 6v7" />
    </>
  ),
  api: <path d="M6 2v3M10 2v3M4.5 5h7v3a3.5 3.5 0 0 1-7 0zM8 11.5V14" />,
  core: (
    <>
      <path d="M8 2l5.5 3v6L8 14l-5.5-3V5z" />
      <path d="M2.5 5 8 8l5.5-3M8 8v6" />
    </>
  ),
  data: (
    <>
      <ellipse cx="8" cy="4" rx="5" ry="2" />
      <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />
    </>
  ),
  cli: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M5 7l2 1.5L5 10M8.5 10.5H11" />
    </>
  ),
  security: <path d="M8 2l5 2v4c0 3-2.2 5.2-5 6-2.8-.8-5-3-5-6V4z" />,
  tests: <path d="M6 2h4M6.5 2v4L3 13h10L9.5 6V2M4.5 10h7" />,
  docs: <path d="M3 3h4a1.5 1.5 0 0 1 1.5 1.5V13a1 1 0 0 0-1-1H3zM13 3H9.5A1.5 1.5 0 0 0 8 4.5V13a1 1 0 0 1 1-1h4z" />,
  examples: <path d="M6 13h4M6.5 11h3M8 2a4 4 0 0 0-2.5 7.1V11h5V9.1A4 4 0 0 0 8 2z" />,
  deps: (
    <>
      <path d="M8 2v4M8 10v4M2 8h4M10 8h4" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  build: <path d="M3 13l6-6M8.5 2.5l5 5-2 2-5-5z" />,
  scripts: <path d="M5 3h8v8a2 2 0 0 1-2 2H4a1.5 1.5 0 0 1-1.5-1.5V11H9v1.5M5 3v8M7 6h4M7 8.5h4" />,
  config: (
    <>
      <path d="M3 5h10M3 11h10" />
      <circle cx="6" cy="5" r="1.5" />
      <circle cx="10" cy="11" r="1.5" />
    </>
  ),
  i18n: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
    </>
  ),
  assets: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2.5 12l4-4 3 3 1.5-1.5 2.5 2.5" />
    </>
  ),
  other: <circle cx="8" cy="8" r="2.5" />,
} satisfies Record<Category, ReactNode>;

const CATEGORY_ICONS = Object.fromEntries(
  Object.entries(CATEGORY_GLYPHS).map(([category, paths]) => [category, strokeIcon(paths)]),
) as Record<Category, IconType>;

const PULL_REQUEST = strokeIcon(
  <>
    <circle cx="4" cy="4" r="1.6" />
    <circle cx="4" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <path d="M4 5.6v4.8M12 10.4V7a2 2 0 0 0-2-2H7.5M9 3.5 7.5 5 9 6.5" />
  </>,
);

const MERGED = strokeIcon(
  <>
    <circle cx="4" cy="4" r="1.6" />
    <circle cx="4" cy="12" r="1.6" />
    <circle cx="12" cy="8" r="1.6" />
    <path d="M4 5.6v4.8M4.5 5.5C5.5 7.5 7.5 8 10.4 8" />
  </>,
);

const DRAFT = strokeIcon(
  <>
    <circle cx="4" cy="4" r="1.6" />
    <circle cx="4" cy="12" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <path d="M4 5.6v4.8M12 4v.01M12 7.5v.01" />
  </>,
);

const STACK = strokeIcon(
  <>
    <path d="M8 2l6 3-6 3-6-3z" />
    <path d="M2 8l6 3 6-3M2 11l6 3 6-3" />
  </>,
);

const FOLDER = strokeIcon(<path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" />);

export function CategoryIcon({ category }: { category: Category }) {
  return <Icon icon={CATEGORY_ICONS[category]} size="sm" color="inherit" />;
}

export function RefIcon({ kind, state }: { kind: 'github-pr' | 'local'; state?: PullState }) {
  const icon = kind === 'local' ? FOLDER : state === 'merged' ? MERGED : state === 'draft' ? DRAFT : PULL_REQUEST;
  return <Icon icon={icon} size="sm" color="inherit" />;
}

export function StackIcon() {
  return <Icon icon={STACK} size="sm" color="inherit" />;
}

export function ChevronIcon() {
  return <Icon icon="chevronRight" size="sm" color="inherit" className="tree-chevron-icon" />;
}

const FLAG_GLYPHS: Record<FlagLevel, ReactNode> = {
  severe: (
    <>
      <path
        d="M6.6 3.2 5.6 1.8M9.4 3.2l1-1.4M4.6 7.6 1.8 6.6M4.4 10.2H1.6M4.8 12.6 2.2 14.2M11.4 7.6l2.8-1M11.6 10.2h2.8M11.2 12.6l2.6 1.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <circle cx="8" cy="4.6" r="2.1" fill="currentColor" />
      <ellipse cx="8" cy="10" rx="3.7" ry="4.4" fill="currentColor" />
      <path d="M8 6.2v7.8" stroke="var(--color-background-surface)" strokeWidth="1" />
    </>
  ),
  warning: (
    <>
      <path d="M8 1.8 15 14.2H1z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <rect x="7.2" y="5.6" width="1.6" height="4.6" rx="0.8" fill="#2a1d00" />
      <circle cx="8" cy="12.1" r="0.95" fill="#2a1d00" />
    </>
  ),
  investigate: <FlagGlyph />,
  info: <FlagGlyph />,
};

function FlagGlyph() {
  return (
    <>
      <rect x="2.4" y="1.4" width="1.6" height="13.2" rx="0.8" fill="currentColor" />
      <path d="M4 2.4c2.6-1.2 5 1.4 9.4 0v7c-4.4 1.4-6.8-1.2-9.4 0z" fill="currentColor" />
    </>
  );
}

/**
 * A flag's level as a mark: a red bug for severe, an amber triangle for a warning, an orange
 * flag to investigate and a grey one for information.
 */
export function FlagIcon({ level }: { level: FlagLevel }) {
  const label = FLAG_LABEL[level];
  return (
    <svg className="flag-icon" data-level={level} viewBox="0 0 16 16" role="img" aria-label={label}>
      <title>{label}</title>
      {FLAG_GLYPHS[level]}
    </svg>
  );
}

/** A section's flags by level, most urgent first; levels with none are left out. */
export function FlagCounts({ counts }: { counts: Record<FlagLevel, number> }) {
  const shown = FLAG_LEVELS.filter((level) => counts[level] > 0);
  if (shown.length === 0) {
    return null;
  }
  return (
    <span className="flag-counts">
      {shown.map((level) => (
        <span key={level} className="flag-count" title={`${counts[level]} ${FLAG_LABEL[level].toLowerCase()}`}>
          <FlagIcon level={level} />
          {counts[level]}
        </span>
      ))}
    </span>
  );
}

export function CheckIcon() {
  return <Icon icon="check" size="sm" color="success" />;
}
