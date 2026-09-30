import SwiftUI
import Supabase

/// Shown when signed in but no `senders` row is linked to this account yet.
/// Generates a short code, inserts it into `link_codes`, and polls until the
/// backend's `tryHandleLinkCode()` (src/ingest/linking.ts) marks it used —
/// at which point `onLinked` fires and `RootView` switches to the saves list.
struct LinkAccountView: View {
    let userId: UUID
    let onLinked: () -> Void

    @State private var code: String?
    @State private var errorMessage: String?

    private struct NewLinkCode: Encodable {
        let code: String
        let auth_user_id: UUID
        let expires_at: String
    }

    private struct UsedAtRow: Decodable {
        let used_at: String?
    }

    var body: some View {
        VStack(spacing: 20) {
            Text("Link your Instagram").font(.title2.bold())
            Text("DM this code to @saveit624 to connect your account.")
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)

            if let code {
                Text(code)
                    .font(.system(.largeTitle, design: .monospaced).bold())
                    .padding()
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                ProgressView("Waiting for the DM…")
            } else if let errorMessage {
                Text(errorMessage).foregroundStyle(.red)
            } else {
                ProgressView()
            }
        }
        .padding()
        .task {
            await generateAndPoll()
        }
    }

    private func generateAndPoll() async {
        let newCode = Self.randomCode()
        let expiresAt = ISO8601DateFormatter().string(from: Date().addingTimeInterval(15 * 60))

        do {
            try await SupabaseManager.shared
                .from("link_codes")
                .insert(NewLinkCode(code: newCode, auth_user_id: userId, expires_at: expiresAt))
                .execute()
            code = newCode
        } catch {
            errorMessage = "Couldn't generate a code: \(error.localizedDescription)"
            return
        }

        // Poll rather than a realtime subscription — simplest thing that
        // works for a screen the user is actively looking at for well under
        // the code's 15-minute expiry.
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(3))
            do {
                let rows: [UsedAtRow] = try await SupabaseManager.shared
                    .from("link_codes")
                    .select("used_at")
                    .eq("code", value: newCode)
                    .execute()
                    .value
                if rows.first?.used_at != nil {
                    onLinked()
                    return
                }
            } catch {
                // Transient network hiccup — just try again on the next tick.
            }
        }
    }

    /// Avoids visually ambiguous characters (0/O, 1/I/L) since this gets
    /// typed into a DM by hand.
    private static func randomCode(length: Int = 6) -> String {
        let alphabet = Array("ABCDEFGHJKMNPQRSTUVWXYZ23456789")
        return String((0..<length).map { _ in alphabet.randomElement()! })
    }
}
