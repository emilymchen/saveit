import SwiftUI
import Supabase

@main
struct SaveItApp: App {
    @StateObject private var session = SessionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .onOpenURL { url in
                    Task {
                        do {
                            try await SupabaseManager.shared.auth.session(from: url)
                        } catch {
                            print("Failed to complete sign-in from URL: \(error)")
                        }
                    }
                }
        }
    }
}
