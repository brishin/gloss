import { Button } from '@astryxdesign/core/Button';
import { Heading } from '@astryxdesign/core/Heading';
import { Text } from '@astryxdesign/core/Text';
import { useAtomValue } from '@effect/atom-react';
import { describeRef } from '@gloss/protocol';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useState } from 'react';
import { Logo } from '../components/Logo.tsx';
import { healthAtom, recentToursAtom } from '../lib/client.ts';
import { missingLogins } from '../lib/login.ts';
import { parseInput, RefLink, useNavigateToRef } from '../lib/source-routes.tsx';

export const Route = createFileRoute('/')({ component: Home });

function Home() {
  const recent = AsyncResult.getOrElse(useAtomValue(recentToursAtom), () => ({ tours: [] })).tours;
  const navigateToRef = useNavigateToRef();
  const health = AsyncResult.getOrElse(useAtomValue(healthAtom), () => undefined);
  const navigate = useNavigate();
  // First run: nothing can tour until a model is signed in, so setup comes first.
  const needsSetup = !!health && missingLogins(health).length > 0;
  useEffect(() => {
    if (needsSetup) void navigate({ to: '/setup', replace: true });
  }, [needsSetup, navigate]);
  const [input, setInput] = useState('');
  const [error, setError] = useState<string>();

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
      <div className="home-head">
        <div>
          <h1 className="home-logo">
            <Logo />
          </h1>
          <Text color="secondary">A guided, annotated review tour of a pull request or local diff.</Text>
        </div>
        <div className="home-links">
          <Link to="/settings" className="home-setup">
            Settings
          </Link>
          <Link to="/setup" className="home-setup">
            Setup
          </Link>
        </div>
      </div>
      <form className="target-form" onSubmit={submit}>
        <input
          autoFocus
          aria-label="Pull request or repository"
          placeholder="https://github.com/owner/repo/pull/123 · owner/repo#123 · /path/to/repo@main...HEAD"
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setError(undefined);
          }}
        />
        <Button type="submit" variant="primary" label="Tour" />
      </form>
      {error && (
        <div role="alert">
          <Text color="secondary">{error}</Text>
        </div>
      )}
      {recent.length > 0 && (
        <section className="recent">
          <Heading level={2}>Recent</Heading>
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
