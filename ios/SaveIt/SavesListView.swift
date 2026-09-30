import SwiftUI
import Supabase

struct SavesListView: View {
    @State private var saves: [Save] = []
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if let errorMessage {
                    Text(errorMessage).foregroundStyle(.red).padding()
                } else if saves.isEmpty {
                    ContentUnavailableView(
                        "No saves yet",
                        systemImage: "mappin.slash",
                        description: Text("Share a post to @saveit624 and it'll show up here.")
                    )
                } else {
                    List(saves) { save in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Text(save.placeName).font(.headline)
                                if !save.resolved {
                                    Text("unresolved")
                                        .font(.caption)
                                        .foregroundStyle(.orange)
                                }
                            }
                            if let address = save.address {
                                Text(address).font(.subheadline).foregroundStyle(.secondary)
                            }
                            Text(save.evidence)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 4)
                    }
                    .refreshable { await load() }
                }
            }
            .navigationTitle("Saves")
        }
        .task { await load() }
    }

    private func load() async {
        do {
            saves = try await SupabaseManager.shared
                .from("saves")
                .select()
                .order("created_at", ascending: false)
                .execute()
                .value
            errorMessage = nil
        } catch {
            errorMessage = "Couldn't load saves: \(error.localizedDescription)"
        }
    }
}
