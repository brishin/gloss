import type { SourceRef } from '@gloss/protocol';
import { forwardRef, useImperativeHandle, useMemo, useRef, type ComponentType, type Ref } from 'react';
import { WebView as RNWebView, type WebViewMessageEvent, type WebViewProps } from 'react-native-webview';
import { useBackend } from './backend.tsx';

export interface TourWebViewHandle {
  /** Shows a group, as a back/forward to `?g=` would. */
  select(groupKey: string): void;
  /** Sends one of the tour page's keyboard shortcuts (`j`, `k`, `q`, `c`, `r`...). */
  press(key: string): void;
}

interface Props {
  sourceRef: Extract<SourceRef, { kind: 'github-pr' }>;
  group?: string;
  /** The group the page moved to on its own (a shortcut, a link in the overview). */
  onGroup?: (groupKey: string | undefined) => void;
}

/**
 * The web app's tour page, which renders the diff (Shiki through @pierre/diffs), notes,
 * walkthroughs, Mermaid diagrams and Ask exactly as on desktop. The native app hides the
 * page's own top bar, group rail and group stepper, and drives it with shortcuts instead.
 */
export const TourWebView = forwardRef<TourWebViewHandle, Props>(function TourWebView(
  { sourceRef, group, onGroup },
  ref,
) {
  const { backend } = useBackend();
  const view = useRef<WebViewRef>(null);
  // Only the first group goes in the URL; later ones go through `select` so the page keeps its state.
  const uri = useMemo(() => {
    const path = `/gh/${sourceRef.owner}/${sourceRef.repo}/pull/${sourceRef.number}`;
    return `${backend.url}${path}${group ? `?g=${encodeURIComponent(group)}` : ''}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend.url, sourceRef.owner, sourceRef.repo, sourceRef.number]);

  useImperativeHandle(ref, () => ({
    select(groupKey) {
      view.current?.injectJavaScript(`(() => {
        const url = new URL(location.href);
        url.searchParams.set('g', ${JSON.stringify(groupKey)});
        url.searchParams.delete('f');
        history.pushState(history.state, '', url);
        dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
        scrollTo(0, 0);
      })(); true;`);
    },
    press(key) {
      view.current?.injectJavaScript(
        `dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true })); true;`,
      );
    },
  }));

  const onMessage = (event: WebViewMessageEvent) => {
    const search = new URLSearchParams(event.nativeEvent.data);
    onGroup?.(search.get('g') ?? undefined);
  };

  return (
    <WebView
      ref={view}
      source={{ uri }}
      injectedJavaScriptBeforeContentLoaded={bootstrap(backend.token)}
      onMessage={onMessage}
      contentInsetAdjustmentBehavior="automatic"
      allowsBackForwardNavigationGestures={false}
      pullToRefreshEnabled
      style={{ flex: 1, backgroundColor: 'transparent' }}
    />
  );
});

// react-native-webview 14's props resolve to `never` under RN 0.88's strict types, so this
// names the props and the ref method the page uses.
interface WebViewRef {
  injectJavaScript(script: string): void;
}
const WebView = RNWebView as unknown as ComponentType<Partial<WebViewProps> & { ref?: Ref<WebViewRef> }>;

/** Runs before the page's own scripts: the token, the hidden chrome, and URL changes back to native. */
function bootstrap(token: string | undefined): string {
  const css = `
    .topbar, .sidebar, .subbar, .nav-scrim { display: none !important; }
    .app { --topbar-h: 0px !important; --subbar-h: 0px !important; }
    .tour { grid-template-columns: minmax(0, 1fr) !important; }
  `;
  return `(() => {
    window.__GLOSS__ = Object.assign({}, window.__GLOSS__, ${JSON.stringify(token ? { token } : {})});
    // An adopted sheet needs no <head>, which may not exist yet at document start.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(${JSON.stringify(css)});
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    const post = () => window.ReactNativeWebView.postMessage(location.search);
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name].bind(history);
      history[name] = (...args) => { const result = original(...args); post(); return result; };
    }
    addEventListener('popstate', post);
  })(); true;`;
}
