# gloss native (prototype)

An Expo app for iPhone, shaped for the unfolded iPhone Duo. Native navigation, toolbars and the
group list; the tour itself is the web app's tour page in a WebView, so diffs (Shiki through
`@pierre/diffs`), notes, walkthroughs, diagrams and Ask render exactly as on desktop.

## Run

```bash
pnpm install
echo 'EXPO_PUBLIC_GLOSS_SERVER=https://<mac>.<tailnet>.ts.net' > apps/native/.env.local
pnpm --filter @gloss/native start   # scan the QR code with Expo Go (SDK 58)
```

The server is any `gloss serve` the phone can reach, such as one behind `tailscale serve`. The
gear button changes it at runtime; a token is only needed when the server runs with `--token`.

## How it fits together

- `src/backend.tsx`: `GlossClient` from `@gloss/protocol` over `expo/fetch`, which streams SSE.
- `src/use-tour.ts`: starts or joins the tour and folds its events with `reduceTourEvent`.
- `src/TourWebView.tsx`: loads `/gh/:owner/:repo/pull/:n`, hides the page's top bar, rail and
  group stepper, and drives it with the page's shortcuts (`j`/`k`, `q`, `c`, `r`). Group changes
  come back through `history`, so the native list follows.
- `app/pr/[owner]/[repo]/[number].tsx`: two equal columns at 700 pt and wider (the Duo's inner
  screen, divider on the fold), one column with a group menu on narrower screens. Header and
  bottom items are `Stack.Toolbar`, so iOS moves them into the side rail on the Duo.
