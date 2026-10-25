# GAnime

A free anime web app powered by AniList. Discover anime, track your library and progress, follow the weekly release calendar, and continue watching across devices, with support for user-installed addons.

## What it does

- **Discover** — Browse trending and popular anime, with details, trailers, and recommendations from AniList.
- **Library and tracking** — Track what you are watching, with AniList, Simkl, and MyAnimeList (read-only) support.
- **Calendar** — See what is airing each day of the week.
- **Continue Watching** — Pick up where you left off, across episodes and sources.
- **Player** — In-browser playback with multi-audio and subtitle switching where the source supports it, AniSkip for openings and endings, and an 85% auto-mark for watched episodes. Heavy files that browsers cannot handle can be opened in an external player such as VLC or MPV.
- **Guest mode** — Use the app without an account. Your data stays on your device until you sign in.
- **Login** — Email and password sign-in with Firebase Auth (Phase 1). Cloud sync is planned as a separate phase.

## Addons and streams

GAnime does not host, bundle, list, or recommend stream sources. Streams come only from addons the user installs themselves. If a source is taken down, it is removed.

## Run it locally

```bash
python3 -m http.server 8080
```

Then open http://localhost:8080 in your browser.

Opening the files directly with `file://` is not recommended — the player and login work best over `http://localhost`.

## Credits

Built by **Isolated**.

Built with **Muse (Nounou)** — partner, builder, and verifier.

With **Gemini** — early phases and second-opinion analyst.

- **movi-player** by MrUjjwalG — the player engine.
- **AniList** — catalogue and tracking API.
- Inspired by **NuvioWeb**, the community build by falcononrails.

## Status

Always free.
