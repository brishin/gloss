import { Skeleton } from '@astryxdesign/core/Skeleton';
import { useAtomValue } from '@effect/atom-react';
import type { LfsObject, LfsPointer } from '@gloss/protocol';
import { AsyncResult } from 'effect/reactivity';
import { useState } from 'react';
import { lfsObjectAtom } from '../lib/client.ts';
import { formatBytes } from '../lib/tour-view.ts';
import { ZoomableImage } from './DescriptionMedia.tsx';

/** Both sides of a changed Git LFS image, side by side: the old one marked removed, the new one added. */
export function LfsImageDiff({ diffId, pointer, path }: { diffId: string; pointer: LfsPointer; path: string }) {
  return (
    <div className="image-diff">
      {pointer.old && <Side diffId={diffId} object={pointer.old} side="old" path={path} />}
      {pointer.new && <Side diffId={diffId} object={pointer.new} side="new" path={path} />}
    </div>
  );
}

function Side({
  diffId,
  object,
  side,
  path,
}: {
  diffId: string;
  object: LfsObject;
  side: 'old' | 'new';
  path: string;
}) {
  const result = useAtomValue(lfsObjectAtom(JSON.stringify({ diffId, oid: object.oid })));
  const [size, setSize] = useState<string>();
  return (
    <figure className="image-diff-side" data-side={side}>
      <div className="image-diff-frame">
        {AsyncResult.isSuccess(result) ? (
          <ZoomableImage
            src={result.value}
            alt={`${path} (${side === 'old' ? 'before' : 'after'})`}
            className="image-diff-image"
            onLoad={(image) => setSize(`${image.naturalWidth} × ${image.naturalHeight}`)}
          />
        ) : AsyncResult.isFailure(result) ? (
          <span className="image-diff-error">Could not fetch the LFS object</span>
        ) : (
          <Skeleton height={160} />
        )}
      </div>
      <figcaption>{[size, formatBytes(object.size)].filter(Boolean).join(' · ')}</figcaption>
    </figure>
  );
}
