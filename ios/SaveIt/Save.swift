import Foundation

/// Mirrors the `saves` table in supabase/schema.sql. `createdAt` is decoded
/// as a raw string rather than `Date` deliberately — Postgres's
/// `timestamptz` serializes with fractional-second precision
/// (`2026-09-30T01:11:34.8117+00:00`), and rather than guess at whichever
/// date-decoding strategy the SDK's default JSONDecoder uses internally,
/// formatting is done explicitly at the display site with
/// `ISO8601DateFormatter` (see `SavesListView`).
struct Save: Decodable, Identifiable {
    let id: UUID
    let placeName: String
    let nameSource: String
    let category: String?
    let cuisine: String?
    let evidence: String
    let resolved: Bool
    let address: String?
    let placeId: String?
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id
        case placeName = "place_name"
        case nameSource = "name_source"
        case category
        case cuisine
        case evidence
        case resolved
        case address
        case placeId = "place_id"
        case createdAt = "created_at"
    }
}
