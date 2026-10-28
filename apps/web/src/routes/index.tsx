import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import type { RecentTour } from '@gloss/protocol';
import { describeRef } from '@gloss/protocol';
import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useGlossClient } from '../lib/client.tsx';
import { parseInput, RefLink, useNavigateToRef } from '../lib/source-routes.tsx';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  const client = useGlossClient();
  const navigateToRef = useNavigateToRef();
  const [input, setInput] = useState('');
  const [error, setError] = useState<string>();
  const [recent, setRecent] = useState<RecentTour[]>([]);

  useEffect(() => {
    client
      .recent()
      .then(setRecent)
      .catch(() => {});
  }, [client]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const ref = parseInput(input);
    if (!ref) {
      setError('Enter a PR URL, owner/repo#123, or an absolute repository path (optionally path@target).');
      return;
    }
    void navigateToRef(ref);
  };

  return (
    <main className="home">
      <div>
        <Heading level={1}>gloss</Heading>
        <Text color="secondary">A guided, annotated review tour of a pull request or local diff.</Text>
      </div>
      <form className="target-form" onSubmit={submit}>
        <input
          autoFocus
          placeholder="https://github.com/owner/repo/pull/123 · owner/repo#123 · /path/to/repo@main...HEAD"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setError(undefined);
          }}
        />
        <Button type="submit" variant="primary" label="Tour" />
      </form>
      {error && <Text color="secondary">{error}</Text>}
      {recent.length > 0 && (
        <section className="recent">
          <Heading level={3}>Recent</Heading>
          {recent.map((item) => (
            <RefLink key={`${item.ref.kind}:${describeRef(item.ref)}`} sourceRef={item.ref}>
              <span>{item.title}</span>
              <Text color="secondary" size="sm">
                {describeRef(item.ref)}
              </Text>
            </RefLink>
          ))}
        </section>
      )}
    </main>
  );
}
