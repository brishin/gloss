import { Stack } from 'expo-router';
import { BackendProvider } from '../src/backend.tsx';

export default function Layout() {
  return (
    <BackendProvider>
      <Stack screenOptions={{ headerLargeTitle: false }}>
        <Stack.Screen name="index" options={{ title: 'gloss', headerLargeTitle: true }} />
        <Stack.Screen name="settings" options={{ title: 'Server', presentation: 'formSheet' }} />
      </Stack>
    </BackendProvider>
  );
}
