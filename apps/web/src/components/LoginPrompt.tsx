import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Dialog } from '@astryxdesign/core/Dialog';
import { Heading } from '@astryxdesign/core/Heading';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useAtomRefresh, useAtomSet, useAtomValue } from '@effect/atom-react';
import type { LoginPrompt as Question, LoginSession, ProviderLogin } from '@gloss/protocol';
import { AsyncResult, Atom } from 'effect/reactivity';
import { useEffect, useState } from 'react';
import { answerLoginAtom, healthAtom, loginAtom } from '../lib/client.ts';
import { missingLogins } from '../lib/login.ts';

/**
 * Opens by itself when the backend's models use a provider that is not signed in (Claude or
 * ChatGPT), and signs it in from the app: the subscription's OAuth sign-in or an API key. The
 * flow runs on the backend, which stores the credential; this only shows its steps and relays
 * answers. "Not now" hides it until the page reloads.
 */
export function LoginPrompt() {
  const health = AsyncResult.getOrElse(useAtomValue(healthAtom), () => undefined);
  const refreshHealth = useAtomRefresh(healthAtom);
  const login = useAtomValue(loginAtom);
  const setLogin = useAtomSet(loginAtom);
  const [dismissed, setDismissed] = useState(false);

  const missing = health ? missingLogins(health) : [];
  const session = AsyncResult.getOrElse(login, () => undefined);
  const started = !AsyncResult.isInitial(login);
  const succeeded = session?.state === 'succeeded';

  // A new credential changes what the backend reports.
  useEffect(() => {
    if (succeeded) refreshHealth();
  }, [succeeded, refreshHealth]);

  const reset = () => setLogin(Atom.Reset);
  const close = () => {
    reset();
    setDismissed(true);
  };
  const isOpen = started || (missing.length > 0 && !dismissed);

  return (
    <Dialog isOpen={isOpen} onOpenChange={(open) => !open && close()} purpose="form" width={440} padding={4}>
      <div className="login-prompt">
        {!started ? (
          <Choices missing={missing} onStart={setLogin} onDismiss={close} />
        ) : AsyncResult.isFailure(login) && !session ? (
          <Ended
            status="error"
            title="Could not reach the gloss backend"
            description="Check that `gloss serve` is running, then try again."
            onDone={reset}
          />
        ) : session ? (
          <Progress
            session={session}
            onCancel={reset}
            onDone={
              // Back to the choices while another provider still needs signing in; health may not have
              // caught up with this sign-in yet, so it does not count.
              !succeeded || missing.some((login) => login.subscription !== session.subscription) ? reset : close
            }
          />
        ) : (
          <Spinner label="Starting sign-in…" />
        )}
      </div>
    </Dialog>
  );
}

function Choices({
  missing,
  onStart,
  onDismiss,
}: {
  missing: readonly ProviderLogin[];
  onStart: (start: { subscription: ProviderLogin['subscription']; method: 'oauth' | 'api_key' }) => void;
  onDismiss: () => void;
}) {
  return (
    <>
      <Heading level={2}>Sign in to run tours</Heading>
      <Text color="secondary">
        gloss's models use {missing.map((login) => login.label).join(' and ')}, which{' '}
        {missing.length > 1 ? 'are' : 'is'} not signed in on this backend. Sign in here; the credential stays on the
        backend, in <code>~/.gloss/auth.json</code>.
      </Text>
      {missing.map((login) => (
        <div className="login-choice" key={login.subscription}>
          <Button
            variant="primary"
            label={`Sign in with ${login.label}`}
            onClick={() => onStart({ subscription: login.subscription, method: 'oauth' })}
          />
          <Button
            variant="secondary"
            label={`Use an ${login.apiKeyLabel}`}
            onClick={() => onStart({ subscription: login.subscription, method: 'api_key' })}
          />
        </div>
      ))}
      <div className="login-actions">
        <Button variant="ghost" label="Not now" onClick={onDismiss} />
      </div>
    </>
  );
}

function Progress({ session, onCancel, onDone }: { session: LoginSession; onCancel: () => void; onDone: () => void }) {
  if (session.state === 'succeeded') {
    return <Ended status="success" title="Signed in" description="New tours will use it." onDone={onDone} />;
  }
  if (session.state === 'failed') {
    return <Ended status="error" title="Sign-in failed" description={session.error} onDone={onDone} />;
  }
  if (session.state === 'cancelled') {
    return <Ended status="warning" title="Sign-in cancelled" onDone={onDone} />;
  }
  const latest = session.messages.at(-1);
  return (
    <>
      <Heading level={2}>{session.method === 'api_key' ? 'Add an API key' : 'Sign in'}</Heading>
      {session.authUrl && (
        <div className="section">
          <Text>{session.authUrl.instructions ?? 'Finish signing in on the provider’s page.'}</Text>
          <div>
            <Button
              variant="primary"
              label="Open sign-in page"
              href={session.authUrl.url}
              target="_blank"
              rel="noreferrer"
            />
          </div>
        </div>
      )}
      {session.deviceCode && (
        <div className="section">
          <Text>
            Go to{' '}
            <a href={session.deviceCode.verificationUri} target="_blank" rel="noreferrer">
              {session.deviceCode.verificationUri}
            </a>{' '}
            and enter <code>{session.deviceCode.userCode}</code>.
          </Text>
        </div>
      )}
      {session.prompt ? (
        <Answer key={session.prompt.id} loginId={session.id} question={session.prompt} />
      ) : (
        <Spinner label={latest ?? 'Waiting for the sign-in to finish…'} />
      )}
      <div className="login-actions">
        <Button variant="ghost" label="Cancel" onClick={onCancel} />
      </div>
    </>
  );
}

/** The login's current question: a choice, or text (masked when it is a secret, like an API key). */
function Answer({ loginId, question }: { loginId: string; question: Question }) {
  const answer = useAtomSet(answerLoginAtom);
  const result = useAtomValue(answerLoginAtom);
  const [value, setValue] = useState('');
  const [sent, setSent] = useState(false);
  const send = (text: string) => {
    setSent(true);
    answer({ loginId, promptId: question.id, value: text });
  };
  const failed = sent && AsyncResult.isFailure(result) && !AsyncResult.isWaiting(result);

  if (question.type === 'select') {
    return (
      <div className="section">
        <Text>{question.message}</Text>
        {question.options?.map((option, index) => (
          <Button
            key={option.id}
            variant={index === 0 ? 'primary' : 'secondary'}
            label={option.label}
            tooltip={option.description}
            isDisabled={sent && !failed}
            onClick={() => send(option.id)}
          />
        ))}
      </div>
    );
  }
  return (
    <form
      className="section"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) send(value.trim());
      }}
    >
      <TextInput
        label={question.message}
        type={question.type === 'secret' ? 'password' : 'text'}
        autoComplete="off"
        placeholder={question.placeholder}
        value={value}
        hasAutoFocus
        onChange={(next) => setValue(next)}
        status={failed ? { type: 'error', message: 'Could not send that; try again.' } : undefined}
      />
      <div>
        <Button
          type="submit"
          variant={question.type === 'manual_code' ? 'secondary' : 'primary'}
          label="Continue"
          isDisabled={!value.trim()}
          isLoading={sent && !failed}
        />
      </div>
    </form>
  );
}

function Ended({
  status,
  title,
  description,
  onDone,
}: {
  status: 'success' | 'error' | 'warning';
  title: string;
  description?: string;
  onDone: () => void;
}) {
  return (
    <>
      <Banner status={status} title={title} description={description} />
      <div className="login-actions">
        <Button variant="primary" label={status === 'success' ? 'Done' : 'Back'} onClick={onDone} />
      </div>
    </>
  );
}
