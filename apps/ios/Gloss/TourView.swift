import SwiftUI
import WebKit

/// A PR's tour. In regular width (the unfolded iPhone Duo, iPad) the groups and the page
/// take equal halves, so the divider sits on the fold; in compact width the groups are a
/// toolbar menu. Toolbar items are system ones, so iOS moves them into the Duo's side rail.
struct TourView: View {
    let pull: Pull
    @Environment(Server.self) private var server
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var tour: TourPage?

    var body: some View {
        Group {
            if let tour {
                if sizeClass == .regular {
                    HStack(spacing: 0) {
                        GroupList(tour: tour)
                            .frame(maxWidth: .infinity)
                        Divider()
                        WebView(tour.page)
                            .frame(maxWidth: .infinity)
                    }
                } else {
                    WebView(tour.page)
                }
            }
        }
        .navigationTitle(tour?.summary.title ?? "\(pull.repo)#\(pull.number)")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { if let tour { toolbar(tour) } }
        .task {
            if tour == nil, let url = server.tourURL(pull) {
                tour = TourPage(url: url, token: server.token)
            }
        }
    }

    @ToolbarContentBuilder
    private func toolbar(_ tour: TourPage) -> some ToolbarContent {
        if sizeClass != .regular {
            ToolbarItem(placement: .primaryAction) {
                Menu("Groups", systemImage: "list.bullet") {
                    Picker("Group", selection: Binding(get: { tour.summary.group }, set: tour.select)) {
                        Text("Overview").tag(TourPage.Summary.overview)
                        ForEach(tour.summary.groups) { group in
                            Text(group.label).tag(group.key)
                        }
                    }
                }
            }
        }
        ToolbarItem(placement: .primaryAction) {
            Button("Ask", systemImage: "bubble.left.and.text.bubble.right") { tour.press("q") }
        }
        ToolbarItem(placement: .primaryAction) {
            Button("Comments", systemImage: "bubble.left.and.bubble.right") { tour.press("c") }
        }
        ToolbarItem(placement: .primaryAction) {
            Menu("Review", systemImage: "checkmark.circle") {
                Button("Approve", systemImage: "checkmark") { tour.press("r", "a") }
                Button("Request changes", systemImage: "xmark") { tour.press("r", "n") }
                Button("Comment", systemImage: "text.bubble") { tour.press("r", "c") }
            }
        }
        // Only at the leading end: the trailing corner is where Ask's send button sits.
        ToolbarItemGroup(placement: .bottomBar) {
            Button("Previous group", systemImage: "chevron.up") { tour.press("k") }
            Button("Next group", systemImage: "chevron.down") { tour.press("j") }
        }
        ToolbarSpacer(.flexible, placement: .bottomBar)
    }
}

/// The tour's groups in reading order, led by the overview, as the web rail lists them.
private struct GroupList: View {
    let tour: TourPage

    var body: some View {
        List {
            row(key: TourPage.Summary.overview, label: "Overview", summary: nil, critical: false, files: 0)
            ForEach(tour.summary.groups) { group in
                row(key: group.key, label: group.label, summary: group.summary, critical: group.critical, files: group.files)
            }
            if tour.summary.running {
                Text("Touring…").foregroundStyle(.secondary)
            }
        }
        .listStyle(.plain)
    }

    private func row(key: String, label: String, summary: String?, critical: Bool, files: Int) -> some View {
        Button {
            tour.select(key)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(label).fontWeight(.medium).lineLimit(1)
                    if critical {
                        Circle().fill(.red).frame(width: 6, height: 6).accessibilityLabel("Critical")
                    }
                    Spacer()
                    if files > 0 {
                        Text(files, format: .number).monospacedDigit().foregroundStyle(.secondary)
                    }
                }
                if let summary {
                    Text(summary).font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                }
            }
        }
        .buttonStyle(.plain)
        .listRowBackground(tour.summary.group == key ? Color.secondary.opacity(0.15) : nil)
    }
}
