import SwiftUI
import Supabase

struct SignInView: View {
    @State private var email = ""
    @State private var status: Status = .idle

    enum Status: Equatable {
        case idle
        case sending
        case sent
        case failed(String)
    }

    var body: some View {
        VStack(spacing: 16) {
            Text("SaveIt").font(.largeTitle.bold())
            Text("Sign in to see the places you've saved.")
                .foregroundStyle(.secondary)

            TextField("Email", text: $email)
                .textContentType(.emailAddress)
                .keyboardType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .textFieldStyle(.roundedBorder)
                .padding(.top)

            Button {
                Task { await sendLink() }
            } label: {
                if status == .sending {
                    ProgressView()
                } else {
                    Text("Send magic link")
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(email.isEmpty || status == .sending)

            switch status {
            case .sent:
                Text("Check your email and tap the link to sign in.")
                    .foregroundStyle(.secondary)
            case .failed(let message):
                Text(message).foregroundStyle(.red)
            case .idle, .sending:
                EmptyView()
            }
        }
        .padding()
    }

    private func sendLink() async {
        status = .sending
        do {
            // Must match the URL scheme registered in the Xcode project and
            // the redirect URL allow-listed in Supabase Auth settings.
            try await SupabaseManager.shared.auth.signInWithOTP(
                email: email,
                redirectTo: URL(string: "saveit://login-callback")
            )
            status = .sent
        } catch {
            status = .failed(error.localizedDescription)
        }
    }
}
