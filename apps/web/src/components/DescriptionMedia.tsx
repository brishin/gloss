import { Skeleton } from '@astryxdesign/core/Skeleton';
import { useAtomRefresh, useAtomValue } from '@effect/atom-react';
import { isGithubAssetUrl } from '@gloss/protocol';
import { AsyncResult } from 'effect/reactivity';
import { type MouseEvent, useRef, useState } from 'react';
import { assetAtom } from '../lib/client.ts';

/**
 * An image in a PR description. GitHub attachments need the viewer's login on private
 * repos, so the backend resolves them to a short-lived URL first; one that serves a video
 * (GitHub embeds uploaded videos as a bare URL) plays inline.
 */
export function DescriptionMedia({ src, alt }: { src: string; alt: string }) {
  if (!isGithubAssetUrl(src)) {
    return <ZoomableImage src={src} alt={alt} />;
  }
  return <GithubAsset src={src} alt={alt} />;
}

function GithubAsset({ src, alt }: { src: string; alt: string }) {
  const result = useAtomValue(assetAtom(src));
  const refresh = useAtomRefresh(assetAtom(src));
  // The signed URL lasts minutes; a video that errors later (seeking, replay) gets a fresh one, once.
  const [retried, setRetried] = useState(false);

  if (AsyncResult.isFailure(result)) {
    return (
      <a href={src} target="_blank" rel="noreferrer">
        {alt || 'Attachment'} (open on GitHub)
      </a>
    );
  }
  if (!AsyncResult.isSuccess(result)) {
    return <Skeleton width={320} height={180} />;
  }
  const asset = result.value;
  if (asset.contentType?.startsWith('video/')) {
    return (
      <video
        className="description-media"
        src={asset.url}
        aria-label={alt || undefined}
        controls
        muted
        playsInline
        preload="metadata"
        onError={() => {
          if (!retried) {
            setRetried(true);
            refresh();
          }
        }}
      />
    );
  }
  return <ZoomableImage src={asset.url} alt={alt} />;
}

/**
 * Click to see the image at full size; a click anywhere or Esc closes it. Clicks stop here,
 * so a link around the image (`[![shot](img)](url)`) does not also navigate.
 */
function ZoomableImage({ src, alt }: { src: string; alt: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const handle = (open: boolean) => (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (open) {
      dialog.current?.showModal();
    } else {
      dialog.current?.close();
    }
  };
  return (
    <>
      <button type="button" className="description-zoom" onClick={handle(true)}>
        <img className="description-media" src={src} alt={alt} />
      </button>
      {/* Keys stay inside, so tour shortcuts don't move the page behind it. */}
      <dialog
        ref={dialog}
        className="lightbox"
        aria-label={alt || 'Image'}
        onClick={handle(false)}
        onKeyDown={(event) => event.stopPropagation()}
      >
        <img src={src} alt={alt} />
      </dialog>
    </>
  );
}
