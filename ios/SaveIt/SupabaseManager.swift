import Foundation
import Supabase

/// Single shared client for the whole app. Uses the **publishable** (anon)
/// key — safe to embed in the app binary, unlike the backend's secret key.
/// Every table this touches has RLS enabled with policies scoped to
/// `auth.uid()` (see supabase/schema.sql in the repo root), so this key alone
/// can never read another user's data.
enum SupabaseManager {
    static let shared = SupabaseClient(
        supabaseURL: URL(string: "https://ruzwidbrskofmgiomayt.supabase.co")!,
        // TODO: paste your project's publishable/anon key here.
        // Project Settings -> API -> "anon" / "publishable" key. NOT the
        // secret/service_role key the backend uses.
        supabaseKey: "PASTE_PUBLISHABLE_KEY_HERE"
    )
}
