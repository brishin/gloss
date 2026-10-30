import { Dialog } from '@astryxdesign/core/Dialog';
import { Heading } from '@astryxdesign/core/Heading';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Fragment } from 'react';

export const SHORTCUTS: readonly (readonly [keys: string, action: string])[] = [
  ['j', 'Next group'],
  ['k', 'Previous group'],
  ['shift+j', 'Next PR in the stack'],
  ['shift+k', 'Previous PR in the stack'],
  ['o', 'Overview'],
  ['n', 'Next file'],
  ['p', 'Previous file'],
  [']', 'Next note'],
  ['[', 'Previous note'],
  ['x', 'Collapse or expand the current file'],
  ['v', 'Mark the current file viewed (and move on)'],
  ['r', 'Review, on Approve'],
  ['r y', 'Approve now, without a comment'],
  ['r n', 'Request changes'],
  ['r c', 'Comment'],
  ['mod+enter', 'Send the comment or review'],
  ['d', 'Pipeline debug view'],
  ['?', 'Show these shortcuts'],
];

export function ShortcutHelp({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="info" width={380} padding={4}>
      <div className="section">
        <Heading level={2}>Keyboard shortcuts</Heading>
        <div className="shortcuts">
          {SHORTCUTS.map(([keys, action]) => (
            <Fragment key={keys}>
              {/* A space is a sequence: press one key, then the next. */}
              <span className="kbd-seq">
                {keys.split(' ').map((key) => (
                  <Kbd key={key} keys={key} />
                ))}
              </span>
              <span>{action}</span>
            </Fragment>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
