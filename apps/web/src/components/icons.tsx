import type { Category } from '@gloss/protocol';
import type { ReactNode } from 'react';

/** 16px stroke icons for the sidebar tree; they take `currentColor`. */
function Glyph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg className={`glyph ${className ?? ''}`} viewBox="0 0 16 16" aria-hidden="true">
      {children}
    </svg>
  );
}

const CATEGORY_PATHS: Record<Category, ReactNode> = {
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
};

export function CategoryIcon({ category }: { category: Category }) {
  return <Glyph className="glyph-category">{CATEGORY_PATHS[category]}</Glyph>;
}

export function ChevronIcon() {
  return (
    <Glyph className="glyph-chevron">
      <path d="M6 4l4 4-4 4" />
    </Glyph>
  );
}

export function PullRequestIcon() {
  return (
    <Glyph>
      <circle cx="4" cy="4" r="1.6" />
      <circle cx="4" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <path d="M4 5.6v4.8M12 10.4V7a2 2 0 0 0-2-2H7.5M9 3.5 7.5 5 9 6.5" />
    </Glyph>
  );
}

export function FolderIcon() {
  return (
    <Glyph>
      <path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" />
    </Glyph>
  );
}

export function CheckIcon() {
  return (
    <Glyph className="glyph-done">
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </Glyph>
  );
}
