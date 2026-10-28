import { Dialog } from '@astryxdesign/core/Dialog';
import { Heading } from '@astryxdesign/core/Heading';
import { Kbd } from '@astryxdesign/core/Kbd';
import { Fragment } from 'react';

export const SHORTCUTS: readonly (readonly [keys: string, action: string])[] = [
  ['j', 'Next group'],
  ['k', 'Previous group'],
  ['o', 'Overview'],
  ['n', 'Next file'],
  ['p', 'Previous file'],
  [']', 'Next note'],
  ['[', 'Previous note'],
  ['x', 'Collapse or expand the current file'],
  ['v', 'Mark the current file viewed (and move on)'],
  ['?', 'Show these shortcuts'],
];

export function ShortcutHelp({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="info" width={380} padding={4}>
      <div className="section">
        <Heading level={3}>Keyboard shortcuts</Heading>
        <div className="shortcuts">
          {SHORTCUTS.map(([keys, action]) => (
            <Fragment key={keys}>
              <Kbd keys={keys} />
              <span>{action}</span>
            </Fragment>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
