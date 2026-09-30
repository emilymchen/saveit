import SwiftUI
import Supabase

struct RootView: View {
    @EnvironmentObject private var session: SessionStore
    @State private var isLinked: Bool?

    private struct SenderRow: Decodable {
        let igsid: String
    }

    var body: some View {
        Group {
            if session.isLoading {
                ProgressView()
            } else if session.userId == nil {
                SignInView()
            } else if isLinked == nil {
                ProgressView().task(id: session.userId) { await checkLinked() }
            } else if isLinked == true {
                SavesListView()
            } else {
                LinkAccountView(userId: session.userId!) {
                    Task { await checkLinked() }
                }
            }
        }
    }

    private func checkLinked() async {
        guard let userId = session.userId else { return }
        do {
            let rows: [SenderRow] = try await SupabaseManager.shared
                .from("senders")
                .select("igsid")
                .eq("auth_user_id", value: userId.uuidString)
                .execute()
                .value
            isLinked = !rows.isEmpty
        } catch {
            // Leave isLinked nil so the loading spinner stays up rather than
            // guessing; the .task(id:) above re-runs if userId changes.
        }
    }
}
