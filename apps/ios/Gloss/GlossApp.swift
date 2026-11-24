import SwiftUI

@main
struct GlossApp: App {
    @State private var server = Server()

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environment(server)
        }
    }
}
