import SwiftUI
import WebKit

/// The web app's tour page, which renders diffs (Shiki through @pierre/diffs), notes,
/// walkthroughs, diagrams and Ask exactly as on desktop. The app hides the page's top bar,
/// group rail and group stepper, drives it with its keyboard shortcuts, and learns its groups
/// from the `gloss` message handler (the web app's `TellHost` command).
@Observable
final class TourPage {
    let page: WebPage
    private(set) var summary = Summary()

    struct Summary: Decodable {
        var title: String?
        var running = true
        var group = Summary.overview
        var groups: [Group] = []

        static let overview = "__overview"

        struct Group: Decodable, Identifiable {
            var key: String
            var label: String
            var summary: String?
            var critical: Bool
            var files: Int
            var id: String { key }
        }
    }

    init(url: URL, token: String?) {
        let configuration = WebPage.Configuration()
        let scripts = configuration.userContentController
        scripts.addUserScript(
            WKUserScript(source: Self.bootstrap(token: token), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        page = WebPage(configuration: configuration)
        scripts.add(Receiver { [weak self] summary in self?.summary = summary }, name: "gloss")
        page.load(URLRequest(url: url))
    }

    /// Shows a group, as back/forward to its `?g=` would.
    func select(_ key: String) {
        summary.group = key
        run("""
            const url = new URL(location.href);
            url.searchParams.set('g', key);
            url.searchParams.delete('f');
            history.pushState(history.state, '', url);
            dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
            """, ["key": key])
    }

    /// Sends one of the page's shortcuts: j/k groups, q Ask, c comments, r then a/n/c to review.
    func press(_ keys: String...) {
        run("for (const key of keys) dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));", ["keys": keys])
    }

    private func run(_ body: String, _ arguments: [String: Any]) {
        Task { _ = try? await page.callJavaScript(body, arguments: arguments) }
    }

    /// Runs before the page's scripts: the token, and a sheet that hides the page's own chrome.
    /// The sub-bar collapses rather than going away, since its bottom is the page's reading line
    /// (which group is in view). So does the top bar, so the review popover of its Review button
    /// (opened by `r`) still shows, pinned to the top right. It is sized in `%`, since `vw` in this
    /// WebView spans the whole screen, past the page. Ask's header takes the top bar's height, so it
    /// keeps its own.
    private static func bootstrap(token: String?) -> String {
        let config = (try? JSONSerialization.data(withJSONObject: token.map { ["token": $0] } ?? [:]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        return """
            (() => {
            window.__GLOSS__ = Object.assign({}, window.__GLOSS__, \(config));
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(`
              .sidebar, .nav-scrim { display: none !important; }
              .subbar {
                visibility: hidden; height: 0 !important; min-height: 0 !important;
                padding: 0 !important; border: 0 !important; overflow: hidden !important;
              }
              .topbar {
                visibility: hidden; height: 0 !important; min-height: 0 !important;
                padding: 0 !important; border: 0 !important; overflow: visible !important;
              }
              .topbar [popover] {
                visibility: visible; position-visibility: always !important;
                position-area: none !important; position-try-fallbacks: none !important;
                inset: var(--spacing-2) var(--spacing-2) auto auto !important; margin: 0 !important;
                width: min(440px, calc(100% - 2 * var(--spacing-2))) !important; max-width: none !important;
              }
              .topbar [popover] .astryx-popover { width: auto !important; max-width: none !important; }
              .app { --topbar-h: 0px !important; --subbar-h: 0px !important; }
              .tour { grid-template-columns: minmax(0, 1fr) !important; }
              .ask-header { height: 40px !important; }
            `);
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
            })();
            """
    }
}

private final class Receiver: NSObject, WKScriptMessageHandler {
    let onSummary: (TourPage.Summary) -> Void

    init(_ onSummary: @escaping (TourPage.Summary) -> Void) {
        self.onSummary = onSummary
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let data = try? JSONSerialization.data(withJSONObject: message.body),
            let summary = try? JSONDecoder().decode(TourPage.Summary.self, from: data)
        else { return }
        onSummary(summary)
    }
}
