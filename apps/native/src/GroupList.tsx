import type { GroupView, TourState } from '@gloss/protocol';
import { FlatList, Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native';

export const OVERVIEW = '__overview';

interface Props {
  state: TourState;
  groups: GroupView[];
  selected?: string;
  onSelect: (groupKey: string) => void;
}

/** The tour's groups in reading order, led by the overview, as the web rail lists them. */
export function GroupList({ state, groups, selected, onSelect }: Props) {
  const colors = useColors();
  const rows = [{ key: OVERVIEW, label: 'Overview', summary: state.overallSummary, critical: false, files: 0 }].concat(
    groups.map((group) => ({
      key: group.key,
      label: group.label,
      summary: group.summary,
      critical: group.critical,
      files: group.fileIds.length,
    })),
  );
  return (
    <FlatList
      data={rows}
      keyExtractor={(row) => row.key}
      contentInsetAdjustmentBehavior="automatic"
      ListFooterComponent={
        state.status === 'running' ? (
          <Text style={[styles.status, { color: colors.secondary }]}>Touring…</Text>
        ) : undefined
      }
      renderItem={({ item, index }) => {
        const active = (selected ?? OVERVIEW) === item.key;
        return (
          <Pressable
            onPress={() => onSelect(item.key)}
            style={[styles.row, active && { backgroundColor: colors.selected }]}
          >
            <Text style={[styles.index, { color: colors.secondary }]}>{index === 0 ? '' : index}</Text>
            <View style={styles.body}>
              <View style={styles.title}>
                <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>
                  {item.label}
                </Text>
                {item.critical && <View style={[styles.critical, { backgroundColor: colors.critical }]} />}
                {item.files > 0 && <Text style={[styles.count, { color: colors.secondary }]}>{item.files}</Text>}
              </View>
              {item.summary ? (
                <Text style={[styles.summary, { color: colors.secondary }]} numberOfLines={2}>
                  {item.summary}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      }}
    />
  );
}

export function useColors() {
  const dark = useColorScheme() === 'dark';
  return dark
    ? { text: '#f2f2f2', secondary: '#9a9a9f', selected: '#2c2c2e', critical: '#ff453a' }
    : { text: '#1c1c1e', secondary: '#6c6c70', selected: '#e9e9eb', critical: '#ff3b30' };
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', paddingVertical: 10, paddingHorizontal: 16, marginHorizontal: 8, borderRadius: 10 },
  index: { width: 22, fontSize: 15, fontVariant: ['tabular-nums'] },
  body: { flex: 1, gap: 2 },
  title: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  label: { flexShrink: 1, fontSize: 15, fontWeight: '500' },
  critical: { width: 6, height: 6, borderRadius: 3 },
  count: { marginLeft: 'auto', fontSize: 13, fontVariant: ['tabular-nums'] },
  summary: { fontSize: 13, lineHeight: 18 },
  status: { padding: 16, fontSize: 13 },
});
