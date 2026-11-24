import SwiftUI

/// Where the gloss server is, and the token when it runs with `--token`.
struct SettingsView: View {
    @Environment(Server.self) private var server
    @Environment(\.dismiss) private var dismiss
    @State private var url = ""
    @State private var token = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://mac.tailnet.ts.net", text: $url)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                } header: {
                    Text("Server")
                }
                Section {
                    SecureField("None", text: $token)
                } header: {
                    Text("Token")
                }
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", systemImage: "xmark", role: .cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", systemImage: "checkmark", role: .confirm) {
                        let text = url.trimmingCharacters(in: .whitespaces)
                        server.url = URL(string: text.hasSuffix("/") ? String(text.dropLast()) : text)
                        server.token = token.isEmpty ? nil : token
                        dismiss()
                    }
                }
            }
            .onAppear {
                url = server.url?.absoluteString ?? ""
                token = server.token ?? ""
            }
        }
        .presentationDetents([.medium])
    }
}
