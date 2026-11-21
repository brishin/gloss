# gloss for iPhone

A SwiftUI app for the iPhone, shaped for the unfolded iPhone Duo. Stock Xcode, no
dependencies. Navigation, toolbars, the PR list and the group list are native; the tour is the
web app's tour page in WebKit's SwiftUI `WebView`, so diffs, notes, walkthroughs, diagrams and
Ask render as on desktop.

Open `Gloss.xcodeproj` in Xcode 27, pick your team under Signing, and run. Needs iOS 26 or later.
On first launch, add the server: any `gloss serve` the phone can reach, such as its
`tailscale serve` URL. The token is only needed when the server runs with `--token`; it is kept in
the Keychain.

- `Server.swift`: server URL, Keychain token, `/api/recent`.
- `TourPage.swift`: the `WebPage`. A user script hides the page's top bar, rail and group stepper and
  passes the token. The page reports its title and groups through the `gloss` message handler (the
  web app's `TellHost` command), and the app drives it with the page's shortcuts (j/k, q, c, r).
- `TourView.swift`: equal halves in regular width, so the divider sits on the Duo's fold; a group
  menu in compact width. System toolbar items, so iOS moves them into the Duo's side rail.
