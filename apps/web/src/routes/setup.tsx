import { Button } from '@astryxdesign/core/Button';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react';
import type { Health, SetupStatus } from '@gloss/protocol';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { AsyncResult, Atom } from 'effect/reactivity';
import { type ReactNode, useEffect, useState } from 'react';
import { Progress } from '../components/LoginPrompt.tsx';
import { Logo } from '../components/Logo.tsx';
import {
  extensionAtom,
  githubLoginAtom,
  healthAtom,
  installNativeHostAtom,
  loginAtom,
  saveJudgeKeyAtom,
  setupAtom,
} from '../lib/client.ts';
import { missingLogins } from '../lib/login.ts';

export const Route = createFileRoute('/setup')({ component: Setup });

/**
 * First-run setup, and what `gloss status` shows: a model sign-in (required), GitHub through
 * `gh`, the browser extension, and Jev. Each section turns done from what the backend (or the
 * extension) reports, so there is nothing to verify by hand.
 */
function Setup() {
  const health = AsyncResult.getOrElse(useAtomValue(healthAtom), () => undefined);
  const setup = AsyncResult.getOrElse(useAtomValue(setupAtom), () => undefined);
  const refreshSetup = useAtomRefresh(setupAtom);
  const navigate = useNavigate();

  // Installing gh or signing in elsewhere shows up when the page is looked at again.
  useEffect(() => {
    window.addEventListener('focus', refreshSetup);
    return () => window.removeEventListener('focus', refreshSetup);
  }, [refreshSetup]);

  const modelReady = !!health && missingLogins(health).length === 0;
  return (
    <main className="setup">
      <div>
        <h1 className="home-logo">
          <Link to="/" aria-label="gloss home">
            <Logo />
          </Link>
        </h1>
        <Text color="secondary">
          Set up once. Everything stays on this machine, in <code>~/.gloss</code>.
        </Text>
      </div>
      {health ? <ModelSection health={health} /> : <Spinner label="Connecting to gloss…" />}
      {setup && (
        <>
          <GithubSection github={setup.github} onChange={refreshSetup} />
          <ExtensionSection extension={setup.extension} onChange={refreshSetup} />
        </>
      )}
      {health && <JudgeSection health={health} />}
      <div className="setup-foot">
        <Button
          variant="primary"
          label="Start a tour"
          isDisabled={!modelReady}
          onClick={() => void navigate({ to: '/' })}
        />
      </div>
    </main>
  );
}

function Section({
  state,
  title,
  aside,
  children,
}: {
  state: 'done' | 'todo' | 'waiting' | 'optional';
  title: ReactNode;
  aside?: string;
  children?: ReactNode;
}) {
  return (
    <section className="setup-section" data-state={state}>
      <span className="setup-mark" aria-hidden />
      <div className="setup-body">
        <div className="setup-line">
          <h2>{title}</h2>
          {aside && state !== 'done' && (
            <Text color="secondary" size="sm">
              {aside}
            </Text>
          )}
        </div>
        {state !== 'done' && children}
      </div>
    </section>
  );
}

function ModelSection({ health }: { health: Health }) {
  const refreshHealth = useAtomRefresh(healthAtom);
  const login = useAtomValue(loginAtom);
  const setLogin = useAtomSet(loginAtom);
  const missing = missingLogins(health);
  const session = AsyncResult.getOrElse(login, () => undefined);
  const succeeded = session?.state === 'succeeded';

  useEffect(() => {
    if (succeeded) refreshHealth();
  }, [succeeded, refreshHealth]);
  // Leave the finished sign-in once health has caught up with it.
  useEffect(() => {
    if (succeeded && missing.length === 0) setLogin(Atom.Reset);
  }, [succeeded, missing.length, setLogin]);

  if (missing.length === 0) {
    return <Section state="done" title="Signed in" />;
  }
  const reset = () => setLogin(Atom.Reset);
  return (
    <Section state="todo" title="Sign in to a model" aside="Required">
      {session ? (
        <div className="login-prompt">
          <Progress session={session} onCancel={reset} onDone={reset} />
        </div>
      ) : AsyncResult.isInitial(login) ? (
        <>
          <Text color="secondary">gloss uses it to group a change and write the notes.</Text>
          {missing.map((provider) => (
            <div className="setup-actions" key={provider.subscription}>
              <Button
                variant="primary"
                label={`Sign in with ${provider.label}`}
                onClick={() => setLogin({ subscription: provider.subscription, method: 'oauth' })}
              />
              <Button
                variant="ghost"
                label={`Use an ${provider.apiKeyLabel}`}
                onClick={() => setLogin({ subscription: provider.subscription, method: 'api_key' })}
              />
            </div>
          ))}
        </>
      ) : AsyncResult.isFailure(login) ? (
        <div className="setup-actions">
          <Text color="secondary">Could not start the sign-in.</Text>
          <Button variant="secondary" label="Try again" onClick={reset} />
        </div>
      ) : (
        <Spinner label="Starting sign-in…" />
      )}
    </Section>
  );
}

function GithubSection({ github, onChange }: { github: SetupStatus['github']; onChange: () => void }) {
  const result = useAtomValue(githubLoginAtom);
  const start = useAtomSet(githubLoginAtom);
  // The backend's status is the only source of the code: it drops it when gh exits (expired, failed).
  const pending = github.state === 'signed-out' ? github.pending : undefined;
  const startedLogin = AsyncResult.isSuccess(result);

  useEffect(() => {
    if (startedLogin) onChange();
  }, [startedLogin, onChange]);

  // Poll while GitHub waits for the code.
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(onChange, 2000);
    return () => clearInterval(timer);
  }, [pending, onChange]);

  if (github.state === 'signed-in') {
    return <Section state="done" title={`GitHub connected as ${github.login}`} />;
  }
  if (github.state === 'missing') {
    return (
      <Section state="todo" title="Install the GitHub CLI" aside="For pull requests">
        <Text color="secondary">gloss reads pull requests through gh. Local diffs work without it.</Text>
        <div className="setup-actions">
          <Button variant="secondary" label="Get gh" href="https://cli.github.com" target="_blank" rel="noreferrer" />
        </div>
      </Section>
    );
  }
  return (
    <Section state={pending ? 'waiting' : 'todo'} title="Connect GitHub" aside="For pull requests">
      {pending ? (
        <>
          <Text color="secondary">Enter this code on GitHub:</Text>
          <div className="setup-actions">
            <code className="setup-code">{pending.code}</code>
            <Button variant="primary" label="Open GitHub" href={pending.url} target="_blank" rel="noreferrer" />
          </div>
          <Spinner size="sm" label="Waiting for GitHub…" />
        </>
      ) : (
        <>
          <Text color="secondary">gloss reads pull requests through the GitHub CLI, which is not signed in.</Text>
          <div className="setup-actions">
            <Button
              variant="primary"
              label="Sign in to GitHub"
              isLoading={AsyncResult.isWaiting(result)}
              onClick={() => start()}
            />
          </div>
          {AsyncResult.isFailure(result) && !AsyncResult.isWaiting(result) && (
            <Text color="secondary">
              Could not start it here. Run <code>gh auth login</code> in a terminal.
            </Text>
          )}
        </>
      )}
    </Section>
  );
}

function ExtensionSection({ extension, onChange }: { extension: SetupStatus['extension']; onChange: () => void }) {
  const found = AsyncResult.getOrElse(useAtomValue(extensionAtom(extension.id)), () => false);
  const install = useAtomSet(installNativeHostAtom);
  const installing = useAtomValue(installNativeHostAtom);

  useEffect(() => {
    if (AsyncResult.isSuccess(installing)) onChange();
  }, [installing, onChange]);

  if (found && extension.hostInstalled) {
    return <Section state="done" title="Browser extension connected" />;
  }
  return (
    <Section state={found ? 'waiting' : 'optional'} title="Browser extension" aside="Optional">
      <Text color="secondary">
        Opens pull requests on github.com in gloss (Alt+G), and starts gloss when it is not running.
      </Text>
      <ol className="setup-steps">
        <li data-done={found || undefined}>
          {found ? (
            'Loaded.'
          ) : (
            <>
              <span>
                In <code>chrome://extensions</code>, turn on Developer mode, click Load unpacked, and pick:
              </span>
              <div className="setup-actions">
                <code className="setup-path">{extension.dir}</code>
                <CopyButton text={extension.dir} />
              </div>
            </>
          )}
        </li>
        <li data-done={extension.hostInstalled || undefined}>
          {extension.hostInstalled ? (
            'Allowed to start gloss.'
          ) : (
            <>
              <span>Let it start gloss for you.</span>
              <div className="setup-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  label="Allow"
                  isLoading={AsyncResult.isWaiting(installing)}
                  onClick={() => install()}
                />
                {AsyncResult.isFailure(installing) && !AsyncResult.isWaiting(installing) && (
                  <Text color="secondary" size="sm">
                    No Chrome, Dia, Arc, Brave, Edge or Vivaldi profile found.
                  </Text>
                )}
              </div>
            </>
          )}
        </li>
      </ol>
    </Section>
  );
}

function JudgeSection({ health }: { health: Health }) {
  const save = useAtomSet(saveJudgeKeyAtom);
  const saving = useAtomValue(saveJudgeKeyAtom);
  const refreshHealth = useAtomRefresh(healthAtom);
  const [key, setKey] = useState('');

  useEffect(() => {
    if (AsyncResult.isSuccess(saving)) refreshHealth();
  }, [saving, refreshHealth]);

  if (health.judge.available) {
    return <Section state="done" title="Jev on" />;
  }
  const waiting = AsyncResult.isWaiting(saving);
  return (
    <Section state="optional" title="Jev" aside="Optional">
      <Text color="secondary">
        TypeSafe's classifier places files and flags auth, stored data and secrets. Without it the model places files.
      </Text>
      <form
        className="setup-actions"
        onSubmit={(event) => {
          event.preventDefault();
          if (key.trim()) save(key.trim());
        }}
      >
        <TextInput
          label="TypeSafe API key"
          isLabelHidden
          type="password"
          autoComplete="off"
          placeholder="TYPESAFE_API_KEY"
          value={key}
          onChange={(next) => setKey(next)}
          containerClassName="setup-key"
          status={
            AsyncResult.isFailure(saving) && !waiting
              ? {
                  type: 'error',
                  message: 'gloss did not come back with Jev. Check the key, or see ~/.gloss/serve.log.',
                }
              : undefined
          }
        />
        <Button type="submit" variant="secondary" label="Save" isDisabled={!key.trim()} isLoading={waiting} />
      </form>
      {waiting && <Spinner size="sm" label="Restarting gloss…" />}
    </Section>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      label={copied ? 'Copied' : 'Copy'}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    />
  );
}
