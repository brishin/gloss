import { Stack, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View, useWindowDimensions } from 'react-native';
import { GroupList, OVERVIEW, useColors } from '../../../../src/GroupList.tsx';
import { TourWebView, type TourWebViewHandle } from '../../../../src/TourWebView.tsx';
import { useTour } from '../../../../src/use-tour.ts';

/** Wide enough for two columns: the unfolded iPhone Duo (about 890 pt) and iPads, not the outer screen. */
const SPLIT_MIN_WIDTH = 700;

export default function PullTour() {
  const params = useLocalSearchParams<{ owner: string; repo: string; number: string }>();
  const ref = { kind: 'github-pr' as const, owner: params.owner, repo: params.repo, number: Number(params.number) };
  const { state, groups } = useTour(ref);
  const page = useRef<TourWebViewHandle>(null);
  const [group, setGroup] = useState<string>();
  const { width } = useWindowDimensions();
  const colors = useColors();
  const split = width >= SPLIT_MIN_WIDTH;

  const select = (key: string) => {
    setGroup(key);
    page.current?.select(key);
  };

  const title = state.meta?.title ?? `${ref.repo}#${ref.number}`;
  return (
    <>
      <Stack.Screen options={{ title, headerBackButtonDisplayMode: 'minimal' }} />
      <Stack.Toolbar placement="right">
        {!split && (
          <Stack.Toolbar.Menu icon="list.bullet">
            <Stack.Toolbar.MenuAction onPress={() => select(OVERVIEW)}>Overview</Stack.Toolbar.MenuAction>
            {groups.map((item) => (
              <Stack.Toolbar.MenuAction key={item.key} onPress={() => select(item.key)}>
                {item.label}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
        )}
        <Stack.Toolbar.Button icon="bubble.left.and.text.bubble.right" onPress={() => page.current?.press('q')} />
        <Stack.Toolbar.Menu icon="checkmark.circle">
          <Stack.Toolbar.MenuAction icon="checkmark" onPress={() => review('a')}>
            Approve
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="xmark" onPress={() => review('n')}>
            Request changes
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction icon="text.bubble" onPress={() => review('c')}>
            Comment
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
      <Stack.Toolbar>
        <Stack.Toolbar.Button icon="chevron.up" onPress={() => page.current?.press('k')} />
        <Stack.Toolbar.Button icon="chevron.down" onPress={() => page.current?.press('j')} />
        <Stack.Toolbar.Spacer />
        <Stack.Toolbar.Button icon="bubble.left.and.bubble.right" onPress={() => page.current?.press('c')} />
      </Stack.Toolbar>
      <View style={styles.row}>
        {/* Equal halves keep the divider on the fold, as the Duo HIG asks. */}
        {split && (
          <View style={[styles.half, { borderRightColor: colors.selected }]}>
            <GroupList state={state} groups={groups} selected={group} onSelect={select} />
          </View>
        )}
        <View style={styles.half}>
          <TourWebView ref={page} sourceRef={ref} onGroup={setGroup} />
        </View>
      </View>
    </>
  );

  // The web page's Graphite chord: `r` opens the review panel, the next key picks the verdict.
  function review(verdict: 'a' | 'n' | 'c') {
    page.current?.press('r');
    page.current?.press(verdict);
  }
}

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row' },
  half: { flex: 1, borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: 'transparent' },
});
