import { parseGithubTarget, type RecentTour, type RecentTours } from '@gloss/protocol';
import { Stack, router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { useBackend } from '../src/backend.tsx';
import { useColors } from '../src/GroupList.tsx';

/** The same three lists as the web home page: review requests, your PRs, recent tours. */
export default function Home() {
  const { client, ready, backend } = useBackend();
  const colors = useColors();
  const [recent, setRecent] = useState<RecentTours>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRecent(await client.recent());
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (ready) {
      void load();
    }
  }, [ready, load]);

  const open = (tour: RecentTour) => {
    if (tour.ref.kind === 'github-pr') {
      const { owner, repo, number } = tour.ref;
      router.push({ pathname: '/pr/[owner]/[repo]/[number]', params: { owner, repo, number: String(number) } });
    }
  };

  const ask = () =>
    Alert.prompt('Tour a PR', 'A GitHub PR URL or owner/repo#123', (text) => {
      const ref = parseGithubTarget(text);
      if (ref?.kind === 'github-pr') {
        router.push({
          pathname: '/pr/[owner]/[repo]/[number]',
          params: { owner: ref.owner, repo: ref.repo, number: String(ref.number) },
        });
      }
    });

  const sections = [
    { title: 'Review requested', data: recent?.reviewRequested ?? [] },
    { title: 'Your PRs', data: recent?.authored ?? [] },
    { title: 'Recent', data: (recent?.tours ?? []).filter((tour) => tour.ref.kind === 'github-pr') },
  ].filter((section) => section.data.length > 0);

  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon="plus" onPress={ask} />
        <Stack.Toolbar.Button icon="gearshape" onPress={() => router.push('/settings')} />
      </Stack.Toolbar>
      <SectionList
        sections={sections}
        keyExtractor={(tour, index) => `${JSON.stringify(tour.ref)}:${index}`}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={<RefreshControl refreshing={loading} onRefresh={load} />}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.secondary }]}>
            {error ? `Could not reach ${backend.url}\n${error}` : loading ? '' : 'No PRs yet.'}
          </Text>
        }
        renderSectionHeader={({ section }) => (
          <Text style={[styles.header, { color: colors.secondary }]}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => open(item)}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.selected }]}
          >
            <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
              {item.title}
            </Text>
            <View style={styles.meta}>
              <Text style={[styles.small, { color: colors.secondary }]}>
                {item.ref.kind === 'github-pr' ? `${item.ref.repo}#${item.ref.number}` : ''}
                {item.author ? ` · ${item.author}` : ''}
              </Text>
            </View>
          </Pressable>
        )}
      />
    </>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: 20, paddingTop: 20, paddingBottom: 6, fontSize: 13, fontWeight: '600' },
  row: { paddingHorizontal: 20, paddingVertical: 10, gap: 2 },
  title: { fontSize: 16 },
  meta: { flexDirection: 'row' },
  small: { fontSize: 13 },
  empty: { padding: 20, fontSize: 15, textAlign: 'center' },
});
