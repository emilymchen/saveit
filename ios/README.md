# SaveIt iOS — setup

This folder has the Swift source but deliberately **not** an `.xcodeproj` —
hand-authoring that file format risks producing something that silently fails
to open, with no way for me to catch it since I don't have Xcode on this
machine to verify it. Creating the project through Xcode's own wizard
guarantees it at least opens correctly; you then just add these files to it.

## 1. Create the project

1. Xcode → **File → New → Project → iOS → App**.
2. Product Name: `SaveIt`. Interface: **SwiftUI**. Language: **Swift**.
3. Save it *inside this `ios/` folder* (so the project lives alongside this
   README, not somewhere else on disk).
4. Xcode will generate its own `SaveItApp.swift` and `ContentView.swift` —
   delete both; the ones in `ios/SaveIt/` replace them.
5. Target → **General → Minimum Deployments**: iOS **17.0** or later (the
   saves list uses `ContentUnavailableView`, which is iOS 17+).

## 2. Add the source files

Drag every file from `ios/SaveIt/` (`SaveItApp.swift`, `RootView.swift`,
`SignInView.swift`, `LinkAccountView.swift`, `SavesListView.swift`,
`SessionStore.swift`, `SupabaseManager.swift`, `Save.swift`) into the Xcode
project navigator, into the `SaveIt` group. Check "Copy items if needed" is
**off** (they're already in the right place) and the SaveIt target is checked.

## 3. Add the Supabase Swift package

Xcode → **File → Add Package Dependencies** → paste:
```
https://github.com/supabase/supabase-swift
```
Add the **Supabase** product to the SaveIt target (this single product
includes Auth and Postgrest — no need to add sub-packages individually).

## 4. Fill in the publishable key

Supabase dashboard → **Project Settings → API** → copy the **`anon` /
`publishable`** key (NOT the secret key — that one's only in the backend's
`.env`, never in this app). Paste it into `SupabaseManager.swift`, replacing
`PASTE_PUBLISHABLE_KEY_HERE`.

## 5. Register the custom URL scheme

This is what lets the magic-link email bring you back into the app.

1. Select the SaveIt target → **Info** tab → **URL Types** → **+**.
2. URL Schemes: `saveit`. Identifier: anything, e.g. `com.saveit.auth`.

## 6. Allow-list the redirect URL in Supabase

Supabase dashboard → **Authentication → URL Configuration** → add
`saveit://login-callback` under **Redirect URLs**. Without this, Supabase
rejects the sign-in link as going to an unrecognized destination.

## 7. Run it

Build and run in Simulator (a real device isn't needed for this — Simulator
can open a magic-link email if you check it in Simulator's Safari/Mail, or
you can paste the link's URL directly into Simulator's Safari address bar to
trigger the same `saveit://` redirect).

Expected flow: sign-in screen → enter email → check email, tap the link →
app opens automatically → shows a 6-character code → DM that code to
`@saveit624` → within a few seconds the app switches to the saves list.
