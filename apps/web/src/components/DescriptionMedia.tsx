import { Skeleton } from '@astryxdesign/core/Skeleton';
import { isGithubAssetUrl, type ResolvedAsset } from '@gloss/protocol';
import { useEffect, useState } from 'react';
import { useGlossClient } from '../lib/client.tsx';

/**
 * An image in a PR description. GitHub attachments need the viewer's login on private
 * repos, so the backend resolves them to a short-lived URL first; one that serves a video
 * (GitHub embeds uploaded videos as a bare URL) plays inline.
 */
export function DescriptionMedia({ src, alt }: { src: string; alt: string }) {
  if (!isGithubAssetUrl(src)) {
    return <img className="description-media" src={src} alt={alt} />;
  }
  return <GithubAsset src={src} alt={alt} />;
}

function GithubAsset({ src, alt }: { src: string; alt: string }) {
  const client = useGlossClient();
  const [asset, setAsset] = useState<ResolvedAsset | 'failed'>();
  // The signed URL lasts minutes; a video that errors later (seeking, replay) gets a fresh one, once.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    client
      .asset(src)
      .then((resolved) => live && setAsset(resolved))
      .catch(() => live && setAsset('failed'));
    return () => {
      live = false;
    };
  }, [client, src, attempt]);

  if (asset === 'failed') {
    return (
      <a href={src} target="_blank" rel="noreferrer">
        {alt || 'Attachment'} (open on GitHub)
      </a>
    );
  }
  if (!asset) {
    return <Skeleton width={320} height={180} />;
  }
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
        onError={() => attempt === 0 && setAttempt(1)}
      />
    );
  }
  return <img className="description-media" src={asset.url} alt={alt} />;
}
