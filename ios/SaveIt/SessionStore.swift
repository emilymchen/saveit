import Foundation
import Supabase

/// Tracks the current signed-in user, if any. `userId` drives which screen
/// `RootView` shows.
@MainActor
final class SessionStore: ObservableObject {
    @Published var userId: UUID?
    @Published var isLoading = true

    // Lives for the whole app lifetime (it's the root @StateObject), so no
    // deinit cancellation — which also sidesteps Swift 6's rule against
    // touching main-actor state from a nonisolated deinit.
    init() {
        Task {
            for await (_, session) in await SupabaseManager.shared.auth.authStateChanges {
                self.userId = session?.user.id
                self.isLoading = false
            }
        }
    }

    func signOut() async {
        try? await SupabaseManager.shared.auth.signOut()
    }
}
