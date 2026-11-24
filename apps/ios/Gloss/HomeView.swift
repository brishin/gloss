import SwiftUI

/// The same lists as the web home page: review requests, your PRs, recent tours.
struct HomeView: View {
    @Environment(Server.self) private var server
    @State private var recent: Recent?
    @State private var error: String?
    @State private var path: [Pull] = []
    @State private var asking = false
    @State private var target = ""
    @State private var settings = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                section("Review requested", recent?.reviewRequested)
                section("Your PRs", recent?.authored)
                section("Recent", recent?.tours)
            }
            .overlay {
                if server.url == nil {
                    ContentUnavailableView {
                        Label("No server", systemImage: "server.rack")
                    } description: {
                        Text("Add the URL of a gloss server this phone can reach.")
                    } actions: {
                        Button("Add server") { settings = true }
                    }
                } else if let error, recent == nil {
                    ContentUnavailableView("Could not reach the server", systemImage: "wifi.slash", description: Text(error))
                }
            }
            .navigationTitle("gloss")
            .navigationDestination(for: Pull.self) { pull in
                TourView(pull: pull)
            }
            .toolbar {
                ToolbarItemGroup(placement: .primaryAction) {
                    Button("Tour a PR", systemImage: "plus") { asking = true }
                    Button("Server", systemImage: "gearshape") { settings = true }
                }
            }
            .alert("Tour a PR", isPresented: $asking) {
                TextField("URL or owner/repo#123", text: $target)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("Tour") {
                    if let pull = Pull(parsing: target) { path.append(pull) }
                    target = ""
                }
                Button("Cancel", role: .cancel) { target = "" }
            }
            .sheet(isPresented: $settings) {
                SettingsView()
            }
            .refreshable { await load() }
            .task(id: server.url) { await load() }
        }
    }

    @ViewBuilder
    private func section(_ title: String, _ entries: [Recent.Entry]?) -> some View {
        let entries = (entries ?? []).filter { $0.pull != nil }
        if !entries.isEmpty {
            Section(title) {
                ForEach(entries, id: \.self) { entry in
                    let pull = entry.pull!
                    NavigationLink(value: pull) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.title).lineLimit(2)
                            Text("\(pull.repo)#\(pull.number)" + (entry.author.map { " · \($0)" } ?? ""))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
    }

    private func load() async {
        guard server.url != nil else { return }
        do {
            recent = try await server.recent()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
