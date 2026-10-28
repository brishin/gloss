import type { SourceRef } from '@gloss/protocol';
import { parseGithubTarget } from '@gloss/protocol';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactNode } from 'react';

/** The only mapping between refs and routes (mirrored by the CLI's `webPath`). */
export function RefLink({ sourceRef, children }: { sourceRef: SourceRef; children: ReactNode }) {
  return sourceRef.kind === 'github-pr' ? (
    <Link
      to="/gh/$owner/$repo/pull/$number"
      params={{ owner: sourceRef.owner, repo: sourceRef.repo, number: String(sourceRef.number) }}
    >
      {children}
    </Link>
  ) : (
    <Link to="/local" search={{ repo: sourceRef.repo, target: sourceRef.target }}>
      {children}
    </Link>
  );
}

export function useNavigateToRef() {
  const navigate = useNavigate();
  return (ref: SourceRef) =>
    ref.kind === 'github-pr'
      ? navigate({
          to: '/gh/$owner/$repo/pull/$number',
          params: { owner: ref.owner, repo: ref.repo, number: String(ref.number) },
        })
      : navigate({ to: '/local', search: { repo: ref.repo, target: ref.target } });
}

/** What the home page's box accepts: a PR URL, `owner/repo#123`, or an absolute repo path with an optional `@target`. */
export function parseInput(input: string): SourceRef | undefined {
  const github = parseGithubTarget(input);
  if (github) {
    return github;
  }
  const text = input.trim();
  if (text.startsWith('/')) {
    const at = text.lastIndexOf('@');
    return at > 0
      ? { kind: 'local', repo: text.slice(0, at), target: text.slice(at + 1) }
      : { kind: 'local', repo: text, target: '' };
  }
  return undefined;
}
