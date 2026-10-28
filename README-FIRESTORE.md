# GAnime Phase 2 — Cloud Sync (Firestore)

**Why this exists:** Phase 1 login only proved *who you are*. Your profiles,
watched episodes, library, settings and addons lived only in one browser.
Phase 2 puts those in one Firestore document per user (`users/{uid}`), so a
new browser downloads them instead of asking you to create a profile.

## What syncs / what never syncs

Syncs: profiles, per-profile settings, addons (full manifest URLs,
keys included, since 2026-10-28), watched episodes, local
library, My List, episode-design preference, active profile, and
tracking logins/tokens (AniList / Simkl / MAL, since 2026-10-28 —
newest conn per provider wins, disconnects propagate via
tombstones).

NEVER syncs:
- Firebase auth tokens (idToken / refreshToken): each device signs
  in separately with the Firebase password — that login IS the gate
  for the whole doc (owner-only Firestore rules), so syncing session
  tokens would gain nothing.
- Caches (episode data, ID map, home rails, title cache, TrackStore
  lists/outbox): re-fetchable or device-local in-flight state.

Note: before 2026-10-28, tracking tokens and key-bearing addon URLs
stayed local-only by design. Full sync was user-authorized on that
date after the tradeoff was spelled out: the doc is readable only by
the signed-in owner, so the protection is the Firebase password.

## How it works (code: `js/firestore.js`)

- Firestore REST, no SDK. Every request uses your Firebase idToken as a
  Bearer token (no apiKey in the request).
- Batched, event-driven only: a debounced push 8 seconds after the last
  local user-data write, a boot pull/merge after sign-in (awaited, max 5s,
  never blocks boot), and a manual **Sync Now** in Settings → Account.
  Never per second, never on a timer.
- Conflict rule: new browser with no profiles + cloud has profiles → pull
  all. Existing browser + empty cloud → push all. Both have data → merge
  per store (watched/library unioned by title, newer per-entry `updatedAt`
  wins; My List unioned; profiles/addons unioned by id, local wins on a
  same-id conflict; settings take the newer store timestamp, tracked in
  `ganime_sync_meta`; legacy stores with no timestamp keep local, so a
  merge never wipes the device you are holding). The merged doc is pushed
  back, so both devices converge.
- A failed sync never touches local data — the error shows in
  Settings → Account → Cloud Sync.

## One-time console steps (do these once, in order)

### Step 1 — Create the Firestore database
1. Open [Firebase Console](https://console.firebase.google.com) → project
   `ganime-1a0a1`.
2. Left menu → **Build → Firestore Database** → **Create database**.
3. **Start in production mode** (not test mode), then choose a location.
   Recommended: `asia-south1 (Mumbai)` if offered, otherwise the default.
   The location cannot be changed later.
4. Click **Create**. (Creating the database also enables the Firestore API.)

### Step 2 — Set the security rules
1. In Firestore Database → **Rules** tab, replace everything with:
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```
2. Click **Publish**. This means: each user can read/write ONLY their own
   document, nobody else can read or write anything.

### Step 3 — If you restricted the API key earlier (only if you did that step)
If you ever restricted the browser key to specific APIs, add **Firestore
API** to its allowed APIs, or sync will fail with a key error. If you never
restricted the key, skip this.

## Test it (after the code is live and Steps 1–2 are done)
1. On `ganime.pages.dev`, sign in, go to **Settings → Profile → Account**,
   tap **Sync Now**. It should say a cloud copy was created / already in sync.
2. Open a **different browser**, sign in with the same account. Your
   profiles should appear without asking you to create one.
3. On that second browser, mark an episode watched, wait ~10 seconds, then
   open the first browser and tap **Sync Now** — the watched episode
   should appear there.
4. Tracker logins now sync too (since 2026-10-28): the second
   browser should already be logged into the same trackers — no
   reconnect needed. A disconnect on either browser propagates to
   the other on the next sync.

## Rollback
Pre-Phase-2 copies of `app.js`, `storage.js` and `index.html` are kept in
`~/workspace/your_files/ganime-phase2/work-backup-pre-phase2/`, and the
previous live commit on GitHub (`d7a71dcf`) has no sync code. Deleting the
Firestore database in the console also stops all syncing instantly.
