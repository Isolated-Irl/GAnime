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
            /* Quota: the episode cache is the bulkiest, most
               disposable store — evict it and retry once. */
            try {
                if (key !== 'ganime_epdata') localStorage.removeItem('ganime_epdata');
                localStorage.setItem(key, JSON.stringify(value));
            } catch (e2) { /* storage full/blocked — session stays usable */ }
        }
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

    /* --- Profiles --- */
    getProfiles() {
        // Version marker only — profiles are NEVER (re)seeded.
        // No stored list = no profiles yet (create-first flow).
        const version = localStorage.getItem('ganime_data_version');
        if (version !== String(Config.DATA_VERSION)) {
            localStorage.setItem('ganime_data_version', String(Config.DATA_VERSION));
        }
        return this._read(this.KEYS.PROFILES, []) || [];
    },
    saveProfiles(profiles) {
        this._write(this.KEYS.PROFILES, profiles);
    },
    getProfile(id) {
        return this.getProfiles().find(p => p.id === id) || null;
    },
    getActiveProfileId() {
        return localStorage.getItem(this.KEYS.ACTIVE_PROFILE) || '';
    },
    setActiveProfileId(id) {
        if (id) localStorage.setItem(this.KEYS.ACTIVE_PROFILE, id);
        else localStorage.removeItem(this.KEYS.ACTIVE_PROFILE);
    },
    clearActiveProfileId() {
        localStorage.removeItem(this.KEYS.ACTIVE_PROFILE);
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
        entry.eps = (eps || []).slice().sort((a, b) => a - b);
        if (meta) entry.meta = { ...(entry.meta || {}), ...meta };
        entry.updatedAt = Date.now();
        map[titleId] = entry;
        this._write(this._watchedKey(pid), map);
        return entry.eps;
    },
    toggleWatched(titleId, ep, meta, profileId) {
        const pid = profileId || this.getActiveProfileId();
        const map = this.getWatched(pid);
        const entry = map[titleId] || { eps: [], meta: null, updatedAt: 0 };
        if (entry.eps.includes(ep)) entry.eps = entry.eps.filter(n => n !== ep);
        else entry.eps.push(ep);
        if (meta) entry.meta = { ...(entry.meta || {}), ...meta };
        entry.updatedAt = Date.now();
        map[titleId] = entry;
        this._write(this._watchedKey(pid), map);
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
        if (!entry.status && !(entry.savedEps || []).length) delete map[titleId];
        else map[titleId] = entry;
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
        if (!entry.status && !entry.savedEps.length) delete map[titleId];
        else map[titleId] = entry;
        this.saveLocalLibrary(map, profileId);
        return entry.savedEps;
    },

    /* --- Tracking connections (per profile: ganime_tracking_<pid>) ---
       { anilist: { clientId, clientSecret, accessToken, refreshToken,
       expiresAt, user: {id, name, avatar} } } — the secret and tokens
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
        if (conn) all.mal = conn; else delete all.mal;
        this.saveTracking(all, profileId);
    },

    /* --- Episode design preference (global) --- */
    getEpDesign() {
        return localStorage.getItem('ganime_ep_design') || 'minimal';
    },
    saveEpDesign(design) {
        localStorage.setItem('ganime_ep_design', design);
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
        } else {
            list.push(titleId);
        }
        this._write('ganime_mylist_' + pid, list);
        return list;
    }
};
