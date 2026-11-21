import { Stack, router } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { DEFAULT_SERVER, useBackend } from '../src/backend.tsx';
import { useColors } from '../src/GroupList.tsx';

/** Where the gloss server is. The token is only needed when it runs with `--token`. */
export default function Settings() {
  const { backend, save } = useBackend();
  const colors = useColors();
  const [url, setUrl] = useState(backend.url);
  const [token, setToken] = useState(backend.token ?? '');
  useEffect(() => {
    setUrl(backend.url);
    setToken(backend.token ?? '');
  }, [backend]);

  const field = [styles.field, { color: colors.text, backgroundColor: colors.selected }];
  return (
    <>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="checkmark"
          onPress={async () => {
            await save({ url, token });
            router.back();
          }}
        />
      </Stack.Toolbar>
      <View style={styles.form}>
        <Text style={[styles.label, { color: colors.secondary }]}>Server</Text>
        <TextInput
          style={field}
          value={url}
          onChangeText={setUrl}
          placeholder={DEFAULT_SERVER}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        <Text style={[styles.label, { color: colors.secondary }]}>Token</Text>
        <TextInput
          style={field}
          value={token}
          onChangeText={setToken}
          placeholder="None"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
        />
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  form: { padding: 20, gap: 8 },
  label: { fontSize: 13, fontWeight: '600', marginTop: 8 },
  field: { fontSize: 16, paddingHorizontal: 12, paddingVertical: 10, borderRadius: 10 },
});
