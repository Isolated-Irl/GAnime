// ============================================================
// GAnime — player.js = VIDEO PLAYER (MOVI-ONLY TEST BUILD, 2026-10-25)
// This file is a TEST copy. It does NOT touch the original tree.
// The legacy player engine is gone here on purpose: every stream
// (HLS .m3u8, DASH .mpd, MP4, MKV) goes through one <movi-player>
// element, per movi docs (Shaka pipeline for .m3u8/.mpd,
// WebCodecs/WASM for MKV). movi's own UI is left untouched.
//
// ONLY GAnime additions on top of movi, per the locked UI:
//  (1) top-right bare logos, no circle backgrounds, no text:
//      external/redirect on the left, back on the right.
//  (2) AniSkip, dark-glass movi theme, NOT the old white pill.
//  (3) Episode + Source popups as GAnime overlays above movi,
//      also dark-glass. Tapping an item destroys movi and opens
//      that episode/source through the existing App logic.
//
// What movi's own menu already covers (do NOT rebuild it here):
//  Quality, Speed, Audio tracks, Subtitle tracks, Aspect.
//  Embedded MKV audio/subtitle switching is movi's job.
//
// Honest gaps in this build (see README, do not pretend otherwise):
//  - Addon subtitles are appended as <track> children. movi docs
//    prove <track> external subtitles for declared tracks; whether
//    movi picks up tracks appended AFTER load is UNPROVEN and must
//    be tested live. Stream-owned subtitles are declared before
//    src is set, so those are the safe path.
//  - TrueHD / DTS-HD MA sounding, HLS/DASH via movi, and addon
//    subtitle switching are UNPROVEN until Isolated tests them.
//    VLC/MPV via the top-left external icon stays the fallback.
//  - subtitleBold and subtitleOffset (px) from GAnime settings
//    have no movi equivalent and are NOT applied here.
//  - No code in this file may assume a <video> element exists:
//    movi paints to a canvas. All transport goes through the
//    movi element's HTMLMediaElement-parity properties.
// ============================================================
/* ------------------------------------------------------------
   2026-10-26 changes (player_2):
   1. Episodes + Sources popups now share ONE panel look and open /
      close with the same fade + lift as the rest of the player.
      Their colours, corner radius, shadow, accent and motion come
      from movi's own --movi-* theme variables, read live from the
      element (see _syncMoviTheme). If movi exposes nothing usable
      the dark-glass defaults below are used. The result is logged
      to the console as "[GAnime] movi theme sync".
   2. iPhone / iPad fullscreen. iOS Safari has NO element
      fullscreen for a <div> or <canvas>, and movi paints to a
      canvas, so auto-fullscreen could never fire. On iOS the
      overlay now goes "pseudo fullscreen" (fixed, full viewport,
      page scroll locked) automatically, and a one-time hint
      explains Add to Home Screen, the only way a website gets
      the browser bars hidden on iPhone.
   ------------------------------------------------------------ */
const Player = {
    movi: null,
    currentUrl: '',
    currentLabel: '',
    _streamObj: null,
    _streamSubs: [],
    _subChoice: { kind: 'off', id: null },
    _subManual: false,
    _subsLoading: false,
    _subsToken: 0,
    _skipIntervals: [],
    _autoSkippedKeys: null,
    _autoMarked: false,
    _rawUrl: '',
    _sourcesOpen: false,
    _srcFilter: 'all',
    _srcList: [],
    _srcPoll: null,
    _episodesOpen: false,
    _epRangeStart: 1,
    _tracksReadyDone: false,
    _tracksPoll: null,
    _aniskipFetched: false,
    _keyHandler: null,
    _moveHandler: null,
    _wheelHandler: null,
    _playHandler: null,
    _waitHandler: null,
    _idleTimer: null,
    _jumpingEp: false,
    _timeHandler: null,
    _endedHandler: null,
    _tracksHandler: null,
    _metaHandler: null,
    _errorHandler: null,

    _settings() {
        return (typeof Storage !== 'undefined' && Storage.getSettings()) || {};
    },

    _escLabel(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    _langCode(codeOrName) {
        const M = { english: 'en', eng: 'en', japanese: 'ja', jpn: 'ja', jp: 'ja', hindi: 'hi', hin: 'hi',
            spanish: 'es', spa: 'es', french: 'fr', fra: 'fr', fre: 'fr', german: 'de', deu: 'de', ger: 'de',
            italian: 'it', ita: 'it', portuguese: 'pt', por: 'pt', arabic: 'ar', ara: 'ar',
            korean: 'ko', kor: 'ko', chinese: 'zh', chi: 'zh', zho: 'zh', russian: 'ru', rus: 'ru',
            indonesian: 'id', ind: 'id', thai: 'th', tha: 'th', vietnamese: 'vi', vie: 'vi',
            turkish: 'tr', tur: 'tr', polish: 'pl', pol: 'pl', dutch: 'nl', nld: 'nl', dut: 'nl',
            malay: 'ms', msa: 'ms', may: 'ms', bengali: 'bn', ben: 'bn', tamil: 'ta', tam: 'ta', telugu: 'te', tel: 'te' };
        const k = String(codeOrName || '').trim().toLowerCase();
        if (M[k]) return M[k];
        if (k.length >= 2) return k.slice(0, 2);
        return '';
    },

    _langName(code) {
        const M = { eng: 'English', en: 'English', jpn: 'Japanese', ja: 'Japanese', jp: 'Japanese', hin: 'Hindi', hi: 'Hindi',
            spa: 'Spanish', es: 'Spanish', fre: 'French', fra: 'French', fr: 'French', ger: 'German', deu: 'German', de: 'German',
            ita: 'Italian', it: 'Italian', por: 'Portuguese', pt: 'Portuguese', pob: 'Portuguese (BR)', 'pt-br': 'Portuguese (BR)',
            ara: 'Arabic', ar: 'Arabic', kor: 'Korean', ko: 'Korean', chi: 'Chinese', zho: 'Chinese', zh: 'Chinese',
            rus: 'Russian', ru: 'Russian', ind: 'Indonesian', id: 'Indonesian', tha: 'Thai', th: 'Thai', vie: 'Vietnamese', vi: 'Vietnamese',
            tur: 'Turkish', tr: 'Turkish', pol: 'Polish', pl: 'Polish', dut: 'Dutch', nld: 'Dutch', nl: 'Dutch',
            may: 'Malay', msa: 'Malay', ms: 'Malay', ben: 'Bengali', bn: 'Bengali', tam: 'Tamil', ta: 'Tamil', tel: 'Telugu', te: 'Telugu' };
        const k = String(code || '').trim().toLowerCase();
        return M[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : 'Subtitle');
    },

    ensureStyles() {
        if (document.getElementById('ganimeMoviStyles')) return;
        const st = document.createElement('style');
        st.id = 'ganimeMoviStyles';
        st.textContent = `
            #playerOverlay { overscroll-behavior: none !important; overscroll-behavior-x: none !important; touch-action: none; }
            #moviContainer { position: absolute; inset: 0; background: #000; overscroll-behavior: none !important; overscroll-behavior-x: none !important; touch-action: none; }
            #moviContainer movi-player { width: 100%; height: 100%; display: block; background: #000; touch-action: none; }
            /* Top overlay: bare logos ONLY. No background, no border,
               no circle, no text label — per the locked UI. */
            .gp-movi-top { position: absolute; top: 0; left: 0; right: 0; z-index: 60;
                display: flex; justify-content: flex-end; align-items: center; gap: 18px; padding: 14px 18px;
                pointer-events: none; opacity: 1; transition: opacity 0.28s cubic-bezier(0.4, 0, 0.2, 1); }
            .gp-movi-top.gp-idle { opacity: 0; pointer-events: none; }
            .gp-movi-top.gp-idle button { pointer-events: none; }
            .gp-movi-top button { pointer-events: auto; background: transparent; border: none;
                box-shadow: none; color: #fff; cursor: pointer;
                display: flex; align-items: center; justify-content: center;
                padding: 4px; opacity: 0.9; transition: opacity 0.15s ease, transform 0.15s ease; }
            .gp-movi-top button:hover { opacity: 1; transform: scale(1.08); }
            /* SVG icons need their own shadow: text-shadow does not
               apply to SVG strokes, so use drop-shadow to stay visible
               on bright video scenes. */
            .gp-movi-top button svg { filter: drop-shadow(0 2px 8px rgba(0,0,0,0.9)); display: block; }
            /* Centre seek controls (2026-10-25): like all players —
               left = back, centre = pause/play, right = forward.
               They fade WITH the top icons: when .gp-movi-top goes
               idle, the sibling centre cluster fades too. */
            #gpSeekCenter { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 60;
                display: flex; align-items: center; gap: 28px; pointer-events: none;
                opacity: 1; transition: opacity 0.28s cubic-bezier(0.4, 0, 0.2, 1); }
            .gp-movi-top.gp-idle ~ #gpSeekCenter { opacity: 0; pointer-events: none; }
            .gp-movi-top.gp-idle ~ #aniskipBtn { opacity: 0; pointer-events: none; }
            #aniskipBtn { transition: opacity 0.28s cubic-bezier(0.4, 0, 0.2, 1); }
            /* Loading phase: hide OUR centre cluster until the video actually
               plays, so movi's own loading spinner sits alone in the centre
               instead of stacking under our pause button. Removed on first play. */
            #playerOverlay.gp-seek-hidden #gpSeekCenter { opacity: 0 !important; pointer-events: none !important; }
            /* Mid-stream buffering: hide centre too, so movi's spinner never
               stacks under our pause icon. Removed on playing-with-frame. */
            #playerOverlay.gp-buffering #gpSeekCenter { opacity: 0 !important; pointer-events: none !important; visibility: hidden !important; }
            /* No circle: bare icons/text only, like the top cluster, bigger.
               Centre icons are inline SVG (2026-10-26, iOS fix): the old
               text glyphs (↩ ⏸ ↪) render as blue emoji on iOS, which
               clashed with movi's monochrome theme. SVG cannot be
               emoji-fied, so the cluster now matches movi on every
               platform. text-shadow stays for the "5s" labels only;
               SVGs get the same drop-shadow as the top icons. */
            #gpSeekCenter button { pointer-events: auto; background: transparent; color: #fff;
                border: none; cursor: pointer; font-weight: 800;
                display: flex; align-items: center; justify-content: center; gap: 6px;
                width: auto; height: auto; padding: 8px 10px; font-size: 18px;
                text-shadow: 0 2px 8px rgba(0,0,0,0.9); }
            #gpSeekCenter button svg { filter: drop-shadow(0 2px 8px rgba(0,0,0,0.9)); display: block; flex: none; }
            #gpSeekCenter button:hover { background: transparent; transform: scale(1.12); }
            #gpSeekCenter button.gp-seek-play { font-size: 32px; padding: 8px 14px; }
            /* Last-resort fullscreen (no native element fullscreen and
               no video fullscreen API — e.g. an exotic iOS browser):
               at least stack the already-fixed overlay above all else. */
            #playerOverlay.gp-pseudo-fs { z-index: 9999 !important; }
            /* Episode/Source triggers: MOVED 2026-10-25 at Isolated's order.
               They used to be dark-glass pills above movi's bottom bar.
               Now they are bare icons in the top cluster, same style as
               redirect/back (no background, no circle, no visible text).
               Order left to right: Episodes, Sources, Redirect, Back.
               Redirect stays immediately left of Back, as before. */
            /* AniSkip: dark-glass movi theme, NOT the old white pill. */
            #aniskipBtn { position: absolute; bottom: 92px; right: 20px; z-index: 60;
                background: rgba(14,14,19,0.78); color: #fff; border: 1px solid rgba(255,255,255,0.18);
                font-weight: 800; padding: 10px 18px; border-radius: 10px; cursor: pointer;
                font-size: 13px; box-shadow: 0 6px 20px rgba(0,0,0,0.55);
                backdrop-filter: blur(12px); display: none; }
            #playerMsg { position: absolute; left: 50%; transform: translateX(-50%); bottom: 150px; z-index: 61;
                max-width: 92vw; background: rgba(14,14,19,0.92); border: 1px solid rgba(255,255,255,0.16);
                border-radius: 14px; padding: 14px 16px; color: #fff; font-size: 13px; line-height: 1.5;
                box-shadow: 0 18px 50px rgba(0,0,0,0.6); }
            #playerMsg.hidden { display: none; }
            #playerMsg .btn-primary, #playerMsg .btn-secondary { margin: 8px 6px 0 0; }
            /* Episode + Source popups: dark-glass overlays above movi. */
            .gp-movi-pop { position: absolute; left: 50%; transform: translateX(-50%); bottom: 110px; z-index: 70;
                width: 360px; max-width: 92vw; max-height: 62vh; overflow-y: auto;
                background: rgba(18,19,24,0.97); border: 1px solid rgba(255,255,255,0.14);
                border-radius: 14px; padding: 12px; display: none; box-shadow: 0 18px 50px rgba(0,0,0,0.6); }
            .gp-movi-pop.open { display: block; }
            .gp-movi-head { display: flex; align-items: center; justify-content: space-between;
                margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.12); }
            .gp-movi-title { font-size: 13.5px; font-weight: 800; color: #fff; }
            .gp-movi-close { background: rgba(255,255,255,0.1); border: none; color: #fff; width: 26px; height: 26px;
                border-radius: 50%; cursor: pointer; font-size: 12px; font-weight: 800; }
            .gp-movi-row { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
                background: transparent; border: 1px solid transparent; color: #fff;
                padding: 8px 10px; border-radius: 9px; font-size: 13px; font-weight: 600; cursor: pointer; }
            .gp-movi-row:hover { background: rgba(255,255,255,0.08); }
            .gp-movi-row.active { border-color: var(--accent); background: rgba(255,255,255,0.06); }
            .gp-movi-row .gp-tag { margin-left: auto; font-size: 11px; color: #4ade80; font-weight: 700; white-space: nowrap; }
            .gp-movi-chips { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
            .gp-movi-chip { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15); color: #fff;
                font-size: 11.5px; font-weight: 700; padding: 5px 10px; border-radius: 8px; cursor: pointer; }
            .gp-movi-chip.active { background: var(--accent); color: var(--on-accent, #101418); border-color: var(--accent); }
            .gp-movi-sec { font-size: 11px; font-weight: 800; letter-spacing: 1.2px; color: #9a9aa5; margin: 8px 2px 6px; }
            .gp-movi-note { font-size: 12px; line-height: 1.5; color: #b7b7c2; padding: 8px 10px; }
            .gp-movi-note b { color: #fff; }
            .gp-src-back { position: absolute; inset: 0; z-index: 70; background: rgba(0,0,0,0.5); display: none; align-items: center; justify-content: center; }
            .gp-src-back.open { display: flex; }
            .gp-src { width: min(620px, 94vw); max-height: 82vh; display: flex; flex-direction: column; background: rgba(18,30,30,0.98);
                border: 1px solid rgba(255,255,255,0.12); border-radius: 22px; padding: 16px; box-shadow: 0 24px 70px rgba(0,0,0,0.65); }
            .gp-src-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
            .gp-src-title { font-size: 20px; font-weight: 800; flex: 1; color: #fff; }
            .gp-src-btn { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #fff; font-weight: 700; font-size: 13px; padding: 8px 14px; border-radius: 12px; cursor: pointer; }
            .gp-src-btn:hover { background: rgba(255,255,255,0.16); }
            .gp-src-chips { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 10px; flex-shrink: 0; }
            .gp-src-chip { white-space: nowrap; background: rgba(255,255,255,0.07); border: 1.5px solid transparent; color: #e8eeee; font-weight: 700; font-size: 13px; padding: 9px 16px; border-radius: 999px; cursor: pointer; }
            .gp-src-chip.active { border-color: var(--accent); background: rgba(255,255,255,0.16); }
            .gp-src-list { overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
            .gp-src-card { text-align: left; background: rgba(255,255,255,0.05); border: 1.5px solid transparent; border-radius: 16px; padding: 12px 14px; color: #fff; cursor: pointer; }
            .gp-src-card:hover { background: rgba(255,255,255,0.1); }
            .gp-src-card.current { border-color: var(--accent); }
            .gp-src-name { font-weight: 800; font-size: 15px; white-space: pre-line; }
            .gp-src-desc { font-size: 12px; color: #c7d0d0; white-space: pre-line; margin-top: 4px; line-height: 1.45; word-break: break-word; }
            .gp-src-addon { font-size: 11px; color: #8fa6a6; margin-top: 6px; }
            .gp-src-badge { display: inline-block; font-size: 11px; font-weight: 800; margin-top: 6px; }
            .gp-src-badge.ok { color: #4ade80; }
            .gp-src-badge.warn { color: #fbbf24; }
            .gp-src-empty { color: #9fb0b0; font-size: 13px; padding: 14px 6px; }

            /* ===== 2026-10-26: one shared panel language, movi-themed ===== */
            #playerOverlay { --gp-bg: rgba(18,19,24,0.97); --gp-border: rgba(255,255,255,0.14); --gp-radius: 14px;
                --gp-shadow: 0 18px 50px rgba(0,0,0,0.6); --gp-dur: 0.22s; --gp-ease: cubic-bezier(0.4, 0, 0.2, 1);
                --gp-accent: var(--accent, #fff); --gp-on-accent: var(--on-accent, #101418);
                --gp-muted: #9a9aa5; --gp-hover: rgba(255,255,255,0.08); }
            .gp-movi-pop, .gp-src { background: var(--gp-bg); border: 1px solid var(--gp-border); border-radius: var(--gp-radius);
                box-shadow: var(--gp-shadow); -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); }
            /* Open / close = fade + small lift, never display:none snapping. */
            .gp-movi-pop { display: block; visibility: hidden; opacity: 0; pointer-events: none;
                transform: translateX(-50%) translateY(10px) scale(0.98); transform-origin: 50% 100%;
                transition: opacity var(--gp-dur) var(--gp-ease), transform var(--gp-dur) var(--gp-ease), visibility 0s linear var(--gp-dur); }
            .gp-movi-pop.open { visibility: visible; opacity: 1; pointer-events: auto;
                transform: translateX(-50%) translateY(0) scale(1); transition-delay: 0s; }
            .gp-src-back { display: flex; visibility: hidden; opacity: 0; pointer-events: none; background: rgba(0,0,0,0.42);
                transition: opacity var(--gp-dur) var(--gp-ease), visibility 0s linear var(--gp-dur); }
            .gp-src-back.open { visibility: visible; opacity: 1; pointer-events: auto; transition-delay: 0s; }
            .gp-src { width: min(520px, 94vw); max-height: 78vh; padding: 12px;
                transform: translateY(12px) scale(0.98); transition: transform var(--gp-dur) var(--gp-ease); }
            .gp-src-back.open .gp-src { transform: none; }
            .gp-src-head { margin-bottom: 10px; padding-bottom: 8px; border-bottom: 1px solid rgba(255,255,255,0.12); }
            .gp-src-title { font-size: 13.5px; font-weight: 800; }
            .gp-src-btn { background: rgba(255,255,255,0.1); border: none; border-radius: 9px; font-size: 12px; padding: 6px 12px; }
            .gp-src-btn:hover { background: rgba(255,255,255,0.18); }
            .gp-src-chips { gap: 6px; flex-wrap: wrap; overflow: visible; padding-bottom: 10px; }
            .gp-src-chip { font-size: 11.5px; padding: 5px 10px; border-radius: 8px; background: rgba(255,255,255,0.08);
                border: 1px solid rgba(255,255,255,0.15); color: #fff; }
            .gp-src-chip.active, .gp-movi-chip.active { background: var(--gp-accent); color: var(--gp-on-accent); border-color: var(--gp-accent); }
            .gp-src-list { gap: 4px; }
            .gp-src-card { background: transparent; border: 1px solid transparent; border-radius: 9px; padding: 8px 10px; }
            .gp-src-card:hover { background: var(--gp-hover); }
            .gp-src-card.current, .gp-movi-row.active { border-color: var(--gp-accent); background: rgba(255,255,255,0.06); }
            .gp-src-name { font-size: 13px; font-weight: 700; }
            .gp-src-desc, .gp-src-addon, .gp-src-empty { color: var(--gp-muted); }
            .gp-src-desc { font-size: 11.5px; }
            .gp-movi-sec { color: var(--gp-muted); }
            #aniskipBtn { background: var(--gp-bg); border-color: var(--gp-border); box-shadow: var(--gp-shadow);
                border-radius: calc(var(--gp-radius) - 4px); animation: gpPopFade var(--gp-dur) var(--gp-ease); }
            #playerMsg { background: var(--gp-bg); border-color: var(--gp-border); box-shadow: var(--gp-shadow);
                border-radius: var(--gp-radius); }
            #playerMsg:not(.hidden) { animation: gpPopFadeMsg var(--gp-dur) var(--gp-ease); }
            @keyframes gpPopFade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
            @keyframes gpPopFadeMsg { from { opacity: 0; transform: translateX(-50%) translateY(6px); } to { opacity: 1; transform: translateX(-50%); } }
            @media (prefers-reduced-motion: reduce) {
                .gp-movi-pop, .gp-src-back, .gp-src { transition: none !important; }
                #aniskipBtn, #playerMsg:not(.hidden) { animation: none !important; }
            }

            /* ===== iOS pseudo fullscreen ===== */
            #playerOverlay.gp-pseudo-fs { position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
                width: 100% !important; height: 100vh !important; height: -webkit-fill-available !important; height: 100dvh !important; z-index: 9999 !important; }
            html.gp-pfs-lock, html.gp-pfs-lock body { overflow: hidden !important; overscroll-behavior: none !important; }
            .gp-movi-top { padding-top: calc(14px + env(safe-area-inset-top, 0px)); padding-right: calc(18px + env(safe-area-inset-right, 0px)); }
            #aniskipBtn { right: calc(20px + env(safe-area-inset-right, 0px)); }
        `;
        document.head.appendChild(st);
    },

    _showMsg(html, autoHideMs) {
        const msg = document.getElementById('playerMsg');
        if (!msg) return;
        msg.innerHTML = html;
        msg.classList.remove('hidden');
        clearTimeout(this._msgTimer);
        if (autoHideMs) {
            this._msgTimer = setTimeout(() => { const m = document.getElementById('playerMsg'); if (m) m.classList.add('hidden'); }, autoHideMs);
        }
    },

    _hideMsg() {
        const msg = document.getElementById('playerMsg');
        if (msg) msg.classList.add('hidden');
    },

    /* Idle-hide for the top cluster (Fix 1, 2026-10-25 final).
       Fades after 2.8s idle while playing only; never hides while
       paused or while a popup is open. The popup check happens at
       TIMER-FIRE time, not just when the timer is set, so a popup
       opened mid-countdown suppresses the hide. Wake on mouse,
       touch (pointerdown) and key (key handler calls this). */
    _wakeTopBar() {
        const top = document.querySelector('#playerOverlay .gp-movi-top');
        if (!top) return;
        top.classList.remove('gp-idle');
        clearTimeout(this._idleTimer);
        if (this._sourcesOpen || this._episodesOpen) return;
        this._idleTimer = setTimeout(() => {
            if (this._sourcesOpen || this._episodesOpen) return;
            /* BUGFIX 2026-10-25 (live, Isolated's photo): the old code
               just returned here if movi was paused/loading, and the
               timer was dead forever — nothing re-armed it when play
               actually started, so the top bar stuck while movi's own
               bar faded. Now: re-arm instead of giving up. */
            if (this.movi && this.movi.paused) { this._wakeTopBar(); return; }
            top.classList.add('gp-idle');
        }, 3000);
    },

    /* Seek interval (2026-10-25): Settings → Playback → Seek Interval,
       seconds. Read fresh each time so a settings change applies on
       the next open without a code change. Default 5. */
    _seekInterval() {
        const v = Math.round(Number(this._settings().seekInterval) || 5);
        return Math.max(1, Math.min(60, v));
    },

    /* Centre-cluster icons (2026-10-26, iOS fix): inline SVG, never
       text glyphs — iOS renders ↩ ↪ ⏸ as blue emoji, breaking the
       movi monochrome theme. Bare strokes, currentColor, same
       drop-shadow treatment as the top icons. */
    _svgSeekBack() {
        return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>';
    },
    _svgSeekFwd() {
        return '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.13-9.36L23 10"></path></svg>';
    },
    _svgPlay() {
        return '<svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor" stroke="none"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';
    },
    _svgPause() {
        return '<svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>';
    },
    _svgExpand() {
        return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>';
    },
    _svgCompress() {
        return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"></path><path d="M21 8h-3a2 2 0 0 1-2-2V3"></path><path d="M3 16h3a2 2 0 0 1 2 2v3"></path><path d="M16 21v-3a2 2 0 0 1 2-2h3"></path></svg>';
    },

    _updateSeekPlayBtn() {
        const btn = document.getElementById('gpSeekPlay');
        if (!btn) return;
        btn.innerHTML = (this.movi && this.movi.paused) ? this._svgPlay() : this._svgPause();
    },

    /* ---------- iOS fullscreen (2026-10-26) ----------
       iOS browsers (all WKWebView) do NOT support element
       fullscreen: overlay.requestFullscreen is undefined and
       webkitRequestFullscreen on a div does nothing — so our
       auto-fullscreen and movi's own fullscreen button both fail
       silently there. The one path Apple allows is the VIDEO
       element's webkitEnterFullscreen (true native fullscreen,
       with Apple's own controls while active). movi's shadowRoot
       is reachable (same pattern as setAspect), so the video
       element can be found. This must run inside a tap (Apple
       requires a user gesture), which is why it lives on our own
       top-row button — auto-fullscreen on open cannot be
       gesture-synced with a video element created later. */
    _nativeFsAvailable(overlay) {
        try {
            return !!(overlay && (overlay.requestFullscreen || overlay.webkitRequestFullscreen));
        } catch (e) { return false; }
    },
    _moviVideo() {
        try {
            const mp = this.movi;
            if (!mp) return null;
            if (mp.shadowRoot) {
                const v = mp.shadowRoot.querySelector('video');
                if (v) return v;
            }
            return mp.querySelector('video')
                || document.querySelector('#moviContainer video')
                || null;
        } catch (e) { return null; }
    },
    _toggleVideoFullscreen() {
        const overlay = document.getElementById('playerOverlay');
        const video = this._moviVideo();
        if (video && video.webkitEnterFullscreen) {
            try {
                if (video.webkitDisplayingFullscreen && video.webkitExitFullscreen) video.webkitExitFullscreen();
                else video.webkitEnterFullscreen();
            } catch (e) {}
            return true;
        }
        /* No <video> to fullscreen (movi paints to a canvas): use
           pseudo fullscreen, which also locks page scroll. */
        if (overlay) this._setPseudoFs(!overlay.classList.contains('gp-pseudo-fs'));
        return true;
    },

    _isIOS() {
        try {
            const ua = navigator.userAgent || '';
            return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
        } catch (e) { return false; }
    },

    _isStandalone() {
        try {
            return navigator.standalone === true || !!(window.matchMedia && (matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: fullscreen)').matches));
        } catch (e) { return false; }
    },

    /* "Pseudo" fullscreen: the overlay fills the whole visible
       viewport and the page behind cannot scroll. This is the most
       a website can do on iPhone Safari, which has no Fullscreen
       API for a div or a canvas (movi renders to a canvas). */
    _setPseudoFs(on) {
        const overlay = document.getElementById('playerOverlay');
        if (overlay) overlay.classList.toggle('gp-pseudo-fs', !!on);
        try { document.documentElement.classList.toggle('gp-pfs-lock', !!on); } catch (e) {}
        const btn = document.getElementById('gpFsBtn');
        if (btn) btn.innerHTML = on ? this._svgCompress() : this._svgExpand();
    },

    /* One-time hint: Safari cannot hide its own toolbar for a
       website; an installed Home Screen app has no toolbar at all. */
    _maybeShowIosHint() {
        let seen = false;
        try { seen = localStorage.getItem('ganime_ios_fs_hint_v1') === '1'; } catch (e) {}
        if (seen) return;
        setTimeout(() => {
            if (!document.getElementById('playerMsg') || !this.currentUrl) return;
            this._showMsg('<b>Want true fullscreen on iPhone?</b><br>Safari does not let websites hide its toolbar. '
                + 'Tap <b>Share → Add to Home Screen</b>, then open GAnime from that icon.<br>'
                + '<button class="btn-primary" onclick="Player._dismissIosHint()">Got it</button>');
        }, 1600);
    },

    _dismissIosHint() {
        try { localStorage.setItem('ganime_ios_fs_hint_v1', '1'); } catch (e) {}
        this._hideMsg();
    },

    /* ---------- movi theme sync ----------
       movi is themed through --movi-* CSS custom properties. Their
       names are not documented to us, so they are discovered live
       from the element's own stylesheets, then only SANE values are
       taken (dark panel colour, 6-24px radius, 100-500ms motion).
       Anything missing keeps the dark-glass defaults. */
    _moviVarNames(el) {
        const names = new Set();
        const add = (txt) => { (String(txt || '').match(/--movi-[a-z0-9-]+/gi) || []).forEach(n => names.add(n)); };
        const scan = (sheet) => { try { for (const r of sheet.cssRules) add(r.cssText); } catch (e) {} };
        try {
            const root = el.shadowRoot;
            if (root) {
                for (const s of (root.styleSheets || [])) scan(s);
                for (const s of (root.adoptedStyleSheets || [])) scan(s);
                root.querySelectorAll('style').forEach(s => add(s.textContent));
            }
        } catch (e) {}
        try { for (const s of document.styleSheets) scan(s); } catch (e) {}
        return Array.from(names);
    },

    _syncMoviTheme() {
        const ov = document.getElementById('playerOverlay');
        const el = this.movi;
        if (!ov || !el) return;
        let names = [];
        try { names = this._moviVarNames(el); } catch (e) {}
        if (!names.length) { this._themeInfo = { found: 0 }; return; }
        const cs = getComputedStyle(el);
        const read = (n) => cs.getPropertyValue(n).trim();
        const toRgba = (v) => {
            if (!v || !(window.CSS && CSS.supports && CSS.supports('color', v))) return null;
            const c = document.createElement('canvas').getContext('2d');
            c.fillStyle = '#010203';
            c.fillStyle = v;
            const s = c.fillStyle;
            let m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
            if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16), 1];
            m = /^rgba?\(([^)]+)\)$/.exec(s);
            if (m) { const p = m[1].split(',').map(parseFloat); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; }
            return null;
        };
        const lum = (c) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
        const colour = (patterns, ok, skip) => {
            for (const re of patterns) {
                for (const n of names) {
                    if (!re.test(n) || (skip && skip.test(n))) continue;
                    const v = read(n);
                    const c = toRgba(v);
                    if (c && (!ok || ok(c))) return { value: v, rgba: c };
                }
            }
            return null;
        };
        const PANEL = '(menu|panel|popup|popover|settings|surface|dropdown)';
        const bg = colour([new RegExp(PANEL + '.*(bg|background)', 'i'), new RegExp('(bg|background).*' + PANEL, 'i'), /^--movi-(bg|background)$/i],
            c => lum(c) < 0.4 && c[3] >= 0.5);
        const border = colour([new RegExp(PANEL + '.*border', 'i'), /border/i], null);
        const accent = colour([/^--movi-(accent|primary|theme|brand)(-color)?$/i, /accent|primary/i], c => c[3] > 0.5,
            /(bg|background|hover|text|fg|contrast|shadow|glow|rgb)/i);
        let radius = null;
        for (const re of [new RegExp(PANEL + '.*radius', 'i'), /radius.*(menu|panel|popup)/i, /radius(-(md|medium|lg|large|base|default))?$/i]) {
            for (const n of names) {
                if (!re.test(n)) continue;
                const m = /^([\d.]+)px$/.exec(read(n));
                if (m && +m[1] >= 6 && +m[1] <= 24) { radius = m[0]; break; }
            }
            if (radius) break;
        }
        let shadow = null;
        for (const n of names) {
            if (!new RegExp(PANEL + '.*shadow', 'i').test(n)) continue;
            const v = read(n);
            if (v && /px/.test(v) && !/^none/.test(v)) { shadow = v; break; }
        }
        let dur = null, ease = null;
        for (const n of names) {
            if (!/(duration|transition|motion)/i.test(n)) continue;
            const v = read(n);
            const t = /(\d*\.?\d+)(ms|s)\b/.exec(v);
            if (t && !dur) {
                const ms = t[2] === 's' ? parseFloat(t[1]) * 1000 : parseFloat(t[1]);
                if (ms >= 100 && ms <= 500) dur = Math.round(ms) + 'ms';
            }
            const e = /(cubic-bezier\([^)]*\)|ease-in-out|ease-out|ease-in|ease|linear)/.exec(v);
            if (e && !ease) ease = e[1];
        }
        for (const n of names) {
            if (ease || !/(ease|easing|curve)/i.test(n)) continue;
            const v = read(n);
            if (v && window.CSS && CSS.supports && CSS.supports('transition-timing-function', v)) ease = v;
        }
        const set = (k, v) => { if (v) ov.style.setProperty(k, v); };
        set('--gp-bg', bg && bg.value);
        set('--gp-border', border && border.value);
        if (accent) {
            set('--gp-accent', accent.value);
            set('--gp-on-accent', lum(accent.rgba) > 0.55 ? '#101418' : '#ffffff');
        }
        set('--gp-radius', radius);
        set('--gp-shadow', shadow);
        set('--gp-dur', dur);
        set('--gp-ease', ease);
        this._themeInfo = { found: names.length, names: names, applied: { bg: bg && bg.value, border: border && border.value, accent: accent && accent.value, radius, shadow, dur, ease } };
        try { console.info('[GAnime] movi theme sync', this._themeInfo); } catch (e) {}
    },

    /* AniSkip: community OP/ED timestamps, keyed by MAL ID.
       duration must be the REAL movi duration. If it is unknown,
       return [] — never fall back to a hardcoded length, because
       a wrong episodeLength can return wrong skip intervals. */
    async fetchAniSkip(malId, episode, duration) {
        if (!malId || !episode || !duration || duration <= 0) return [];
        try {
            const s = this._settings();
            const len = Math.round(duration);
            const types = ['op', 'mixed-op', 'ed', 'mixed-ed'];
            if (s.aniskipRecap !== false) types.push('recap');
            const url = 'https://api.aniskip.com/v2/skip-times/' + malId + '/' + episode +
                '?' + types.map(t => 'types[]=' + t).join('&') + '&episodeLength=' + len;
            const r = await fetch(url);
            if (!r.ok) return [];
            const j = await r.json();
            const names = { op: 'Skip Intro', 'mixed-op': 'Skip Intro', ed: 'Skip Outro', 'mixed-ed': 'Skip Outro', recap: 'Skip Recap' };
            const kinds = { op: 'op', 'mixed-op': 'op', ed: 'ed', 'mixed-ed': 'ed', recap: 'recap' };
            return ((j && j.results) || []).map(item => ({
                kind: kinds[item.skipType] || 'op',
                type: names[item.skipType] || 'Skip',
                start: item.interval.startTime,
                end: item.interval.endTime
            })).filter(x => isFinite(x.start) && isFinite(x.end) && x.end > x.start);
        } catch (e) {
            return [];
        }
    },

    async open(url, label, streamObj) {
        if (!url || !/^https?:\/\//i.test(url)) return;
        this._scrollY = window.scrollY;
        this.currentUrl = url;
        this.currentLabel = label || 'Stream';
        const overlay = document.getElementById('playerOverlay');
        if (!overlay) return;
        /* Layout Phase 4: returning to the app (tab switch, app
           switch) while the player is open can leave the fixed
           layers misplaced the same way a close can — run the
           same reset. Registered once; the currentUrl guard
           makes it a no-op once the player is closed. */
        if (!this._visHandler) {
            this._visHandler = () => { if (!document.hidden && this.currentUrl) this._restoreLayout(); };
            document.addEventListener('visibilitychange', this._visHandler);
        }
        const settings = this._settings();

        /* Sync auto-fullscreen FIRST, before any await, while the
           click gesture from App.playStreamAt is still alive. */
        overlay.classList.remove('hidden');
        overlay.classList.toggle('gp-noload', settings.loadingOverlay === false);
        this._sourcesOpen = false;
        this._episodesOpen = false;
        clearInterval(this._srcPoll);
        if (settings.autoFullscreen !== false && !document.fullscreenElement && !document.webkitFullscreenElement) {
            try {
                const fp = overlay.requestFullscreen ? overlay.requestFullscreen() : (overlay.webkitRequestFullscreen ? overlay.webkitRequestFullscreen() : null);
                if (fp && fp.catch) fp.catch(() => {});
            } catch (e) {}
            if (!this._nativeFsAvailable(overlay)) {
                /* iPhone: no element fullscreen exists at all. */
                this._setPseudoFs(true);
            } else if (this._isIOS()) {
                /* iPad: the API exists but may silently refuse. */
                setTimeout(() => {
                    if (!document.fullscreenElement && !document.webkitFullscreenElement && this.currentUrl === url) this._setPseudoFs(true);
                }, 450);
            }
            if (this._isIOS() && !this._isStandalone()) this._maybeShowIosHint();
        }

        this.ensureStyles();
        const _iv = this._seekInterval();
        const st = (typeof App !== 'undefined' && App.streamsState) || {};
        const t = st.titleId && typeof App !== 'undefined' ? App.titleById(st.titleId) : null;
        const ep = st.episode || 0;
        const nameLines = ((streamObj && streamObj.name) || '').split('\n');
        const addonName = (nameLines[0] || '').trim();
        const quality = (nameLines[1] || '').trim() || ((/(2160|1440|1080|720|480)p/i.exec(url) || [])[0] || '');
        const subParts = [];
        if (quality) subParts.push(quality);
        if (addonName) subParts.push(addonName);
        if (t && t.type !== 'Movie' && ep) subParts.push('S1 · E' + ep);

        /* Fullscreen button: ONLY when element fullscreen is
           unavailable (iOS WKWebView) — elsewhere movi's own
           fullscreen button works, so the row stays at 4 icons.
           Placed leftmost so the existing Episodes → Sources →
           External → Back order (and External-left-of-Back) is
           untouched. It fades with the row via gp-idle, like the
           other top buttons. */
        const showFsBtn = !this._nativeFsAvailable(overlay);
        overlay.innerHTML = `
            <div id="moviContainer"></div>
            <div class="gp-movi-top">
                ${showFsBtn ? `<button id="gpFsBtn" title="Fullscreen">${overlay.classList.contains('gp-pseudo-fs') ? this._svgCompress() : this._svgExpand()}</button>` : ''}
                <button id="gpMoviEpBtn" title="Episodes (E)"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><circle cx="4" cy="6" r="1.5" fill="currentColor"></circle><circle cx="4" cy="12" r="1.5" fill="currentColor"></circle><circle cx="4" cy="18" r="1.5" fill="currentColor"></circle></svg></button>
                <button id="gpMoviSrcBtn" title="Sources (S)"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg></button>
                <button id="gpExt" title="Open in MPV / VLC (.m3u)"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></button>
                <button id="gpBack" title="Back"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></button>
            </div>
            <div id="gpSeekCenter">
                <button id="gpSeekBack" title="Back">${this._svgSeekBack()}<span>${_iv}s</span></button>
                <button id="gpSeekPlay" class="gp-seek-play" title="Play / Pause">${this._svgPause()}</button>
                <button id="gpSeekFwd" title="Forward"><span>${_iv}s</span>${this._svgSeekFwd()}</button>
            </div>
            <button id="aniskipBtn"></button>
            <div id="playerMsg" class="player-msg hidden"></div>
            <div class="gp-movi-pop" id="gpMoviEp"></div>
            <div class="gp-src-back" id="gpSrcBack"></div>`;
        if (document.getElementById('gpFsBtn')) document.getElementById('gpFsBtn').addEventListener('click', () => { this._toggleVideoFullscreen(); this._wakeTopBar(); });
        if (document.getElementById('gpBack')) document.getElementById('gpBack').addEventListener('click', () => this.close());
        if (document.getElementById('gpExt')) document.getElementById('gpExt').addEventListener('click', () => this.openInM3U());
        if (document.getElementById('gpMoviEpBtn')) document.getElementById('gpMoviEpBtn').addEventListener('click', () => this.toggleEpisodes());
        if (document.getElementById('gpMoviSrcBtn')) document.getElementById('gpMoviSrcBtn').addEventListener('click', () => this.toggleSources());
        if (document.getElementById('gpSeekBack')) document.getElementById('gpSeekBack').addEventListener('click', () => { this.seekBy(-this._seekInterval()); this._wakeTopBar(); });
        if (document.getElementById('gpSeekFwd')) document.getElementById('gpSeekFwd').addEventListener('click', () => { this.seekBy(this._seekInterval()); this._wakeTopBar(); });
        if (document.getElementById('gpSeekPlay')) document.getElementById('gpSeekPlay').addEventListener('click', () => { this.togglePlay(); this._wakeTopBar(); });

        if (this._keyHandler) document.removeEventListener('keydown', this._keyHandler);
        this._keyHandler = (ev) => {
            const ov = document.getElementById('playerOverlay');
            if (!ov || ov.classList.contains('hidden')) return;
            if (ev.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(ev.target.tagName)) return;
            this._wakeTopBar();
            const k = ev.key;
            if (k === 'Escape') {
                if (this._sourcesOpen) { ev.preventDefault(); this.closeSources(); }
                else if (this._episodesOpen) { ev.preventDefault(); this.closeEpisodes(); }
                else if (!document.fullscreenElement) { ev.preventDefault(); this.close(); }
            } else if (k === ' ' || k === 'k' || k === 'K') { ev.preventDefault(); this.togglePlay();
            } else if (k === 'ArrowLeft') { ev.preventDefault(); this.seekBy(-this._seekInterval());
            } else if (k === 'ArrowRight') { ev.preventDefault(); this.seekBy(this._seekInterval());
            } else if (k === 'ArrowUp') { ev.preventDefault(); this.adjustVolume(0.1);
            } else if (k === 'ArrowDown') { ev.preventDefault(); this.adjustVolume(-0.1);
            } else if (k === 'f' || k === 'F') { ev.preventDefault(); this.toggleFullscreen();
            } else if (k === 'm' || k === 'M') { ev.preventDefault(); this.toggleMute();
            } else if (k === 'c' || k === 'C') { ev.preventDefault(); this.cycleSubtitle();
            } else if (k === 'n' || k === 'N') { ev.preventDefault(); this.nextEpisode();
            } else if (k === 'e' || k === 'E') { ev.preventDefault(); this.toggleEpisodes();
            } else if (k === 's' || k === 'S') { ev.preventDefault(); this.toggleSources(); }
        };
        document.addEventListener('keydown', this._keyHandler);

        this.destroyInstance();
        /* Move/wheel listeners live on the overlay element itself and
           are removed only in close(), NOT in destroyInstance(), so
           adding them here (after destroy) is safe — destroy will not
           remove its own new listeners. Wheel trap blocks horizontal
           trackpad swipes only; it never seeks (Fix 2). */
        if (this._moveHandler) {
            try { overlay.removeEventListener('mousemove', this._moveHandler); } catch (e) {}
            try { overlay.removeEventListener('pointerdown', this._moveHandler); } catch (e) {}
        }
        this._moveHandler = () => this._wakeTopBar();
        overlay.addEventListener('mousemove', this._moveHandler, { passive: true });
        overlay.addEventListener('pointerdown', this._moveHandler, { passive: true });
        if (this._wheelHandler) { try { overlay.removeEventListener('wheel', this._wheelHandler); } catch (e) {} }
        this._wheelHandler = (ev) => {
            if (this._sourcesOpen || this._episodesOpen) return;
            if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) { ev.preventDefault(); ev.stopPropagation(); }
        };
        overlay.addEventListener('wheel', this._wheelHandler, { passive: false });
        overlay.classList.add('gp-seek-hidden');
        this._wakeTopBar();
        this._autoMarked = false;
        this._skipIntervals = [];
        this._autoSkippedKeys = new Set();
        this._aniskipFetched = false;
        this._tracksReadyDone = false;
        this._rawUrl = url;
        /* Boot: null, NOT 'off' — do not disable movi's own soft-sub
           track before auto-select runs (Fix 3). */
        this._subChoice = null;
        this._subManual = false;
        this._streamObj = streamObj || null;
        this._streamSubs = [];
        this._mergeSubs(this._normalizeSubs(streamObj && streamObj.subtitles, 'Stream'));

        /* Create the movi element. Stream-owned subtitles are
           declared as <track> children BEFORE src is set, which
           is the documented external-subtitle path. */
        const container = document.getElementById('moviContainer');
        if (!container) return;
        const mp = document.createElement('movi-player');
        try { mp.setAttribute('controls', ''); } catch (e) {}
        try { mp.setAttribute('theme', 'dark'); } catch (e) {}
        /* Single keyboard owner: GAnime's handler above. movi's
           own fullscreen/PiP buttons are off so the overlay
           fullscreen (which keeps the top icons + popups visible)
           is the only fullscreen path. */
        try { mp.setAttribute('nohotkeys', ''); } catch (e) {}
        try { mp.setAttribute('controlslist', 'nofullscreen nopip nocenterplay'); } catch (e) {}
        try { mp.setAttribute('fastseek', settings.swipeToSeek === false ? 'none' : 'gestures'); } catch (e) {}
        /* Subtitle look from GAnime settings, mapped to movi's
           own attributes. Size is a multiplier (20px = 1.0).
           Bold and px offset have no movi equivalent: not mapped. */
        try {
            const sz = settings.subtitleSize || 20;
            mp.setAttribute('subtitlesize', String(sz / 20));
            const bg = (100 - (settings.subtitleBgTransparency ?? 50)) / 100 * 0.85;
            mp.setAttribute('subtitlebg', String(bg.toFixed(2)));
        } catch (e) {}
        (this._streamSubs || []).forEach(sub => {
            try { mp.appendChild(this._makeTrackEl(sub)); } catch (e) {}
        });
        container.appendChild(mp);
        this.movi = mp;

        /* Wait for the element definition (module script), but do
           not stall forever if the CDN is slow. */
        try {
            if (window.customElements && customElements.whenDefined) {
                await Promise.race([
                    customElements.whenDefined('movi-player'),
                    new Promise(res => setTimeout(res, 8000))
                ]);
            }
        } catch (e) {}
        try { this._syncMoviTheme(); setTimeout(() => this._syncMoviTheme(), 900); } catch (e) {}
        /* Torrentio resolve: /resolve/ links are redirects the
           browser player cannot follow (generic "can't load"
           error), while direct links play fine. Resolve first
           via the relay — it returns only the Location header,
           video never passes through it — and hand Movi the
           final URL. Any failure keeps the original link.
           Placed AFTER the fullscreen request above (that call
           must stay inside the click gesture) and BEFORE Movi
           gets its src below. currentUrl/_rawUrl stay the
           original link (sources list, external handoff, copy). */
        let playUrl = url;
        if (url.startsWith('https://torrentio.strem.fun/resolve/')) {
            try {
                const relay = (typeof Config !== 'undefined' && Config.OAUTH && Config.OAUTH.RELAY_URL) || '';
                if (relay) {
                    const r = await fetch(relay + '/resolve', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url }),
                    });
                    const d = await r.json().catch(() => ({}));
                    if (r.ok && typeof d.location === 'string' && d.location.startsWith('https://')) playUrl = d.location;
                }
            } catch (e) { /* fall back to the original link */ }
        }
        /* Closed while waiting for the CDN? Do not start playback
           on a torn-down player. */
        if (!this.movi || this.currentUrl !== url) return;

        const onTime = () => { const _ov3 = document.getElementById('playerOverlay'); if (_ov3 && this.movi && (this.movi.currentTime || 0) > 0.05) { _ov3.classList.remove('gp-seek-hidden'); _ov3.classList.remove('gp-buffering'); } this._onTimeUpdate(t, ep, settings); };
        const onEnded = () => this._onTimeUpdate(t, ep, settings, true);
        const onTracks = () => this._onTracksReady();
        const onMeta = () => { this._fetchAniskipOnce(t, ep); this._onTracksReady(); };
        const onErr = () => this.showError();
        this._timeHandler = onTime; this._endedHandler = onEnded;
        this._tracksHandler = onTracks; this._metaHandler = onMeta; this._errorHandler = onErr;
        try { mp.addEventListener('timeupdate', onTime); } catch (e) {}
        try { mp.addEventListener('ended', onEnded); } catch (e) {}
        try { mp.addEventListener('trackschange', onTracks); } catch (e) {}
        try { mp.addEventListener('loadedmetadata', onMeta); } catch (e) {}
        try { mp.addEventListener('durationchange', onMeta); } catch (e) {}
        try { mp.addEventListener('error', onErr); } catch (e) {}
        try { mp.addEventListener('errordisplay', onErr); } catch (e) {}
        /* Re-arm idle-hide when playback actually starts — this is
           the second half of the live fix: play starting must wake
           (and re-time) the top bar, not just mouse/key. */
        /* Reveal gate (Gemini catch, verified): 'play' fires on intent,
           before any frame is decoded, so revealing here put our buttons
           on a black screen over movi's spinner. Reveal only when real
           frames are painting: playing AND currentTime > 0.05. */
        this._playHandler = () => { const _ov2 = document.getElementById('playerOverlay'); if (_ov2 && this.movi && (this.movi.currentTime || 0) > 0.05) { _ov2.classList.remove('gp-seek-hidden'); _ov2.classList.remove('gp-buffering'); } this._wakeTopBar(); this._updateSeekPlayBtn(); };
        try { mp.addEventListener('play', this._playHandler); } catch (e) {}
        try { mp.addEventListener('playing', this._playHandler); } catch (e) {}
        /* Inspection fix (2026-10-25): pause via movi's own bar left the
           centre button stuck on pause, and seek-to-0 left the centre
           hidden (gate needs time > 0.05). Pause and seeked both clear
           the hidden/buffering classes, so controls are reachable. */
        this._pauseHandler = () => { const _ov5 = document.getElementById('playerOverlay'); if (_ov5) { _ov5.classList.remove('gp-seek-hidden'); _ov5.classList.remove('gp-buffering'); } this._wakeTopBar(); this._updateSeekPlayBtn(); };
        try { mp.addEventListener('pause', this._pauseHandler); } catch (e) {}
        this._seekedHandler = () => { const _ov6 = document.getElementById('playerOverlay'); if (_ov6) { _ov6.classList.remove('gp-seek-hidden'); _ov6.classList.remove('gp-buffering'); } };
        try { mp.addEventListener('seeked', this._seekedHandler); } catch (e) {}
        this._waitHandler = () => { const _ov4 = document.getElementById('playerOverlay'); if (_ov4) _ov4.classList.add('gp-buffering'); };
        try { mp.addEventListener('waiting', this._waitHandler); } catch (e) {}
        try { mp.addEventListener('stalled', this._waitHandler); } catch (e) {}

        try { mp.setAttribute('src', playUrl); } catch (e) { try { mp.src = playUrl; } catch (e2) {} }
        try { if (typeof mp.load === 'function') mp.load(); } catch (e) {}
        try {
            const p = (typeof mp.play === 'function') ? mp.play() : null;
            if (p && p.catch) p.catch(() => {});
        } catch (e) {}

        /* Addon subtitles in the background. When they arrive they
           are appended as <track> children (best effort — whether
           movi picks up late-added tracks is UNPROVEN, see README).
           Stream-owned tracks above are the safe path. */
        this.loadAddonSubs(t, ep);
        this._waitTracksReady();
    },

    /* ---------- movi tracks (no invented API) ---------- */
    /* Collect tracks from every source movi actually exposes:
       getAudioTracks/getSubtitleTracks if functions, the
       getAudioLangs/getSubtitleLangs pair if present (their
       active flag is the trustworthy one), and the
       HTMLMediaElement-parity audioTracks/textTracks lists.
       Probe tracks carry no per-track chosen flag — use the
       active flag from the langs/track lists instead. */
    async _collectTracks() {
        const mp = this.movi;
        if (!mp) return { audio: [], subs: [] };
        const audio = [], subs = [];
        const push = (list, kind) => {
            (Array.isArray(list) ? list : []).forEach((tr, i) => {
                if (!tr) return;
                const id = (tr.id !== undefined && tr.id !== null) ? tr.id : i;
                const lang = tr.language || tr.lang || '';
                const name = tr.label || tr.name || (kind === 'audio' ? ('Audio Track ' + (i + 1)) : ('Subtitle ' + (i + 1)));
                const item = { id, index: i, lang, name,
                    codec: tr.codec || tr.subtitleType || '',
                    active: !!(tr.active || tr.enabled) };
                if (kind === 'audio') { if (!audio.some(x => String(x.id) === String(id))) audio.push(item); }
                else if (!subs.some(x => String(x.id) === String(id))) subs.push(item);
            });
        };
        const tryFn = async (fnName, kind) => {
            try {
                if (mp[fnName] && typeof mp[fnName] === 'function') {
                    const r = mp[fnName]();
                    const v = (r && typeof r.then === 'function') ? await r : r;
                    push(v, kind);
                }
            } catch (e) {}
        };
        await tryFn('getAudioTracks', 'audio');
        await tryFn('getSubtitleTracks', 'subs');
        await tryFn('getAudioLangs', 'audio');
        await tryFn('getSubtitleLangs', 'subs');
        /* Fallback ONLY if movi's API returned nothing for that kind.
           Mixing textTracks in on MKV collides: textTrack index 0/1/2
           is not container track id 2/3 (Fix 3). */
        if (!audio.length) {
            try { if (mp.audioTracks && mp.audioTracks.length) push(Array.prototype.slice.call(mp.audioTracks), 'audio'); } catch (e) {}
        }
        if (!subs.length) {
        try {
            if (mp.textTracks && mp.textTracks.length) {
                const list = [];
                for (let i = 0; i < mp.textTracks.length; i++) {
                    const tt = mp.textTracks[i];
                    if (tt && (tt.kind === 'subtitles' || tt.kind === 'captions')) list.push({ id: i, language: tt.language || '', label: tt.label || tt.language || ('Subtitle ' + (i + 1)), active: tt.mode === 'showing' });
                }
                push(list, 'subs');
            }
        } catch (e) {}
        }
        return { audio, subs };
    },

    /* Poll for tracks-ready. NO fixed timer for auto-select:
       poll every 250ms until tracks appear or 15s pass. */
    _waitTracksReady() {
        clearInterval(this._tracksPoll);
        let waited = 0;
        this._tracksPoll = setInterval(async () => {
            waited += 250;
            const tr = await this._collectTracks();
            if ((tr.audio.length || tr.subs.length) || waited >= 15000) {
                clearInterval(this._tracksPoll); this._tracksPoll = null;
                this._onTracksReady(tr);
            }
        }, 250);
    },

    async _onTracksReady(pre) {
        const tr = pre || await this._collectTracks();
        if (!tr.audio.length && !tr.subs.length && !this.movi) return;
        if (this._tracksReadyDone) {
            /* Latch fix (audit bundle): the first call could fire
               before movi parsed its tracks, or with audio only.
               If NEW tracks appeared since, re-run auto-select —
               _autoSelectTracks respects a manual subtitle pick. */
            const prev = this._moviTracks || { audio: [], subs: [] };
            if (tr.subs.length > (prev.subs || []).length || tr.audio.length > (prev.audio || []).length) {
                this._moviTracks = tr;
                this._autoSelectTracks(tr);
            }
            return;
        }
        this._tracksReadyDone = true;
        this._moviTracks = tr;
        this._autoSelectTracks(tr);
    },

    _pickTrack(list, regexes) {
        for (const re of regexes) {
            if (!re) continue;
            const hit = list.find(x => re.test(x.name || '') || re.test(x.lang || ''));
            if (hit) return hit;
        }
        return null;
    },

    /* Auto-select, respecting real settings:
       Audio order: named preferred, named secondary, Japanese,
       then the first track. 'Device language' is NOT a named
       language, so it falls through to Japanese for anime.
       Subtitles: if preferred is 'None' (the default), pick
       NOTHING — movi keeps its own default and the user picks
       in movi's Subtitles menu. Named preferred first, then
       English, then nothing (never force a first track blindly
       when the user asked for a language). */
    _autoSelectTracks(tr) {
        if (!tr || this._subManual) { /* audio still runs below */ }
        const s = this._settings();
        const reFor = { English: /eng|english/i, Japanese: /jpn|japanese/i, Hindi: /hin|hindi/i };
        const audioRes = [reFor[s.preferredAudioLanguage], reFor[s.secondaryAudioLanguage], /jpn|japanese/i].filter(Boolean);
        const aHit = this._pickTrack(tr.audio || [], audioRes) || ((tr.audio || [])[0] || null);
        if (aHit && !aHit.active) this._applyAudioTrack(aHit);
        if (this._subManual) return;
        const pref = s.preferredSubtitleLanguage;
        if (!pref || pref === 'None') return;
        const prefRe = reFor[pref];
        const sHit = this._pickTrack(tr.subs || [], [prefRe, /eng|english/i].filter(Boolean));
        if (sHit && !sHit.active) this._applySubtitleTrack(sHit);
    },

    _applyAudioTrack(track) {
        const mp = this.movi;
        if (!mp || !track) return;
        try {
            if (typeof mp.selectAudioTrack === 'function') { const r = mp.selectAudioTrack(track.id); if (r && r.catch) r.catch(() => {}); return; }
        } catch (e) {}
        try {
            if (mp.audioTracks && mp.audioTracks.length) {
                for (let i = 0; i < mp.audioTracks.length; i++) {
                    try { mp.audioTracks[i].enabled = (String(mp.audioTracks[i].id !== undefined ? mp.audioTracks[i].id : i) === String(track.id) || i === track.index); } catch (e2) {}
                }
                return;
            }
        } catch (e) {}
    },

    _applySubtitleTrack(trackOrNull) {
        const mp = this.movi;
        if (!mp) return;
        try {
            if (typeof mp.selectSubtitleTrack === 'function') {
                const r = mp.selectSubtitleTrack(trackOrNull ? trackOrNull.id : null);
                if (r && r.catch) r.catch(() => {});
                if (trackOrNull) this._subChoice = { kind: 'movi', id: trackOrNull.id };
                else this._subChoice = { kind: 'off', id: null };
                return;
            }
        } catch (e) {}
        try {
            if (mp.textTracks && mp.textTracks.length) {
                for (let i = 0; i < mp.textTracks.length; i++) {
                    try { mp.textTracks[i].mode = (trackOrNull && (i === trackOrNull.index || String(i) === String(trackOrNull.id))) ? 'showing' : 'disabled'; } catch (e2) {}
                }
                if (trackOrNull) this._subChoice = { kind: 'movi', id: trackOrNull.id };
                else this._subChoice = { kind: 'off', id: null };
                return;
            }
        } catch (e) {}
    },

    /* Programmatic wrappers kept for callers / keyboard / tests.
       setAudioTrack(type, idx) is the legacy shape: type is
       ignored in movi mode, idx is the track's position in the
       collected list. */
    async setAudioTrack(type, idx) {
        const tr = await this._collectTracks();
        const hit = (tr.audio || [])[idx] || null;
        if (hit) this._applyAudioTrack(hit);
        if (this._episodesOpen) { /* no-op: movi menu owns tracks */ }
    },

    setSubtitleChoice(kind, idx) {
        this._subManual = true;
        if (kind === 'off') { this._applySubtitleTrack(null); return; }
        if (kind === 'movi') {
            this._collectTracks().then(tr => {
                const hit = (tr.subs || []).find(x => String(x.id) === String(idx)) || (tr.subs || [])[idx];
                if (hit) this._applySubtitleTrack(hit);
            });
            return;
        }
        if (kind === 'addon') {
            const sub = (this._streamSubs || [])[idx];
            if (sub) {
                const el = this._makeTrackEl(sub);
                try { if (this.movi) this.movi.appendChild(el); } catch (e) {}
                this._subChoice = { kind: 'addon', id: idx };
            }
        }
    },

    cycleSubtitle() {
        this._collectTracks().then(tr => {
            const list = [{ kind: 'off', id: null }].concat((tr.subs || []).map(x => ({ kind: 'movi', id: x.id })));
            const cur = this._subChoice || { kind: 'off', id: null };
            let pos = list.findIndex(x => x.kind === cur.kind && String(x.id) === String(cur.id));
            if (pos < 0) pos = 0;
            const next = list[(pos + 1) % list.length];
            this._subManual = true;
            if (next.kind === 'off') this._applySubtitleTrack(null);
            else {
                const hit = (tr.subs || []).find(x => String(x.id) === String(next.id));
                if (hit) this._applySubtitleTrack(hit);
            }
        });
    },

    async _fetchAniskipOnce(t, ep) {
        if (this._aniskipFetched || !t || !t.malId || !ep || ep < 1) return;
        const mp = this.movi;
        const dur = mp ? (mp.duration || 0) : 0;
        if (!dur || dur <= 0) return;
        this._aniskipFetched = true;
        const settings = this._settings();
        if (settings.aniskipEnabled === false) { this._skipIntervals = []; return; }
        this._skipIntervals = await this.fetchAniSkip(t.malId, ep, dur);
    },

    _onTimeUpdate(t, ep, settings, ended) {
        const mp = this.movi;
        if (!mp) return;
        /* Fresh settings every tick (improvement over the old
           player, which captured settings at open and ignored
           live toggles until reopen): */
        settings = this._settings();
        const cur = mp.currentTime || 0;
        const dur = mp.duration || 0;
        const btn = document.getElementById('aniskipBtn');
        if (btn) {
            const activeSkip = (this._skipIntervals || []).find(sk => cur >= sk.start && cur < sk.end - 1);
            if (activeSkip) {
                const auto = (activeSkip.kind === 'op' && settings.aniskipAutoOp) ||
                    (activeSkip.kind === 'ed' && settings.aniskipAutoEd) ||
                    (activeSkip.kind === 'recap' && settings.aniskipAutoRecap);
                const key = activeSkip.kind + ':' + activeSkip.start;
                if (auto) {
                    if (!this._autoSkippedKeys) this._autoSkippedKeys = new Set();
                    if (!this._autoSkippedKeys.has(key)) {
                        this._autoSkippedKeys.add(key);
                        try { mp.currentTime = activeSkip.end; } catch (e) {}
                    }
                    btn.style.display = 'none';
                } else if (settings.aniskipShowButton !== false) {
                    btn.style.display = 'block';
                    btn.textContent = activeSkip.type + ' ⏭';
                    btn.onclick = () => { try { mp.currentTime = activeSkip.end; } catch (e) {} };
                } else {
                    btn.style.display = 'none';
                }
            } else {
                btn.style.display = 'none';
            }
        }
        /* 85% auto-mark: series episodes only (movies open with
           episode 0, so they never reach this), never in Private
           Viewing, never un-marking an existing mark. */
        if (!this._autoMarked && !settings.privateViewing && t && ep >= 1 && dur > 60 && (cur / dur) >= 0.85) {
            this._autoMarked = true;
            let watched = [];
            try { watched = (Storage.getWatched()[t.id] || {}).eps || []; } catch (e) {}
            if (!watched.includes(ep) && typeof App !== 'undefined') {
                App.toggleWatchedEp(t.id, ep);
                this._showMsg('Marked Episode ' + ep + ' as watched ✓', 4000);
            }
        }
        if (ended && !this._autoMarked && !settings.privateViewing && t && ep >= 1 && dur > 60) {
            /* Ended without crossing 85% in a timeupdate tick:
               the file finished, so it counts. */
            this._autoMarked = true;
            let watched = [];
            try { watched = (Storage.getWatched()[t.id] || {}).eps || []; } catch (e) {}
            if (!watched.includes(ep) && typeof App !== 'undefined') App.toggleWatchedEp(t.id, ep);
        }
    },

    /* ---------- subtitle helpers (pure, no player engine) ---------- */
    _normalizeSubs(list, source) {
        if (!Array.isArray(list)) return [];
        return list.filter(x => x && x.url).map(x => {
            const lang = x.lang || x.language || '';
            return { url: x.url, lang: lang, name: this._langName(lang || x.label), addon: source || '' };
        });
    },

    _mergeSubs(list) {
        const s = this._settings();
        const prefRe = { English: /eng|english/i, Japanese: /jpn|japanese/i, Hindi: /hin|hindi/i }[s.preferredSubtitleLanguage];
        const keyOf = x => (x.lang || '') + ' ' + (x.name || '');
        const seen = new Set();
        let all = [];
        (this._streamSubs || []).concat(list || []).forEach(x => {
            if (x && x.url && !seen.has(x.url)) { seen.add(x.url); all.push(x); }
        });
        if (s.preferredLanguagesOnly && prefRe) all = all.filter(x => prefRe.test(keyOf(x)));
        all.sort((a, b) => {
            const pa = prefRe && prefRe.test(keyOf(a)) ? 0 : 1;
            const pb = prefRe && prefRe.test(keyOf(b)) ? 0 : 1;
            if (pa !== pb) return pa - pb;
            return String(a.name).localeCompare(String(b.name));
        });
        const per = {};
        const out = [];
        all.forEach(x => { per[x.name] = (per[x.name] || 0) + 1; if (per[x.name] <= 6) out.push(x); });
        const total = {};
        out.forEach(x => { total[x.name] = (total[x.name] || 0) + 1; });
        const run = {};
        out.forEach(x => { run[x.name] = (run[x.name] || 0) + 1; x.label = total[x.name] > 1 ? x.name + ' ' + run[x.name] : x.name; });
        this._streamSubs = out;
    },

    _makeTrackEl(sub) {
        const el = document.createElement('track');
        try { el.src = sub.url; } catch (e) {}
        try { el.setAttribute('src', sub.url); } catch (e) {}
        try { el.srclang = this._langCode(sub.lang || sub.name); } catch (e) {}
        try { el.setAttribute('srclang', this._langCode(sub.lang || sub.name)); } catch (e) {}
        try { el.label = sub.label || sub.name || 'Subtitle'; } catch (e) {}
        try { el.setAttribute('label', sub.label || sub.name || 'Subtitle'); } catch (e) {}
        try { el.kind = 'subtitles'; } catch (e) {}
        try { el.setAttribute('kind', 'subtitles'); } catch (e) {}
        if (/\.srt(\?|$)/i.test(sub.url)) { try { el.setAttribute('data-format', 'srt'); } catch (e) {} }
        return el;
    },

    async loadAddonSubs(t, ep) {
        this._subsToken = (this._subsToken || 0) + 1;
        const token = this._subsToken;
        const urlAtStart = this.currentUrl;
        let addons = [];
        try {
            addons = (Storage.getAddons() || []).filter(a => a.enabled && Array.isArray(a.resources) && a.resources.includes('subtitles'));
        } catch (e) { addons = []; }
        if (!addons.length || !t || typeof App === 'undefined') { this._subsLoading = false; return; }
        this._subsLoading = true;
        let ids = { tt: null, kitsu: null, anilist: t.anilistId || null, mal: t.malId || null };
        try {
            ids = await Promise.race([App.resolveAddonIds(t), new Promise(res => setTimeout(() => res(ids), 6000))]);
        } catch (e) {}
        const found = [];
        await Promise.allSettled(addons.map(async addon => {
            const types = addon.types || [];
            const type = t.type === 'Movie' ? 'movie' : (types.includes('anime') && !types.includes('series')) ? 'anime' : 'series';
            let sids = [];
            try { sids = App.streamIdsFor(addon, ids, t, ep || null) || []; } catch (e) { sids = []; }
            const base = String(addon.manifestUrl || '').replace(/^stremio:\/\//i, 'https://').replace(/\/manifest\.json.*$/i, '').replace(/\/+$/, '');
            if (!base) return;
            for (const sid of sids) {
                try {
                    const ctrl = new AbortController();
                    const to = setTimeout(() => ctrl.abort(), 9000);
                    const r = await fetch(base + '/subtitles/' + type + '/' + sid + '.json', { signal: ctrl.signal });
                    clearTimeout(to);
                    if (!r.ok) continue;
                    const j = await r.json();
                    found.push(...this._normalizeSubs(j && j.subtitles, addon.name));
                } catch (e) {}
            }
        }));
        if (token !== this._subsToken || this.currentUrl !== urlAtStart) return;
        this._subsLoading = false;
        if (!found.length) return;
        this._mergeSubs(found);
        /* Append as <track> children. Best effort for tracks that
           arrive after load — live test must confirm whether movi
           picks them up without a reload. */
        if (this.movi) {
            found.forEach(sub => { try { this.movi.appendChild(this._makeTrackEl(sub)); } catch (e) {} });
        }
        /* Re-poll once so a newly arrived English track can be
           auto-picked under a named preferred language. */
        this._tracksReadyDone = false;
        this._waitTracksReady();
    },

    /* ---------- transport (movi element only) ---------- */
    toggleFullscreen() {
        const overlay = document.getElementById('playerOverlay');
        if (!overlay) return;
        /* No element fullscreen (iOS) → the video-native path,
           so the F key works there too. */
        if (!this._nativeFsAvailable(overlay)) { this._toggleVideoFullscreen(); return; }
        try {
            if (!document.fullscreenElement) {
                if (overlay.requestFullscreen) { const p = overlay.requestFullscreen(); if (p && p.catch) p.catch(() => {}); }
                else if (overlay.webkitRequestFullscreen) overlay.webkitRequestFullscreen();
            } else if (document.exitFullscreen) {
                const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => {});
            }
        } catch (e) {}
    },

    seekBy(sec) {
        const mp = this.movi;
        if (!mp) return;
        try {
            const dur = mp.duration || 99999;
            mp.currentTime = Math.max(0, Math.min(dur, (mp.currentTime || 0) + sec));
            this._showMsg((sec > 0 ? '+' : '') + sec + 's', 1200);
        } catch (e) {}
    },

    togglePlay() {
        const mp = this.movi;
        if (!mp) return;
        try {
            if (mp.paused) { const p = mp.play(); if (p && p.catch) p.catch(() => {}); }
            else mp.pause();
        } catch (e) {}
        /* Play/pause events will correct this, but update now so the
           centre button flips immediately on tap. */
        setTimeout(() => this._updateSeekPlayBtn(), 50);
    },

    adjustVolume(d) {
        const mp = this.movi;
        if (!mp) return;
        try { mp.volume = Math.max(0, Math.min(1, (mp.volume || 0) + d)); } catch (e) {}
    },

    toggleMute() {
        const mp = this.movi;
        if (!mp) return;
        try { mp.muted = !mp.muted; } catch (e) {}
    },

    setRate(r) {
        const mp = this.movi;
        if (!mp) return;
        try { mp.playbackRate = r; } catch (e) {}
        this._showMsg('Speed: ' + r + 'x', 2000);
    },

    setAspect(mode) {
        /* Fix 4 (2026-10-25, LIVE-TEST REQUIRED): setting the
           objectfit attribute alone did not change the picture in
           Isolated's test. So also set mp.objectFit and style the
           canvas/video inside movi and its shadowRoot, if reachable.
           'default'/'16:9'/'4:3' map to contain. Zoom = 1.15x scale. */
        const mp = this.movi;
        if (!mp) return;
        const fit = (mode === 'cover' || mode === 'fill' || mode === 'zoom') ? mode : 'contain';
        try { mp.objectFit = fit; } catch (e) {}
        try { mp.setAttribute('objectfit', fit); } catch (e) {}
        try {
            [mp, mp.shadowRoot].filter(Boolean).forEach(r => {
                r.querySelectorAll('canvas, video').forEach(el => {
                    el.style.objectFit = fit;
                    el.style.transform = (fit === 'zoom') ? 'scale(1.15)' : '';
                });
            });
        } catch (e) {}
        this._showMsg('Aspect: ' + mode, 2000);
    },

    cycleFill() {
        const modes = ['contain', 'cover', 'fill', 'zoom'];
        this._fillIdx = ((this._fillIdx || 0) + 1) % modes.length;
        this.setAspect(modes[this._fillIdx]);
    },

    nextEpisode() {
        const st = (typeof App !== 'undefined' && App.streamsState) || null;
        const tNow = st && typeof App !== 'undefined' && App.titleCache ? App.titleCache[st.titleId] : null;
        if (!st || !tNow || tNow.type === 'Movie' || !tNow.eps || !(st.episode < tNow.eps)) return;
        this.jumpEpisode(st.episode + 1);
    },

    /* Seamless episode switch (Fix 5, reworked from Gemini's nuke):
       - Preferred addon comes from streamsState.groups (the real
         source), NOT _srcList (popup-only, cap 80, empty unless opened).
       - Fetches the target episode via the existing Addons.getStreams
         + App.streamIdsFor, with a 12s overall timeout race so a slow
         addon cannot hang the jump forever.
       - Updates streamsState.episode/groups so the Sources popup
         after a jump shows the NEW episode, not the old one.
       - Scores: same addon 100, bingeGroup 60, release group 35,
         resolution 25, codec 10, browser-supported 5. If no signature
         matches, the same-addon score still decides; if no candidates
         at all, falls back honestly to the link page. */
    async jumpEpisode(targetEp) {
        const st = (typeof App !== 'undefined' && App.streamsState) || null;
        if (!st || !st.titleId || typeof App === 'undefined' || this._jumpingEp) return;
        this._jumpingEp = true;
        this.closeEpisodes();
        this._showMsg('Loading Episode ' + targetEp + '…', 0);
        const prevStream = this._streamObj || {};
        const prevText = ((prevStream.name || '') + '\n' + (prevStream.title || prevStream.description || '')).toLowerCase();
        let preferredAddonUid = null, preferredAddonName = '';
        if (Array.isArray(st.groups)) {
            for (const g of st.groups) {
                if ((g.streams || []).some(x => x && x.url === this.currentUrl)) { preferredAddonUid = g.addon && g.addon.uid; preferredAddonName = (g.addon && g.addon.name) || ''; break; }
            }
        }
        const prevBinge = (prevStream.behaviorHints && prevStream.behaviorHints.bingeGroup) || '';
        const prevRes = (/(2160p|1440p|1080p|720p|480p|4k)/i.exec(prevText) || [])[0] || '';
        const prevGroup = (/(subsplease|erai-raws|judas|ember|asw|commie|horriblesubs|bilibili|crunchyroll)/i.exec(prevText) || [])[0] || '';
        const prevCodec = (/(hevc|x265|avc|x264|av1|aac|opus)/i.exec(prevText) || [])[0] || '';
        try {
            const t = App.titleById(st.titleId);
            const addons = (Storage.getAddons() || []).filter(a => a.enabled && (!a.resources.length || a.resources.includes('stream')));
            if (!t || !addons.length) throw new Error('No addons');
            let ids = { tt: null, kitsu: null, anilist: t.anilistId || null, mal: t.malId || null, season: null, epOffset: 0 };
            try { ids = await Promise.race([App.resolveAddonIds(t), new Promise(res => setTimeout(() => res(ids), 6000))]); } catch (e) {}
            const sortedAddons = addons.slice().sort((a, b) => {
                const ap = (preferredAddonUid && a.uid === preferredAddonUid) || (preferredAddonName && a.name === preferredAddonName) ? 0 : 1;
                const bp = (preferredAddonUid && b.uid === preferredAddonUid) || (preferredAddonName && b.name === preferredAddonName) ? 0 : 1;
                return ap - bp;
            });
            const fetchAll = Promise.allSettled(sortedAddons.map(async (addon) => {
                const addonTypes = addon.types || [];
                const type = t.type === 'Movie' ? 'movie' : (addonTypes.includes('anime') && !addonTypes.includes('series')) ? 'anime' : 'series';
                const sids = App.streamIdsFor(addon, ids, t, targetEp);
                if (!sids.length) return { addon, idx: addons.indexOf(addon), streams: [] };
                const merged = [], seen = new Set();
                for (const sid of sids) {
                    try {
                        const found = await Addons.getStreams(addon, type, sid);
                        for (const x of found) { const key = x.url || x.infoHash || ((x.name || '') + '|' + (x.title || '')); if (!seen.has(key)) { seen.add(key); merged.push(x); } }
                    } catch (e) {}
                }
                return { addon, idx: addons.indexOf(addon) >= 0 ? addons.indexOf(addon) : 0, streams: merged };
            }));
            const settled = await Promise.race([fetchAll, new Promise(res => setTimeout(() => res(null), 12000))]);
            if (!settled) throw new Error('Jump fetch timed out');
            const newGroups = settled.filter(r => r.status === 'fulfilled').map(r => r.value);
            st.episode = targetEp;
            st.groups = newGroups.sort((a, b) => a.idx - b.idx);
            st.loading = false;
            this._srcList = [];
            if (typeof App.persistRoute === 'function') App.persistRoute();
            if (typeof App.syncHash === 'function') App.syncHash();
            const candidates = [];
            st.groups.forEach(g => { (g.streams || []).filter(x => x && x.url).forEach(x => candidates.push({ addon: g.addon, stream: x })); });
            if (!candidates.length) { this._jumpingEp = false; this.close(); App.openStreams(st.titleId, targetEp); return; }
            let best = candidates[0], bestScore = -999;
            candidates.forEach(item => {
                const x = item.stream;
                const txt = ((x.name || '') + '\n' + (x.title || x.description || '')).toLowerCase();
                let score = 0;
                if ((preferredAddonUid && item.addon.uid === preferredAddonUid) || (preferredAddonName && item.addon.name === preferredAddonName)) score += 100;
                if (prevBinge && x.behaviorHints && x.behaviorHints.bingeGroup === prevBinge) score += 60;
                if (prevGroup && txt.includes(prevGroup.toLowerCase())) score += 35;
                if (prevRes && txt.includes(prevRes.toLowerCase())) score += 25;
                if (prevCodec && txt.includes(prevCodec.toLowerCase())) score += 10;
                if (typeof App.isStreamSupported === 'function' && App.isStreamSupported(x)) score += 5;
                if (score > bestScore) { bestScore = score; best = item; }
            });
            this._jumpingEp = false;
            const newLabel = (t.title || 'Stream') + ' · Episode ' + targetEp;
            this.destroyInstance();
            await this.open(best.stream.url, newLabel, best.stream);
            this._showMsg('Episode ' + targetEp + ' · ' + this._escLabel(best.addon.name), 2500);
        } catch (e) {
            this._jumpingEp = false;
            this.close();
            App.openStreams(st.titleId, targetEp);
        }
    },

    /* Link probe (diagnostic, Torrentio [TB+] failure): when
       playback errors, say WHY on screen instead of only the
       generic "can't load" line. First a Range fetch (2 bytes,
       aborted as soon as headers arrive — never a full
       download); if that throws, a no-cors fetch separates
       "server blocks website reads (CORS)" from "link
       unreachable". The _probing guard stops duplicate probes
       for one error box; close() clears it so reopening the
       same stream re-probes. */
    async _probe(url) {
        const attempt = async (opts) => {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), 12000);
            try { const r = await fetch(url, { ...opts, signal: ac.signal }); return r.status || 200; }
            catch (e) { return 0; }
            finally { clearTimeout(timer); ac.abort(); }
        };
        const s = await attempt({ headers: { Range: 'bytes=0-1' } });
        if (s >= 200 && s < 400) return 'Link opens fine (HTTP ' + s + ') → likely a video format problem.';
        if (s) return 'Server answered with an error (HTTP ' + s + ') → bad or expired link/key.';
        const o = await attempt({ mode: 'no-cors' });
        return o ? 'Link works, but the server does not allow websites to read it (CORS) → this is the problem.'
                 : 'Link could not be reached at all → network/ISP block, or the link is dead.';
    },

    showError() {
        this._showMsg(`
            <div><b>Unable to play media.</b></div>
            <p style="margin:6px 0">This browser may not support this video's codec (common with HEVC/AV1 torrent encodes).
            Send the same link to an external player instead — VLC plays nearly everything:</p>
            <p id="gpProbe" style="margin:6px 0;opacity:.8">Checking the link…</p>
            <div>
                <button class="btn-primary" onclick="Player.openExternal()">⤢ Open in external player</button>
                <button class="btn-secondary" onclick="Player.copyLink()">Copy link</button>
            </div>`);
        /* Probe kick: result lands via textContent (never
           innerHTML), so a hostile link cannot inject markup. */
        const u = this.currentUrl;
        if (u && this._probing !== u) {
            this._probing = u;
            this._probe(u).then(txt => { const el = document.getElementById('gpProbe'); if (el) el.textContent = txt; });
        }
    },

    /* ---------- Episode popup (dark-glass overlay) ---------- */
    toggleEpisodes() {
        if (this._episodesOpen) this.closeEpisodes(); else this.openEpisodes();
    },

    openEpisodes() {
        const pop = document.getElementById('gpMoviEp');
        if (!pop) return;
        this.closeSources();
        this._episodesOpen = true;
        /* Default to the range containing the current episode. */
        try {
            const st = (typeof App !== 'undefined' && App.streamsState) || {};
            const t = st.titleId && typeof App !== 'undefined' ? App.titleById(st.titleId) : null;
            const total = (t && t.eps) || 1;
            const curEp = st.episode || 1;
            let chunk = 12;
            if (total > 300) chunk = 100; else if (total > 96) chunk = 24;
            this._epRangeStart = Math.floor((curEp - 1) / chunk) * chunk + 1;
        } catch (e) { this._epRangeStart = 1; }
        this.renderEpisodes();
        pop.classList.add('open');
        /* Like movi's own menus: a tap anywhere else closes it. */
        const ovEl = document.getElementById('playerOverlay');
        if (ovEl) {
            if (this._epOutside) ovEl.removeEventListener('pointerdown', this._epOutside, true);
            this._epOutside = (e) => {
                const p = document.getElementById('gpMoviEp');
                const tg = e.target;
                if (!p || p.contains(tg)) return;
                if (tg.closest && tg.closest('#gpMoviEpBtn, #gpMoviSrcBtn')) return;
                this.closeEpisodes();
            };
            ovEl.addEventListener('pointerdown', this._epOutside, true);
        }
    },

    closeEpisodes() {
        this._episodesOpen = false;
        const pop = document.getElementById('gpMoviEp');
        if (pop) pop.classList.remove('open');
        const _ovE = document.getElementById('playerOverlay');
        if (_ovE && this._epOutside) { _ovE.removeEventListener('pointerdown', this._epOutside, true); this._epOutside = null; }
            this._wakeTopBar();
    },

    setEpRange(from) {
        this._epRangeStart = from;
        this.renderEpisodes();
    },

    renderEpisodes() {
        const pop = document.getElementById('gpMoviEp');
        if (!pop || !this._episodesOpen) return;
        const st = (typeof App !== 'undefined' && App.streamsState) || {};
        const t = st.titleId && typeof App !== 'undefined' ? App.titleById(st.titleId) : null;
        const total = (t && t.eps) || 1;
        const curEp = st.episode || 1;
        let watched = [];
        try { watched = (t && typeof Storage !== 'undefined' && (Storage.getWatched()[t.id] || {}).eps) || []; } catch (e) {}
        /* Chunk ranges, same sizes as Details: <=96 -> 12,
           <=300 -> 24, >300 -> 100. */
        let chunk = 12;
        if (total > 300) chunk = 100; else if (total > 96) chunk = 24;
        const ranges = [];
        for (let s = 1; s <= total; s += chunk) ranges.push({ from: s, to: Math.min(s + chunk - 1, total) });
        if (!this._epRangeStart) this._epRangeStart = 1;
        const range = ranges.find(r => r.from === this._epRangeStart) || ranges[0] || { from: 1, to: total };
        const rows = [];
        const end = Math.min(range.to, range.from + 119);
        for (let n = range.from; n <= end; n++) {
            const isCur = n === curEp;
            let epTitle = '';
            try {
                if (typeof App !== 'undefined' && App.epDataFor) { const d = App.epDataFor(n); if (d && d.title) epTitle = ' · ' + d.title; }
            } catch (e) {}
            rows.push(`
                <button class="gp-movi-row ${isCur ? 'active' : ''}" onclick="Player.jumpEpisode(${n})">
                    <span>${isCur ? '▶ ' : ''}Episode ${n}${this._escLabel(epTitle)}</span>
                    ${watched.includes(n) ? '<span class="gp-tag">👁 Watched ✓</span>' : ''}
                </button>`);
        }
        pop.innerHTML = `
            <div class="gp-movi-head">
                <span class="gp-movi-title">Episodes (${total})</span>
                <button class="gp-movi-close" onclick="Player.closeEpisodes()">✕</button>
            </div>
            <div class="gp-movi-chips">
                ${ranges.map(r => `<button class="gp-movi-chip ${r.from === range.from ? 'active' : ''}" onclick="Player.setEpRange(${r.from})">${r.from} - ${r.to}</button>`).join('')}
            </div>
            ${rows.join('')}
            ${range.to > end ? `<div class="gp-movi-note">Showing Ep ${range.from}–${end} of this range — use Details for the full list.</div>` : ''}`;
    },

    /* ---------- Source popup (dark-glass overlay) ---------- */
    toggleSources() {
        if (this._sourcesOpen) this.closeSources(); else this.openSources();
    },

    openSources() {
        const back = document.getElementById('gpSrcBack');
        if (!back) return;
        this.closeEpisodes();
        this._sourcesOpen = true;
        this._srcFilter = 'all';
        back.onclick = (e) => { if (e.target === back) this.closeSources(); };
        /* Build the panel first, THEN add .open, so it animates in. */
        this.renderSources();
        void back.offsetWidth;
        back.classList.add('open');
    },

    closeSources() {
        this._sourcesOpen = false;
        clearInterval(this._srcPoll);
        this._srcPoll = null;
        const back = document.getElementById('gpSrcBack');
        if (back) back.classList.remove('open');
            this._wakeTopBar();
    },

    setSourcesFilter(f) {
        this._srcFilter = f;
        this.renderSources();
    },

    reloadSources() {
        if (typeof App === 'undefined' || !App.refreshStreams) return;
        App.refreshStreams();
        clearInterval(this._srcPoll);
        let n = 0;
        this._srcPoll = setInterval(() => {
            const st = App.streamsState;
            this.renderSources();
            if (!this._sourcesOpen || !st || !st.loading || ++n > 60) {
                clearInterval(this._srcPoll);
                this._srcPoll = null;
                this.renderSources();
            }
        }, 700);
        this.renderSources();
    },

    _audioBadge(s) {
        const text = String((s && (s.name || '')) + '\n' + (s && (s.description || s.title || '')));
        const surround = /\b(eac3|e-ac-3|ac3|ac-3|dts|truehd|atmos|5\.1|7\.1|ddp)\b/i.test(text);
        if (surround) return '<span class="gp-src-badge warn">⚠ Surround audio may be silent here — use VLC</span>';
        if (/\baac\b|\bopus\b/i.test(text)) return '<span class="gp-src-badge ok">✓ Browser audio ready (AAC)</span>';
        return '';
    },

    renderSources() {
        const back = document.getElementById('gpSrcBack');
        if (!back || !this._sourcesOpen) return;
        const st = (typeof App !== 'undefined' && App.streamsState) || null;
        const groups = st ? st.groups.slice().sort((a, b) => a.idx - b.idx) : [];
        const addons = st ? (st.addons || []) : [];
        const filter = this._srcFilter === undefined ? 'all' : this._srcFilter;
        const playable = g => g.streams.filter(s => s && s.url);
        const chips = [`<button class="gp-src-chip ${filter === 'all' ? 'active' : ''}" onclick="Player.setSourcesFilter('all')">All</button>`]
            .concat(addons.map((a, i) => {
                const g = groups.find(x => x.idx === i);
                const label = this._escLabel(a.name) + (g ? ' · ' + playable(g).length : ' …');
                return `<button class="gp-src-chip ${filter === i ? 'active' : ''}" onclick="Player.setSourcesFilter(${i})">${label}</button>`;
            })).join('');
        const list = [];
        groups.filter(g => filter === 'all' || g.idx === filter).forEach(g => {
            playable(g).forEach(s => list.push({ addon: g.addon, stream: s }));
        });
        this._srcList = list.slice(0, 80);
        const cards = this._srcList.map((it, n) => {
            const s = it.stream;
            const current = s.url === this.currentUrl;
            const desc = String(s.description || s.title || '').trim();
            const warn = (typeof App !== 'undefined' && App.isStreamSupported && !App.isStreamSupported(s)) ? ' · surround audio may be silent here' : '';
            return `<button class="gp-src-card ${current ? 'current' : ''}" onclick="Player.playSource(${n})">
                <div class="gp-src-name">${this._escLabel(s.name || it.addon.name)}</div>
                ${desc ? `<div class="gp-src-desc">${this._escLabel(desc)}</div>` : ''}
                <div class="gp-src-addon">${this._escLabel(it.addon.name)}${current ? ' · Now playing' : ''}${warn}</div>
                ${this._audioBadge(s)}
            </button>`;
        }).join('');
        let status = '';
        if (st && st.loading && !list.length) status = '<div class="gp-src-empty">Fetching streams from your addons…</div>';
        else if (!list.length) status = '<div class="gp-src-empty">No playable streams here.</div>';
        const _prevList = back.querySelector('.gp-src-list');
        const _prevTop = _prevList ? _prevList.scrollTop : 0;
        back.innerHTML = `
            <div class="gp-src" onclick="event.stopPropagation()">
                <div class="gp-src-head">
                    <div class="gp-src-title">Sources</div>
                    <button class="gp-src-btn" onclick="Player.reloadSources()">↻ Reload</button>
                    <button class="gp-src-btn" onclick="Player.closeSources()">Close</button>
                </div>
                <div class="gp-src-chips">${chips}</div>
                <div class="gp-src-list">${cards}${status}</div>
            </div>`;
        const _newList = back.querySelector('.gp-src-list');
        if (_newList && _prevTop) _newList.scrollTop = _prevTop;
    },

    playSource(n) {
        const it = (this._srcList || [])[n];
        if (!it || typeof App === 'undefined') return;
        const st = App.streamsState;
        const t = st && st.titleId ? App.titleById(st.titleId) : null;
        const label = (t ? t.title : 'Stream') + (st && st.episode ? ' · Episode ' + st.episode : '');
        this.closeSources();
        this.destroyInstance();
        this.open(it.stream.url, label, it.stream);
    },

    /* ---------- External handoff (unchanged behaviour) ---------- */
    openInM3U() {
        if (!this.currentUrl) return;
        const title = this.currentLabel || 'GAnime Stream';
        const content = '#EXTM3U\n#EXTINF:-1,' + title + '\n' + this.currentUrl + '\n';
        const blob = new Blob([content], { type: 'audio/x-mpegurl' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = title.replace(/[^a-z0-9_-]+/gi, '_') + '.m3u';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },

    openExternalScheme(scheme) {
        if (!this.currentUrl) return;
        const a = document.createElement('a');
        a.href = scheme + this.currentUrl;
        document.body.appendChild(a);
        a.click();
        a.remove();
    },

    openExternal() {
        this.openExternalScheme('vlc://');
        this._showMsg('<p>Sent to your external player. If nothing opened, use Copy link and paste it in VLC → Media → Open Network Stream.</p>');
    },

    copyLink() {
        if (!this.currentUrl) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(this.currentUrl).catch(() => {});
        } else {
            window.prompt('Copy this stream link:', this.currentUrl);
        }
        this._showMsg('<p>Link copied — paste it into VLC, MPV, MX Player, or any player you like.</p>', 4000);
    },

    /* ---------- teardown ---------- */
    destroyInstance() {
        clearInterval(this._tracksPoll);
        this._tracksPoll = null;
        clearTimeout(this._idleTimer);
        this._idleTimer = null;
        const mp = this.movi;
        if (mp) {
            try { if (this._timeHandler) mp.removeEventListener('timeupdate', this._timeHandler); } catch (e) {}
            try { if (this._endedHandler) mp.removeEventListener('ended', this._endedHandler); } catch (e) {}
            try { if (this._tracksHandler) mp.removeEventListener('trackschange', this._tracksHandler); } catch (e) {}
            try { if (this._metaHandler) { mp.removeEventListener('loadedmetadata', this._metaHandler); mp.removeEventListener('durationchange', this._metaHandler); } } catch (e) {}
            try { if (this._errorHandler) { mp.removeEventListener('error', this._errorHandler); mp.removeEventListener('errordisplay', this._errorHandler); } } catch (e) {}
            try { mp.pause(); } catch (e) {}
            try { mp.remove(); } catch (e) {}
        }
        this.movi = null;
        this._timeHandler = this._endedHandler = this._tracksHandler = this._metaHandler = this._errorHandler = null;
        if (mp && this._playHandler) { try { mp.removeEventListener('play', this._playHandler); } catch (e) {} try { mp.removeEventListener('playing', this._playHandler); } catch (e) {} }
        this._playHandler = null;
        if (mp && this._pauseHandler) { try { mp.removeEventListener('pause', this._pauseHandler); } catch (e) {} }
        this._pauseHandler = null;
        if (mp && this._seekedHandler) { try { mp.removeEventListener('seeked', this._seekedHandler); } catch (e) {} }
        this._seekedHandler = null;
        if (mp && this._waitHandler) { try { mp.removeEventListener('waiting', this._waitHandler); } catch (e) {} try { mp.removeEventListener('stalled', this._waitHandler); } catch (e) {} }
        this._waitHandler = null;
    },

    close() {
        this._setPseudoFs(false);
        if (document.fullscreenElement && document.exitFullscreen) {
            try { const p = document.exitFullscreen(); if (p && p.catch) p.catch(() => {}); } catch (e) {}
        }
        this._sourcesOpen = false;
        this._episodesOpen = false;
        clearInterval(this._srcPoll);
        this._srcPoll = null;
        this._subsToken = (this._subsToken || 0) + 1;
        this._jumpingEp = false;
        clearTimeout(this._idleTimer); this._idleTimer = null;
        if (this._keyHandler) { try { document.removeEventListener('keydown', this._keyHandler); } catch (e) {} this._keyHandler = null; }
        const _ov = document.getElementById('playerOverlay');
        if (_ov) {
            if (this._moveHandler) { try { _ov.removeEventListener('mousemove', this._moveHandler); } catch (e) {} try { _ov.removeEventListener('pointerdown', this._moveHandler); } catch (e) {} }
            if (this._wheelHandler) { try { _ov.removeEventListener('wheel', this._wheelHandler); } catch (e) {} }
        }
        this._moveHandler = null; this._wheelHandler = null;
        if (_ov && this._epOutside) { try { _ov.removeEventListener('pointerdown', this._epOutside, true); } catch (e) {} this._epOutside = null; }
        this.destroyInstance();
        const overlay = document.getElementById('playerOverlay');
        if (overlay) {
            overlay.classList.add('hidden');
            overlay.classList.remove('gp-pseudo-fs');
            overlay.innerHTML = '';
        }
        this.currentUrl = '';
        this._probing = null;
        this._skipIntervals = [];
        this._restoreLayout();
    },

    /* Layout Phase 4: defensive reset for the return from the
       player. exitFullscreen() finishes asynchronously, so the
       viewport can change AFTER the overlay is gone and leave
       the fixed layers (top bar, nav, FAB) misplaced; the
       orientation may also stay locked and the scroll position
       lost. Run the fix on the next frame, again on the
       fullscreenchange that follows, and once more after 400ms
       so every ordering lands. */
    _restoreLayout() {
        const y = this._scrollY || 0;
        const fix = () => {
            try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (e) {}
            document.documentElement.classList.remove('gp-pfs-lock');
            window.dispatchEvent(new Event('resize'));
            void document.body.offsetHeight;
            window.scrollTo(0, y);
        };
        requestAnimationFrame(fix);
        if (document.fullscreenElement) document.addEventListener('fullscreenchange', () => setTimeout(fix, 50), { once: true });
        setTimeout(fix, 400);
    }
};
