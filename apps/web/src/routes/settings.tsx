import { Button } from '@astryxdesign/core/Button';
import { Spinner } from '@astryxdesign/core/Spinner';
import { Text } from '@astryxdesign/core/Text';
import { TextArea } from '@astryxdesign/core/TextArea';
import { TextInput } from '@astryxdesign/core/TextInput';
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { type DecisionRuleSet, type DecisionRulesState, parseRules, type RuleFinding } from '@gloss/protocol';
import { createFileRoute, Link } from '@tanstack/react-router';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useState } from 'react';
import { Logo } from '../components/Logo.tsx';
import { decisionRulesAtom, saveDecisionRulesAtom } from '../lib/client.ts';

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

/** A rule set as typed: a files pattern and the rules as bulleted text. */
interface Draft {
  files: string;
  text: string;
}

const emptyDraft: Draft = { files: '', text: '' };

/** One rule per line, as a bulleted list, so line numbers in findings match the lines. */
const toDraft = (set: DecisionRuleSet): Draft => ({
  files: set.files ?? '',
  text: set.rules.map((rule) => `- ${rule}`).join('\n'),
});

const toSets = (drafts: readonly Draft[]): DecisionRuleSet[] =>
  drafts.flatMap((draft) => {
    const rules = parseRules(draft.text);
    const files = draft.files.trim();
    return rules.length ? [files ? { files, rules } : { rules }] : [];
  });

const badPattern = (pattern: string) => {
  try {
    new RegExp(pattern);
    return false;
  } catch {
    return true;
  }
};

function findingText(finding: RuleFinding, sets: readonly DecisionRuleSet[]): string {
  const line = `Line ${finding.rule + 1}`;
  if (finding.other) {
    const other =
      finding.other.set === finding.set
        ? `line ${finding.other.rule + 1}`
        : `"${sets[finding.other.set]?.rules[finding.other.rule] ?? ''}"`;
    return finding.kind === 'contradiction'
      ? `${line} conflicts with ${other}.`
      : `${line} asks for the same decisions as ${other}.`;
  }
  if (finding.kind === 'vague') {
    return `${line} is too vague to apply.`;
  }
  const builtIn = finding.builtIn ? `: ${finding.builtIn}` : '.';
  return finding.kind === 'contradiction'
    ? `${line} conflicts with a built-in rule${builtIn}`
    : `${line} is already a built-in rule${builtIn}`;
}

/**
 * The user's own decisions to flag, added to the built-in ones. Each set applies to the files
 * its pattern matches (all files without one). Jev checks them on save.
 */
function DecisionRules() {
  const loaded = useAtomValue(decisionRulesAtom);
  const saving = useAtomValue(saveDecisionRulesAtom);
  const save = useAtomSet(saveDecisionRulesAtom);
  const [saved, setSaved] = useState<DecisionRulesState | undefined>(undefined);
  const [drafts, setDrafts] = useState<Draft[]>([emptyDraft]);

  // The sets as the backend has them: first as loaded, then after each save that went through.
  const show = (state: DecisionRulesState) => {
    setSaved(state);
    setDrafts(state.sets.length ? state.sets.map(toDraft) : [emptyDraft]);
  };
  const first = AsyncResult.getOrElse(loaded, () => undefined);
  useEffect(() => {
    if (first && !saved) show(first);
  }, [first]);
  useEffect(() => {
    if (AsyncResult.isSuccess(saving) && !AsyncResult.isWaiting(saving)) show(saving.value);
  }, [saving]);

  if (!saved) {
    return AsyncResult.isFailure(loaded) ? (
      <Text color="secondary">This backend keeps no decision rules.</Text>
    ) : (
      <Spinner label="Loading…" />
    );
  }
  const sets = toSets(drafts);
  const dirty = JSON.stringify(sets) !== JSON.stringify(saved.sets);
  const invalid = drafts.some((draft) => badPattern(draft.files.trim()));
  const waiting = AsyncResult.isWaiting(saving);
  const update = (index: number, change: Partial<Draft>) =>
    setDrafts(drafts.map((draft, i) => (i === index ? { ...draft, ...change } : draft)));

  return (
    <section className="rules">
      <div className="setup-line">
        <h2>Decisions to flag</h2>
      </div>
      <Text color="secondary">
        Your own rules, one per line, added to the ones gloss flags by default. A files pattern keeps them to the files
        whose path it matches.
      </Text>
      <form
        className="rules-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid) save(sets);
        }}
      >
        {drafts.map((draft, index) => (
          <div className="rules-set" key={index}>
            <div className="setup-actions">
              <TextInput
                label="Files"
                isLabelHidden
                placeholder="All files, or a pattern such as \.py$"
                value={draft.files}
                isReadOnly={waiting}
                onChange={(files) => update(index, { files })}
                containerClassName="rules-files"
                status={
                  badPattern(draft.files.trim()) ? { type: 'error', message: 'Not a regular expression' } : undefined
                }
              />
              {drafts.length > 1 && (
                <Button
                  size="sm"
                  variant="ghost"
                  label="Remove"
                  isDisabled={waiting}
                  onClick={() => setDrafts(drafts.filter((_, i) => i !== index))}
                />
              )}
            </div>
            <TextArea
              label="Decisions to flag"
              isLabelHidden
              rows={Math.max(3, draft.text.split('\n').length + 1)}
              placeholder={'- Flag every new environment variable\n- Flag a changed timeout or retry count as high'}
              value={draft.text}
              isReadOnly={waiting}
              onChange={(text) => update(index, { text })}
            />
            {!dirty && !waiting && (
              <ul className="rules-findings">
                {saved.findings
                  .filter((finding) => finding.set === index)
                  .map((finding) => (
                    <li key={`${finding.rule}-${finding.kind}-${finding.other?.set}-${finding.other?.rule}`}>
                      {findingText(finding, saved.sets)}
                    </li>
                  ))}
              </ul>
            )}
          </div>
        ))}
        <div className="setup-actions">
          <Button type="submit" variant="secondary" label="Save" isDisabled={!dirty || invalid} isLoading={waiting} />
          <Button
            variant="ghost"
            label="Add rules for other files"
            isDisabled={waiting}
            onClick={() => setDrafts([...drafts, emptyDraft])}
          />
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
    </section>
  );
}
