import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { CheckIcon, ChevronIcon } from './icons.tsx';

/**
 * One row of a foldable tree, styled like a sidebar nav item. Rows are focusable treeitems
 * rather than buttons so the chevron can be one; the tree container moves focus between
 * rows (`data-node`/`data-parent`) with the arrow keys. Fold state is the caller's, so it
 * can unfold the path to a selection or open everything a filter keeps.
 */
export function TreeRow({
  id,
  parent,
  current,
  expanded,
  label,
  phase,
  sticky,
  tabbable,
  onToggle,
  onClick,
  children,
}: {
  id: string;
  parent: string;
  current: boolean;
  /** Undefined for a leaf: no chevron, no `aria-expanded`. */
  expanded?: boolean;
  label: string;
  phase?: string;
  /** Stays pinned while its children scroll under it. */
  sticky?: boolean;
  /** In the tab order even when not current (the tree's entry point). */
  tabbable?: boolean;
  /** `deep` is true for a shift-click: fold or unfold everything below too. */
  onToggle?: (deep: boolean) => void;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div
      role="treeitem"
      className={`nav-item tree-row${sticky ? ' tree-row-sticky' : ''}`}
      data-node={id}
      data-parent={parent}
      data-phase={phase}
      aria-expanded={expanded}
      aria-current={current ? 'step' : undefined}
      aria-selected={current}
      tabIndex={current || tabbable ? 0 : -1}
      title={label}
      onClick={onClick}
    >
      {onToggle ? (
        <button
          type="button"
          className="tree-chevron"
          tabIndex={-1}
          aria-label={`${expanded ? 'Fold' : 'Unfold'} ${label}`}
          onClick={(event: MouseEvent) => {
            event.stopPropagation();
            onToggle(event.shiftKey);
          }}
        >
          <ChevronIcon />
        </button>
      ) : (
        <span className="tree-chevron" />
      )}
      {children}
    </div>
  );
}

/** Files viewed so far: a ring while in progress, a check when done. Astryx has only a linear progress bar. */
export function Progress({ seen, total }: { seen: number; total: number }) {
  if (total > 0 && seen === total) {
    return (
      <span className="nav-count" aria-label="All files viewed">
        <CheckIcon />
      </span>
    );
  }
  return (
    <span
      className="tree-ring"
      style={{ '--progress': total ? seen / total : 0 } as CSSProperties}
      role="img"
      aria-label={`${seen} of ${total} files viewed`}
    />
  );
}
