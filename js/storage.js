// ============================================================
// GAnime — storage.js (Step 2: core foundation)
// The ONLY file that touches localStorage. Everything else
// asks Storage. Keys are namespaced "ganime_".
// ============================================================
const Storage = {
    KEYS: {
        AUTH: 'ganime_auth_state',
        PROFILES: 'ganime_profiles_list',
        ACTIVE_PROFILE: 'ganime_active_profile_id'
    },

    _read(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : fallback;
        } catch (e) {
            return fallback;
        }
    },

    _write(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
        } catch (e) {
            /* Quota failure: NEVER evict another store silently.
               An old version deleted ganime_epdata here, wiping
               the episode cache to save an unrelated write. Log
               and continue — the session stays usable, only this
               write is lost. */
            try { console.warn('[GAnime] storage write failed for ' + key + ': ' + (e && e.message)); } catch (e2) {}
        }
        /* Phase 2 cloud sync (2026-10-26): user-data writes mark
           the store dirty so Sync pushes a batched copy after a
           short debounce. Tracking keys are deliberately NOT
           matched here (tokens never sync); caches are not either.
           Guarded for the script order (storage loads before
           firestore.js) and for applies (Sync skips while applying). */
        try {
            if (typeof Sync !== 'undefined' && Sync.markDirty
                && (key.startsWith('ganime_profiles_')
                    || /^ganime_(settings|addons|watched|locallib|mylist)_/.test(key))) {
                Sync.markDirty(key);
            }
        } catch (e) {}
    },

    /* --- Auth --- */
    getAuthState() {
        return this._read(this.KEYS.AUTH, { signedIn: false, isGuest: false, email: null });
    },
    saveAuthState(state) {
        this._write(this.KEYS.AUTH, state);
    },
    clearAuthState() {
        localStorage.removeItem(this.KEYS.AUTH);
    },

    /* --- Profiles: namespaced per session owner (2026-10-26 fix) ---
       Signed-in users and guests used to share ONE profile list, so
       after sign-out, "Continue without an account" opened the
       account's profiles with no password. Now the list (and the
       active id) live under the session owner: a Firebase uid when
       signed in, "guest" otherwise. Every caller goes through these
       methods, so sync, picker, addons and sharing all follow.
       Legacy: the old shared key is adopted ONCE, and only by a
       signed-in session (copied, never moved, so it stays as a
       backup). Guest sessions never adopt it and start empty. */
    _ownerSuffix() {
        try {
            const a = this.getAuthState();
            if (a && a.signedIn && !a.isGuest && a.uid) return String(a.uid);
        } catch (e) {}
        return 'guest';
    },
    _profilesKey() {
        return 'ganime_profiles_' + this._ownerSuffix();
    },
    _activeKey() {
        return 'ganime_active_' + this._ownerSuffix();
    },
    /* Bug 1 (2026-10-26 audit): the legacy shared list belonged to
       whoever used this browser before namespacing. A DIFFERENT
       signed-in user must never adopt it — that is account bleed.
       Adopt only when no other account has used this browser:
       no recorded legacy owner (or it matches this uid), and no
       other namespaced list exists. The first adopter records
       itself as the legacy owner. */
    _mayAdoptLegacy(uid) {
        try {
            const owner = localStorage.getItem('ganime_legacy_owner');
            if (owner && owner !== String(uid)) return false;
            const mine = 'ganime_profiles_' + uid;
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const k = localStorage.key(i);
                    if (k && k.indexOf('ganime_profiles_') === 0
                        && k !== 'ganime_profiles_list'
                        && k !== 'ganime_profiles_guest'
                        && k !== mine) return false;
                }
            } catch (e) {}
            try { localStorage.setItem('ganime_legacy_owner', String(uid)); } catch (e) {}
            return true;
        } catch (e) { return false; }
    },
    getProfiles() {
        // Version marker only — profiles are NEVER (re)seeded.
        // No stored list = no profiles yet (create-first flow).
        const version = localStorage.getItem('ganime_data_version');
        if (version !== String(Config.DATA_VERSION)) {
            localStorage.setItem('ganime_data_version', String(Config.DATA_VERSION));
        }
        const key = this._profilesKey();
        let list = this._read(key, null);
        if (list === null) {
            /* First run under namespacing: a signed-in session
               adopts the legacy shared list once (copy), and only
               when no other account has used this browser (Bug 1
               guard in _mayAdoptLegacy). Guest never adopts — its
               list starts empty. */
            try {
                const a = this.getAuthState();
                if (a && a.signedIn && !a.isGuest && a.uid) {
                    const legacy = this._read(this.KEYS.PROFILES, null);
                    if (Array.isArray(legacy) && this._mayAdoptLegacy(a.uid)) {
                        list = legacy;
                        this._write(key, legacy);
                    }
                }
            } catch (e) {}
            if (list === null) list = [];
        }
        return list || [];
    },
    saveProfiles(profiles) {
        this._write(this._profilesKey(), profiles);
    },
    getProfile(id) {
        return this.getProfiles().find(p => p.id === id) || null;
    },
    getActiveProfileId() {
        const id = localStorage.getItem(this._activeKey()) || '';
        if (id) return id;
        /* First run under namespacing: adopt the legacy active id
           only when it points at a profile in THIS list, so a
           refresh still resumes where you were. */
        try {
            const a = this.getAuthState();
            if (a && a.signedIn && !a.isGuest && a.uid) {
                const legacyId = localStorage.getItem(this.KEYS.ACTIVE_PROFILE) || '';
                if (legacyId && this.getProfiles().some(p => p.id === legacyId)) {
                    localStorage.setItem(this._activeKey(), legacyId);
                    return legacyId;
                }
            }
        } catch (e) {}
        return '';
    },
    setActiveProfileId(id) {
        if (id) localStorage.setItem(this._activeKey(), id);
        else localStorage.removeItem(this._activeKey());
        /* Phase 2: the active profile is part of the cloud doc, so
           a profile switch schedules a push too. */
        try { if (typeof Sync !== 'undefined' && Sync.markDirty) Sync.markDirty(this._profilesKey()); } catch (e) {}
    },
    clearActiveProfileId() {
        localStorage.removeItem(this._activeKey());
    },
    getActiveProfile() {
        return this.getProfile(this.getActiveProfileId()) || this.getProfiles()[0];
    },

    /* --- Settings (per profile: ganime_settings_<profileId>) --- */
    _settingsKey(profileId) {
        return 'ganime_settings_' + (profileId || this.getActiveProfileId());
    },
    getSettings(profileId) {
        const saved = this._read(this._settingsKey(profileId), {});
        return { ...Config.DEFAULT_SETTINGS, ...saved };
    },
    saveSettings(settings, profileId) {
        /* Belt-and-suspenders (2026-10-24): settings are MERGED,
           never replaced — a partial object used to wipe the whole
           file (accentId included), which is how the theme kept
           falling back to white after a reload. */
        const key = this._settingsKey(profileId);
        const current = this._read(key, {});
        this._write(key, { ...current, ...settings });
    },
    updateSetting(key, value, profileId) {
        const settings = this.getSettings(profileId);
        settings[key] = value;
        this.saveSettings(settings, profileId);
        return settings;
    },

    /* --- Addons (per profile: ganime_addons_<profileId>) ---
       A non-primary profile with "Use Primary Addons" ON reads and
       writes the PRIMARY profile's list (the sharing rule). */
    getAddonOwnerId(profileId) {
        const pid = profileId || this.getActiveProfileId();
        const profiles = this.getProfiles();
        const me = profiles.find(p => p.id === pid);
        const primary = profiles.find(p => p.isPrimary) || profiles[0];
        if (me && primary && me.id !== primary.id && me.usePrimaryAddons) return primary.id;
        return pid;
    },
    getAddons(profileId) {
        return this._read('ganime_addons_' + this.getAddonOwnerId(profileId), []);
    },
    saveAddons(addons, profileId) {
        this._write('ganime_addons_' + this.getAddonOwnerId(profileId), addons);
    },

    /* --- Stream ID map (global: ganime_idmap) ---
       AniList id -> { imdb, kitsu } resolved once via Jikan/Kitsu
       and cached, so addon stream lookups stay fast. */
    getIdMap() {
        return this._read('ganime_idmap', {});
    },
    saveIdMap(map) {
        this._write('ganime_idmap', map);
    },

    /* --- Episode data cache (global: ganime_epdata) ---
       AniList id -> { eps: [{n, title, img, date, runtime, overview}] }
       from api.ani.zip, fetched once per title for the Details
       page's Minimal / Detailed episode designs. */
    getEpisodeData(anilistId) {
        const all = this._read('ganime_epdata', {});
        return all[anilistId] || null;
    },
    saveEpisodeData(anilistId, data) {
        const all = this._read('ganime_epdata', {});
        all[anilistId] = data;
        /* LRU cap: episode caches are re-fetchable, but a One
           Piece-sized entry is huge — keep the 40 most recent. */
        const order = this._read('ganime_epdata_order', []).filter(id => String(id) !== String(anilistId));
        order.push(anilistId);
        while (order.length > 40) {
            const evict = order.shift();
            delete all[evict];
        }
        this._write('ganime_epdata_order', order);
        this._write('ganime_epdata', all);
    },

    /* --- Watched episodes (per profile: ganime_watched_<pid>) ---
       v2: { titleId: { eps: [n], meta: {title, poster, cover, total,
       anilistId, year, hue} | null, updatedAt } } — drives Watching
       Progress AND Home's Continue Watching (the meta snapshot lets
       CW render even before the title is cached this session).
       Legacy v1 entries (plain episode arrays) normalize on read. */
    _watchedKey(profileId) {
        return 'ganime_watched_' + (profileId || this.getActiveProfileId());
    },
    getWatched(profileId) {
        const raw = this._read(this._watchedKey(profileId), {});
        const out = {};
        Object.keys(raw || {}).forEach(id => {
            const v = raw[id];
            if (Array.isArray(v)) out[id] = { eps: v.slice(), meta: null, updatedAt: 0 };
            else if (v && Array.isArray(v.eps)) out[id] = { eps: v.eps.slice(), meta: v.meta || null, updatedAt: v.updatedAt || 0 };
        });
        return out;
    },
    setWatchedEps(titleId, eps, meta, profileId) {
        const pid = profileId || this.getActiveProfileId();
        const map = this.getWatched(pid);
        const entry = map[titleId] || { eps: [], meta: null, updatedAt: 0 };
        const nextEps = (eps || []).slice().sort((a, b) => a - b);
        /* Tombstones for removed episodes (Gemini audit 2026-10-27,
           verified against _mergeWatched): without these, the next
           cloud merge unions the cloud copy's episodes back and an
           unwatch resurrects on sync. */
        try {
            if (typeof Sync !== 'undefined' && Sync.recordDeleted) {
                (entry.eps || []).forEach(oldEp => {
                    if (!nextEps.includes(oldEp)) Sync.recordDeleted('watched', pid, titleId, oldEp);
                });
            }
        } catch (e) {}
        entry.eps = nextEps;
        if (meta) entry.meta = { ...(entry.meta || {}), ...meta };
        entry.updatedAt = Date.now();
        map[titleId] = entry;
        this._write(this._watchedKey(pid), map);
        // Any fresh watch clears a local unwatch flag for the title.
        if (eps && eps.length) this.setUnwatched(titleId, false, pid);
        return entry.eps;
    },
    /* Local unwatch flags (2026-10-27): a title the user explicitly
       unwatched here. Local-only by design — collectLocal reads
       explicit keys, so this key never syncs, and tracker progress
       must not resurrect the title on refresh. */
    _unwatchedKey(profileId) {
        return 'ganime_unwatched_' + (profileId || this.getActiveProfileId());
    },
    getUnwatched(profileId) {
        return this._read(this._unwatchedKey(profileId), {}) || {};
    },
    setUnwatched(titleId, on, profileId) {
        const pid = profileId || this.getActiveProfileId();
        const map = this.getUnwatched(pid);
        if (on) map[titleId] = 1;
        else delete map[titleId];
        this._write(this._unwatchedKey(pid), map);
    },
    toggleWatched(titleId, ep, meta, profileId) {
        const pid = profileId || this.getActiveProfileId();
        const map = this.getWatched(pid);
        const entry = map[titleId] || { eps: [], meta: null, updatedAt: 0 };
        if (entry.eps.includes(ep)) {
            entry.eps = entry.eps.filter(n => n !== ep);
            /* Sync tombstone (2026-10-26): without this, the
               union merge resurrects the un-marked episode from
               the other device's copy on the next sync. */
            try { if (typeof Sync !== 'undefined' && Sync.recordDeleted) Sync.recordDeleted('watched', pid, titleId, ep); } catch (e) {}
        } else entry.eps.push(ep);
        if (meta) entry.meta = { ...(entry.meta || {}), ...meta };
        entry.updatedAt = Date.now();
        map[titleId] = entry;
        this._write(this._watchedKey(pid), map);
        // Watching an episode again clears a local unwatch flag.
        if (entry.eps.length) this.setUnwatched(titleId, false, pid);
        return entry.eps;
    },

    /* --- Local library (per profile: ganime_locallib_<pid>) ---
       The app's OWN library (the "Local" source): statuses the
       user sets via Add to Library, plus saved episodes.
       Shape: { [titleId]: { status, savedEps: [n], meta, updatedAt } } */
    _localLibKey(profileId) {
        return 'ganime_locallib_' + (profileId || this.getActiveProfileId());
    },
    getLocalLibrary(profileId) {
        return this._read(this._localLibKey(profileId), {}) || {};
    },
    saveLocalLibrary(map, profileId) {
        this._write(this._localLibKey(profileId), map || {});
    },
    getLocalEntry(titleId, profileId) {
        return this.getLocalLibrary(profileId)[titleId] || null;
    },
    setLocalStatus(titleId, status, meta, profileId) {
        const map = this.getLocalLibrary(profileId);
        const entry = map[titleId] || { status: null, savedEps: [], meta: null, updatedAt: 0 };
        entry.status = status;
        if (meta) entry.meta = { ...(entry.meta || {}), ...meta };
        entry.updatedAt = Date.now();
        if (!entry.status && !(entry.savedEps || []).length) {
            delete map[titleId];
            /* Sync tombstone (2026-10-26): whole-entry delete. */
            try { if (typeof Sync !== 'undefined' && Sync.recordDeleted) Sync.recordDeleted('locallib', profileId || this.getActiveProfileId(), titleId); } catch (e) {}
        } else map[titleId] = entry;
        this.saveLocalLibrary(map, profileId);
        return entry;
    },
    toggleSavedEp(titleId, ep, meta, profileId) {
        const map = this.getLocalLibrary(profileId);
        const entry = map[titleId] || { status: null, savedEps: [], meta: null, updatedAt: 0 };
        const eps = entry.savedEps || [];
        entry.savedEps = eps.includes(ep) ? eps.filter(n => n !== ep) : eps.concat([ep]);
        if (meta) entry.meta = { ...(entry.meta || {}), ...meta };
        entry.updatedAt = Date.now();
        if (!entry.status && !entry.savedEps.length) {
            delete map[titleId];
            /* Sync tombstone (2026-10-26): whole-entry delete. */
            try { if (typeof Sync !== 'undefined' && Sync.recordDeleted) Sync.recordDeleted('locallib', profileId || this.getActiveProfileId(), titleId); } catch (e) {}
        } else map[titleId] = entry;
        this.saveLocalLibrary(map, profileId);
        return entry.savedEps;
    },

    /* --- Tracking connections (per profile: ganime_tracking_<pid>) ---
       { anilist: { clientId, accessToken,
       expiresAt, user: {id, name, avatar} } } — NO client secret is
       ever stored here (AniList implicit grant uses none); tokens
       never leave this device except to anilist.co itself. */
    getTracking(profileId) {
        return this._read('ganime_tracking_' + (profileId || this.getActiveProfileId()), {});
    },
    saveTracking(data, profileId) {
        this._write('ganime_tracking_' + (profileId || this.getActiveProfileId()), data);
    },
    getAnilistConn(profileId) {
        return this.getTracking(profileId).anilist || null;
    },
    saveAnilistConn(conn, profileId) {
        const all = this.getTracking(profileId);
        if (conn) all.anilist = conn; else delete all.anilist;
        this.saveTracking(all, profileId);
    },

    getSimklConn(profileId) {
        return this.getTracking(profileId).simkl || null;
    },
    saveSimklConn(conn, profileId) {
        const all = this.getTracking(profileId);
        if (conn) all.simkl = conn; else delete all.simkl;
        this.saveTracking(all, profileId);
    },
    getMalConn(profileId) {
        return this.getTracking(profileId).mal || null;
    },
    saveMalConn(conn, profileId) {
        const all = this.getTracking(profileId);
        if (conn) {
            /* Tracker layer Phase 1: the list cache lives in
               TrackStore now, never in the token blob — strip it
               here so no call site can re-inflate the blob by
               spreading an old conn (the blob rewrite on every
               fetch was eating token refreshes on quota errors). */
            const clean = { ...conn };
            delete clean.listsCache;
            all.mal = clean;
        } else delete all.mal;
        this.saveTracking(all, profileId);
    },

    /* --- Episode design preference (global) --- */
    getEpDesign() {
        return localStorage.getItem('ganime_ep_design') || 'minimal';
    },
    saveEpDesign(design) {
        localStorage.setItem('ganime_ep_design', design);
        try { if (typeof Sync !== 'undefined' && Sync.markDirty) Sync.markDirty(this._profilesKey()); } catch (e) {}
    },

    /* --- My List (per profile: ganime_mylist_<profileId>) --- */
    getMyList(profileId) {
        return this._read('ganime_mylist_' + (profileId || this.getActiveProfileId()), []);
    },
    toggleMyList(titleId, profileId) {
        const pid = profileId || this.getActiveProfileId();
        let list = this.getMyList(pid);
        if (list.includes(titleId)) {
            list = list.filter(id => id !== titleId);
            /* Sync tombstone (2026-10-26): see toggleWatched. */
            try { if (typeof Sync !== 'undefined' && Sync.recordDeleted) Sync.recordDeleted('mylist', pid, titleId); } catch (e) {}
        } else {
            list.push(titleId);
        }
        this._write('ganime_mylist_' + pid, list);
        return list;
    }
};
