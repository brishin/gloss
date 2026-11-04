import { Button } from '@astryxdesign/core/Button';
import { ChatComposer, ChatMessage, ChatMessageBubble, ChatMessageList } from '@astryxdesign/core/Chat';
import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { type DecisionRulesState, type RuleFinding, type RuleRow, rowsFromSets, setsFromRows } from '@gloss/protocol';
import { createFileRoute, Link } from '@tanstack/react-router';
import { AsyncResult } from 'effect/reactivity';
import { XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Logo } from '../components/Logo.tsx';
import { decisionRulesAtom, editDecisionRulesAtom, saveDecisionRulesAtom } from '../lib/client.ts';

export const Route = createFileRoute('/settings')({ component: Settings });

/** What a reviewer tunes once they use gloss; first-run steps live on /setup. */
function Settings() {
  return (
    <main className="setup">
      <div>
        <h1 className="home-logo">
          <Link to="/" aria-label="gloss home">
            <Logo />
          </Link>
        </h1>
        <Text color="secondary">
          Settings, kept in <code>~/.gloss/config.json</code>.
        </Text>
      </div>
      <DecisionRules />
    </main>
  );
}

const emptyRow: RuleRow = { text: '' };

/** Rows as typed and as saved compare by the sets they save as. */
const savedAs = (rows: readonly RuleRow[]) => JSON.stringify(setsFromRows(rows).sets);

function findingText(finding: RuleFinding, rows: readonly RuleRow[], refs: ReturnType<typeof setsFromRows>['refs']) {
  if (finding.other) {
    const { set, rule } = finding.other;
    const other = rows[refs.findIndex((ref) => ref?.set === set && ref.rule === rule)]?.text ?? 'another rule';
    return finding.kind === 'contradiction'
      ? `Conflicts with "${other}".`
      : `Asks for the same decisions as "${other}".`;
  }
  if (finding.kind === 'vague') {
    return 'Too vague to apply.';
  }
  const builtIn = finding.builtIn ? `: ${finding.builtIn}` : '.';
  return finding.kind === 'contradiction'
    ? `Conflicts with a built-in rule${builtIn}`
    : `Already a built-in rule${builtIn}`;
}

interface Turn {
  instruction: string;
  reply: string;
  /** The rows sent with this turn, so the model can undo it. */
  before: RuleRow[];
}

/**
 * The user's own decisions to flag, added to the built-in ones: one row per rule, each with an
 * optional files pattern (all files without one). Below, a chat has the model add, remove or
 * reword rules in bulk; its result is a draft until Save, which Jev checks.
 */
function DecisionRules() {
  const loaded = useAtomValue(decisionRulesAtom);
  const saving = useAtomValue(saveDecisionRulesAtom);
  const save = useAtomSet(saveDecisionRulesAtom);
  const editing = useAtomValue(editDecisionRulesAtom);
  const edit = useAtomSet(editDecisionRulesAtom);
  const [saved, setSaved] = useState<DecisionRulesState | undefined>(undefined);
  const [rows, setRows] = useState<RuleRow[]>([emptyRow]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [asked, setAsked] = useState<{ instruction: string; before: RuleRow[] } | undefined>(undefined);

  // The rules as the backend has them: first as loaded, then after each save that went through.
  const show = (state: DecisionRulesState) => {
    setSaved(state);
    const next = rowsFromSets(state.sets);
    setRows(next.length ? next : [emptyRow]);
  };
  const first = AsyncResult.getOrElse(loaded, () => undefined);
  useEffect(() => {
    if (first && !saved) show(first);
  }, [first]);
  useEffect(() => {
    if (AsyncResult.isSuccess(saving) && !AsyncResult.isWaiting(saving)) show(saving.value);
  }, [saving]);
  // The model's rules replace the rows as a draft; its reply joins the chat.
  useEffect(() => {
    if (!asked || AsyncResult.isWaiting(editing)) return;
    if (AsyncResult.isSuccess(editing)) {
      setRows(editing.value.rules.length ? editing.value.rules : [emptyRow]);
      setTurns((done) => [...done, { ...asked, reply: editing.value.reply }]);
    } else if (AsyncResult.isFailure(editing)) {
      setTurns((done) => [...done, { ...asked, reply: 'Could not change the rules. Try again.' }]);
    }
    setAsked(undefined);
  }, [editing]);

  if (!saved) {
    return AsyncResult.isFailure(loaded) ? (
      <Text color="secondary">This backend keeps no decision rules.</Text>
    ) : (
      <Spinner label="Loading…" />
    );
  }
  const savedRows = rowsFromSets(saved.sets);
  const { sets, refs } = setsFromRows(rows);
  const dirty = savedAs(rows) !== JSON.stringify(saved.sets);
  const waiting = AsyncResult.isWaiting(saving);
  const thinking = asked !== undefined;
  const busy = waiting || thinking;
  const update = (index: number, change: Partial<RuleRow>) =>
    setRows(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const findingsFor = (index: number) => {
    const ref = refs[index];
    return dirty || waiting || !ref
      ? []
      : saved.findings.filter((finding) => finding.set === ref.set && finding.rule === ref.rule);
  };
  const ask = () => {
    const instruction = draft.trim();
    if (!instruction || busy) return;
    const before = rows.filter((row) => row.text.trim());
    setAsked({ instruction, before });
    setDraft('');
    edit({ rules: before, instruction, history: turns.slice(-10) });
  };

  return (
    <section className="rules">
      <div className="setup-line">
        <h2>Decisions to flag</h2>
      </div>
      <Text color="secondary">
        Your own rules, added to the ones gloss flags by default. A files glob, such as *.py or src/**, keeps a rule to
        the files whose path it matches.
      </Text>
      <form
        className="rules-form"
        onSubmit={(event) => {
          event.preventDefault();
          save(sets);
        }}
      >
        <ul className="rules-rows">
          {rows.map((row, index) => (
            <li key={index} className="rules-row">
              <div className="rules-row-inputs">
                <TextInput
                  label="Rule"
                  isLabelHidden
                  placeholder="Flag every new environment variable"
                  value={row.text}
                  isReadOnly={busy}
                  onChange={(text) => update(index, { text })}
                  containerClassName="rules-text"
                />
                <TextInput
                  label="Files"
                  isLabelHidden
                  placeholder="All files, or a glob such as *.py"
                  value={row.files ?? ''}
                  isReadOnly={busy}
                  onChange={(files) => update(index, { files })}
                  containerClassName="rules-files"
                />
                <IconButton
                  label="Remove rule"
                  variant="ghost"
                  size="sm"
                  icon={<Icon icon={XIcon} />}
                  isDisabled={busy}
                  onClick={() => setRows(rows.length > 1 ? rows.filter((_, i) => i !== index) : [emptyRow])}
                />
              </div>
              {findingsFor(index).map((finding) => (
                <Text key={`${finding.kind}-${finding.other?.set}-${finding.other?.rule}`} size="sm" color="secondary">
                  {findingText(finding, savedRows, refs)}
                </Text>
              ))}
            </li>
          ))}
        </ul>
        <div className="setup-actions">
          <Button type="submit" variant="secondary" label="Save" isDisabled={!dirty || thinking} isLoading={waiting} />
          <Button variant="ghost" label="Add rule" isDisabled={busy} onClick={() => setRows([...rows, emptyRow])} />
          {waiting && (
            <Text color="secondary" size="sm">
              Jev is checking them…
            </Text>
          )}
          {AsyncResult.isFailure(saving) && !waiting && (
            <Text color="secondary" size="sm">
              Could not save the rules.
            </Text>
          )}
          {!dirty && !waiting && !saved.checked && saved.sets.length > 0 && (
            <Text color="secondary" size="sm">
              Jev is off, so the rules were not checked.
            </Text>
          )}
        </div>
      </form>
      <div className="rules-chat">
        {(turns.length > 0 || asked) && (
          <ChatMessageList density="compact" align="top">
            {turns.flatMap((turn, index) => [
              <ChatMessage key={`q${index}`} sender="user">
                <ChatMessageBubble>{turn.instruction}</ChatMessageBubble>
              </ChatMessage>,
              <ChatMessage key={`a${index}`} sender="assistant">
                <ChatMessageBubble>{turn.reply}</ChatMessageBubble>
              </ChatMessage>,
            ])}
            {asked && (
              <ChatMessage sender="user">
                <ChatMessageBubble>{asked.instruction}</ChatMessageBubble>
              </ChatMessage>
            )}
          </ChatMessageList>
        )}
        <ChatComposer
          density="compact"
          elevation="none"
          placeholder="Add, change or remove rules, e.g. “add the usual Django checks for .py files”"
          value={draft}
          onChange={setDraft}
          onSubmit={ask}
          isDisabled={busy}
        />
        {thinking && <Spinner size="sm" label="Changing the rules…" />}
        {dirty && turns.length > 0 && !thinking && (
          <Text size="sm" color="secondary">
            Not saved yet: check the rows, then Save.
          </Text>
        )}
      </div>
    </section>
  );
}
