import Foundation
import Security

/// Where the gloss server is: any `gloss serve` the phone can reach, such as one behind
/// `tailscale serve`. The token is only needed when the server runs with `--token`, and lives
/// in the Keychain.
@Observable
final class Server {
    var url: URL? {
        didSet { UserDefaults.standard.set(url?.absoluteString, forKey: "server") }
    }
    var token: String? {
        didSet { Keychain.token = token }
    }

    init() {
        url = UserDefaults.standard.string(forKey: "server").flatMap(URL.init(string:))
        token = Keychain.token
    }

    /// GitHub PRs waiting on the viewer, the viewer's own, and recent tours, as on the web home page.
    func recent() async throws -> Recent {
        guard let url else { throw URLError(.badURL) }
        var request = URLRequest(url: url.appending(path: "api/recent"))
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(Recent.self, from: data)
    }

    /// The web app's tour page for a PR, which the server serves next to the API.
    func tourURL(_ pull: Pull) -> URL? {
        url?.appending(path: "gh/\(pull.owner)/\(pull.repo)/pull/\(pull.number)")
    }
}

/// The part of `/api/recent` the home screen shows (`RecentToursSchema` in @gloss/protocol).
struct Recent: Decodable {
    var tours: [Entry]
    var reviewRequested: [Entry]?
    var authored: [Entry]?

    struct Entry: Decodable, Hashable {
        var ref: Ref
        var title: String
        var author: String?

        var pull: Pull? {
            guard ref.kind == "github-pr", let owner = ref.owner, let number = ref.number else { return nil }
            return Pull(owner: owner, repo: ref.repo, number: number)
        }
    }

    struct Ref: Decodable, Hashable {
        var kind: String
        var owner: String?
        var repo: String
        var number: Int?
    }
}

struct Pull: Hashable {
    var owner: String
    var repo: String
    var number: Int

    /// A GitHub PR URL or `owner/repo#123`, as the web app's `parseGithubTarget` reads them.
    init?(parsing text: String) {
        let text = text.trimmingCharacters(in: .whitespaces)
        let url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/.ignoresCase()
        let short = /^([\w.-]+)\/([\w.-]+)#(\d+)$/
        if let match = text.firstMatch(of: url) ?? text.wholeMatch(of: short), let number = Int(match.3) {
            self.init(owner: String(match.1), repo: String(match.2), number: number)
        } else {
            return nil
        }
    }

    init(owner: String, repo: String, number: Int) {
        self.owner = owner
        self.repo = repo
        self.number = number
    }
}

private enum Keychain {
    private static let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "gloss",
        kSecAttrAccount as String: "token",
    ]

    static var token: String? {
        get {
            var item: CFTypeRef?
            var lookup = query
            lookup[kSecReturnData as String] = true
            guard SecItemCopyMatching(lookup as CFDictionary, &item) == errSecSuccess, let data = item as? Data
            else { return nil }
            return String(data: data, encoding: .utf8)
        }
        set {
            SecItemDelete(query as CFDictionary)
            guard let newValue, !newValue.isEmpty else { return }
            var item = query
            item[kSecValueData as String] = Data(newValue.utf8)
            SecItemAdd(item as CFDictionary, nil)
        }
    }
}
