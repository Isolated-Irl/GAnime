// ============================================================
// GAnime — config.js (Step 2: core foundation)
// App constants, accent presets, default profiles, default settings.
// Settings defaults follow the real Nuvio Enhanced app defaults.
// ============================================================
const Config = {
    APP_NAME: 'GAnime',
    APP_VERSION: 'GAnime 0.1.0',

    /* GAnime's own OAuth client IDs, baked in so connecting a
       tracker never asks the user to type developer details.
       AniList (54686), Simkl and MAL are Isolated's official
       apps, all redirecting to ganime.pages.dev with a
       ?provider= tag. Simkl/MAL token swaps run through the
       Cloudflare relay (RELAY_URL) so no secret ever ships
       in this public code. */
    OAUTH: {
        ANILIST_CLIENT_ID: '54686',
        SIMKL_CLIENT_ID: '49dfaf44602c7464026066ff52eb2e4fb797f26a136a2107c250e5d9f73f8a7b',
        MAL_CLIENT_ID: 'f15fbfc461e31b1674c0747f5e680f01',
        RELAY_URL: 'https://ganime-relay.gp237372.workers.dev'
    },

    /* Firebase Auth (Spark, REST, Phase 1 login only).
       Fill these from Firebase console > Project settings > Your apps
       (Web </>). apiKey is the PUBLIC web key, not a secret — but set
       Authorized Domains in Firebase console to the live Pages URL
       (+ localhost for testing). NEVER put a service-account / Admin
       SDK key here. Leave apiKey empty and the gate falls back to
       Guest mode only (no fake sign-in) until a project exists. */
    FIREBASE: {
        apiKey: 'AIzaSyAQoVcRZ1pd6RTBGjdDOTYdIlBv7B-0SVM',
        authDomain: 'ganime-1a0a1.firebaseapp.com',
        projectId: 'ganime-1a0a1',
        appId: '1:556800923220:web:36c9511b40d604bf03bfc1'
    },
    DATA_VERSION: 3,   // marker only — getProfiles() writes it and resets nothing

    // Theme swatches exactly as the real app's Layout page names them.
    ACCENT_PRESETS: [
        { id: 'white',   name: 'White',   color: '#ffffff', secondary: '#d4d4d4' },
        { id: 'crimson', name: 'Crimson', color: '#ef2d3f', secondary: '#b91c1c' },
        { id: 'ocean',   name: 'Ocean',   color: '#2196f3', secondary: '#1565c0' },
        { id: 'violet',  name: 'Violet',  color: '#9c27b0', secondary: '#6a1b9a' },
        { id: 'emerald', name: 'Emerald', color: '#4caf50', secondary: '#2e7d32' },
        { id: 'amber',   name: 'Amber',   color: '#ff9800', secondary: '#e65100' },
        { id: 'rose',    name: 'Rose',    color: '#e91e63', secondary: '#ad1457' }
    ],

    // Avatar catalog for the Add Profile screen. Bram the bear is the real
    // app's default (first) avatar; the rest are placeholder catalog entries.
    AVATAR_CATALOG: [
        { name: 'Bram',  emoji: '🐻', bg: '#f48fb1' },
        { name: 'Moo',   emoji: '🐮', bg: '#b39ddb' },
        { name: 'Pig',   emoji: '🐷', bg: '#64b5f6' },
        { name: 'Owl',   emoji: '🦉', bg: '#4db6ac' },
        { name: 'Leo',   emoji: '🦁', bg: '#dce775' },
        { name: 'Cat',   emoji: '🐱', bg: '#ba68c8' },
        { name: 'Fox',   emoji: '🦊', bg: '#ffb74d' },
        { name: 'Bunny', emoji: '🐰', bg: '#e57373' },
        { name: 'Panda', emoji: '🐼', bg: '#ffa726' },
        { name: 'Ghost', emoji: '👻', bg: '#4dd0e1' },
        { name: 'Bot',   emoji: '🤖', bg: '#90a4ae' },
        { name: 'Frog',  emoji: '🐸', bg: '#81c784' },
        { name: 'Monk',  emoji: '🐵', bg: '#a1887f' },
        { name: 'Uni',   emoji: '🦄', bg: '#f06292' },
        { name: 'Drago', emoji: '🐲', bg: '#7986cb' },
        { name: 'Alien', emoji: '👽', bg: '#aed581' }
    ],

    // SAMPLE weekly release schedule for the Calendar screen (placeholder
    // titles/times — real airing data replaces this in the AniList step).
    // Keyed by JS weekday: 0 = Sunday ... 6 = Saturday.
    SAMPLE_SCHEDULE: {
        0: [ { title: 'One Piece', ep: 'EP 1150', time: '09:30 AM', hue: 8 }, { title: 'Solo Leveling', ep: 'EP 9', time: '11:30 PM', hue: 262 } ],
        1: [ { title: 'Bleach: Thousand-Year Blood War', ep: 'EP 12', time: '11:30 PM', hue: 210 } ],
        2: [ { title: 'Cyberpunk: Edgerunners 2', ep: 'EP 4', time: '10:00 PM', hue: 318 } ],
        3: [ { title: 'Frieren: Beyond Journey\u2019s End', ep: 'EP 18', time: '11:00 PM', hue: 160 }, { title: 'The Apothecary Diaries', ep: 'EP 20', time: '10:30 PM', hue: 96 } ],
        4: [ { title: 'Jujutsu Kaisen', ep: 'EP 15', time: '11:56 PM', hue: 275 } ],
        5: [ { title: 'Spy x Family', ep: 'EP 11', time: '11:00 PM', hue: 340 }, { title: 'Chainsaw Man', ep: 'EP 7', time: '09:00 PM', hue: 24 } ],
        6: [ { title: 'Demon Slayer', ep: 'EP 6', time: '11:15 PM', hue: 190 }, { title: 'My Happy Marriage', ep: 'Special', time: '08:00 PM', hue: 350 } ]
    },

    // SAMPLE catalog for Home / Details (Stage 4). Placeholder meta + gradient
    // poster art — the AniList step replaces all of this with real data.
    SAMPLE_TITLES: [
        { id: 'frieren',   title: 'Frieren: Beyond Journey\u2019s End', year: 2023, score: 9.4, eps: 28,   type: 'TV',    hue: 160, genres: ['Adventure', 'Drama', 'Fantasy'], synopsis: 'An elf mage outlives her hero party and sets out to understand the humans she barely knew.' },
        { id: 'solo',      title: 'Solo Leveling',                      year: 2024, score: 8.5, eps: 25,   type: 'TV',    hue: 262, genres: ['Action', 'Fantasy'], synopsis: 'The weakest hunter of all mankind gains a system that lets him level up without limit.' },
        { id: 'jjk',       title: 'Jujutsu Kaisen',                     year: 2020, score: 8.6, eps: 47,   type: 'TV',    hue: 275, genres: ['Action', 'Supernatural'], synopsis: 'A student swallows a cursed finger and joins a school of sorcerers who fight curses.' },
        { id: 'bleach',    title: 'Bleach: Thousand-Year Blood War',    year: 2022, score: 9.0, eps: 40,   type: 'TV',    hue: 210, genres: ['Action', 'Supernatural'], synopsis: 'The Soul Society faces its oldest enemy in a war a thousand years in the making.' },
        { id: 'onepiece',  title: 'One Piece',                          year: 1999, score: 8.9, eps: 1150, type: 'TV',    hue: 8,   genres: ['Adventure', 'Action', 'Comedy'], synopsis: 'Luffy and the Straw Hats sail the Grand Line hunting the legendary One Piece.' },
        { id: 'demonslayer', title: 'Demon Slayer',                     year: 2019, score: 8.7, eps: 55,   type: 'TV',    hue: 190, genres: ['Action', 'Supernatural'], synopsis: 'Tanjiro joins the Demon Slayer Corps to avenge his family and save his sister.' },
        { id: 'spyfamily', title: 'Spy x Family',                       year: 2022, score: 8.4, eps: 37,   type: 'TV',    hue: 340, genres: ['Comedy', 'Action', 'Slice of Life'], synopsis: 'A spy, an assassin and a telepath form a fake family — none know the others\u2019 secrets.' },
        { id: 'chainsaw',  title: 'Chainsaw Man',                       year: 2022, score: 8.5, eps: 12,   type: 'TV',    hue: 24,  genres: ['Action', 'Horror'], synopsis: 'A broke devil hunter merges with his pet devil and becomes Chainsaw Man.' },
        { id: 'aot',       title: 'Attack on Titan',                    year: 2013, score: 9.0, eps: 89,   type: 'TV',    hue: 20,  genres: ['Action', 'Drama'], synopsis: 'Humanity hides behind walls from man-eating Titans — until the walls fall.' },
        { id: 'apothecary', title: 'The Apothecary Diaries',            year: 2023, score: 8.6, eps: 48,   type: 'TV',    hue: 96,  genres: ['Drama', 'Mystery'], synopsis: 'A poison-obsessed apothecary solves mysteries inside the imperial court.' },
        { id: 'edgerunners', title: 'Cyberpunk: Edgerunners',           year: 2022, score: 8.3, eps: 10,   type: 'TV',    hue: 318, genres: ['Sci-Fi', 'Action'], synopsis: 'A street kid in Night City gambles everything on becoming an edgerunner.' },
        { id: 'yourname',  title: 'Your Name',                          year: 2016, score: 8.9, eps: 1,    type: 'Movie', hue: 230, genres: ['Romance', 'Drama', 'Fantasy'], synopsis: 'Two teenagers who have never met begin waking up in each other\u2019s bodies.' },
        { id: 'spirited',  title: 'Spirited Away',                      year: 2001, score: 8.8, eps: 1,    type: 'Movie', hue: 130, genres: ['Fantasy', 'Adventure'], synopsis: 'A girl trapped in a bathhouse for spirits must work to free her parents.' },
        { id: 'mhm',       title: 'My Happy Marriage',                  year: 2023, score: 8.2, eps: 25,   type: 'TV',    hue: 350, genres: ['Romance', 'Drama', 'Fantasy'], synopsis: 'A mistreated daughter is married off to a commander rumoured to be cold-hearted.' }
    ],

    // No default profile (2026-10-23 ruling): the app seeds NOTHING.
    // A new user creates their first profile to use the app; the
    // first profile created becomes Primary. Limit: 3 profiles.
    DEFAULT_PROFILES: [],
    PROFILE_LIMIT: 3,

    // Per-profile settings defaults (names mirror the real app's settings map)
    DEFAULT_SETTINGS: {
        // Appearance / theme
        accentId: 'white',
        accentGradient: false,
        amoledBlack: false,

        // Playback page (real app)
        loadingOverlay: true,
        contentWarnings: true,
        preferredAudioLanguage: 'Device language',
        secondaryAudioLanguage: 'None',
        preferredSubtitleLanguage: 'English',
        secondarySubtitleLanguage: 'None',
        stripSDH: false,
        useForcedSubtitles: false,
        preferredLanguagesOnly: false,
        subtitleSize: 18,
        subtitleOffset: 20,
        subtitleBold: false,

        // AniSkip (anime skipping — api.aniskip.com community timestamps)
        aniskipEnabled: true,
        aniskipAutoOp: false,
        aniskipAutoEd: false,
        aniskipAutoRecap: false,
        aniskipRecap: true,
        aniskipShowButton: true,

        // Tracking sources (real app Tracking page)
        librarySource: 'Auto',
        watchProgressSource: 'Local',
        continueWatchingSource: 'tracked',   // 'tracked' | 'cloud' (Fix 8b selector)

        // Connected Services (real app)
        cloudLibrary: false,
        resolvePlayableLinks: false,

        // Layout
        navBarStyle: 'floating_pill',
        navBarPosition: 'bottom',       // 'bottom' | 'top'
        liquidGlassTab: true,
        heroStyle: 'full_bleed',        // 'full_bleed' | 'card'
        heroTrailerAutoplay: false,
        heroTrailerSound: false,
        heroTrailerDelay: 'Instant',
        dynamicBackgroundColor: false,
        catalogAccentUnderline: false,
        detailBudgetRevenue: true,
        detailIconActionRow: true,
        detailTrailerSound: false,
        streamsSearchBar: false,

        // Playback
        swipeToSeek: true,
        seekInterval: 5,   // centre seek buttons + ArrowLeft/Right, seconds (5/10/15/30 via slider)
        miniPlayer: false,
        privateViewing: false,
        autoFullscreen: true,
        includeWatchedRandom: false,
        seekBarThumbnails: true,
        movieRecommendations: true,
        bufferMin: 15,
        bufferMax: 50,
        bufferStart: 2.5,
        bufferAfterStall: 5,
        bufferBack: 30,
        bufferTargetSize: 64,
        subtitleBgTransparency: 50,

        // Content & Discovery
        tmdbEpisodeRatings: true,

        // Downloads
        showDownloadButton: true,
        allowMobileData: false,
        downloadLocation: 'Internal Storage',

        // Integrations (Live TV)
        showLiveTvInNav: true,
        liveTvConfigured: false,        // true once an M3U / Xtream / Stalker source is added
        epgAutoDetect: true,

        // Notifications
        episodeReleaseAlerts: false,

        // About
        updateChannel: 'Beta'
    }
};
