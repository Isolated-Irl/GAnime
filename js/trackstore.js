// ============================================================
// GAnime — trackstore.js (Tracker layer, Phase 1: storage split)
// Persisted tracker data, separate from the token blob.
//
// The old design kept MAL's whole list cache (hundreds of titles
// with full synopses) inside ganime_tracking_<pid> next to the
// tokens, and rewrote that blob on every list fetch — so a quota
// error could eat a token refresh, and Storage._write's old
// quota fallback silently deleted the episode cache. This module
// is the split:
//
//   lists   — slim list entries, per provider + profile
//   titles  — hydrated media, keyed by malId and anilistId
//   outbox  — pushes waiting for the network (Phase 6)
//   pending — latest unconfirmed marks, per title (Phase 5)
//
// Primary store is IndexedDB (large quota, no localStorage size
// pressure). Fallback is separate localStorage keys — never the
// token blob. All methods are async and never throw for storage
// reasons; a failed write logs a warning and resolves empty.
// Slim entry shape (exactly these fields, nothing else):
//   { entryId, status, progress, score, updatedAt, createdAt,
//     completedAt, malId, anilistId, title, poster, eps, nextEp,
//     year } — no synopsis, genres, trailer, or banner.
// ============================================================
const TrackStore = {
    DB_NAME: 'ganime-trackstore',
    DB_VERSION: 1,
    _db: null,
    _ready: null,
    _lsPrefix: 'ganime_ts_',

    init() {
        if (this._ready) return this._ready;
        this._ready = (async () => {
            try {
                if (typeof indexedDB === 'undefined') return false;
                this._db = await new Promise((resolve, reject) => {
                    const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
                    req.onupgradeneeded = () => {
                        const db = req.result;
                        if (!db.objectStoreNames.contains('lists')) db.createObjectStore('lists');
                        if (!db.objectStoreNames.contains('titles')) db.createObjectStore('titles');
                        if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'id' });
                        if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending');
                    };
                    req.onsuccess = () => resolve(req.result);
                    req.onerror = () => reject(req.error);
                });
                return true;
            } catch (e) {
                this._db = null;
                return false;
            }
        })();
        return this._ready;
    },

    /* ---------- IndexedDB helpers ---------- */
    _idb(store, mode, run) {
        return new Promise((resolve, reject) => {
            try {
                const tx = this._db.transaction(store, mode);
                const os = tx.objectStore(store);
                const req = run(os);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
                tx.onerror = () => reject(tx.error);
            } catch (e) { reject(e); }
        });
    },

    /* ---------- localStorage fallback helpers ---------- */
    _lsGet(key) {
        try {
            const raw = localStorage.getItem(key);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    },
    _lsPut(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            try { console.warn('[GAnime] TrackStore write failed for ' + key + ': ' + (e && e.message)); } catch (e2) {}
            return false;
        }
    },
    _lsDel(key) {
        try { localStorage.removeItem(key); } catch (e) {}
    },

    /* ---------- Slim / expand (pure, synchronous) ---------- */
    slimEntry(e) {
        const m = (e && e.media) || {};
        const slim = {
            entryId: e ? e.entryId : null,
            status: e ? e.status : null,
            progress: e ? (e.progress || 0) : 0,
            score: e ? (e.score || 0) : 0,
            updatedAt: e ? (e.updatedAt || 0) : 0,
            createdAt: e ? (e.createdAt || 0) : 0,
            completedAt: e ? (e.completedAt || 0) : 0,
            malId: m.malId || null,
            anilistId: m.anilistId || null,
            title: m.title || '',
            poster: m.poster || '',
            eps: m.eps || 0,
            nextEp: m.nextEp || null,
            year: m.year || ''
        };
        // Phase 3: a fallback entry that still needs hydration keeps
        // its flag through the store, so a cold open retries it
        // instead of treating the fallback as final. Only when true
        // — the 13-field shape stays clean otherwise.
        if (m.needsHydration) slim.needsHydration = true;
        return slim;
    },
    slimLists(lists) {
        const out = {};
        Object.keys(lists || {}).forEach(k => {
            const g = lists[k] || {};
            out[k] = { name: g.name || k, entries: (g.entries || []).map(e => this.slimEntry(e)) };
        });
        return out;
    },
    expandEntry(s) {
        /* Rebuilds a renderer-ready entry from a slim one. The
           average score is NOT stored in the slim shape, so cards
           show "—" for it until a hydrated title lands (Phase 3);
           a wrong score would be worse than an unknown one. The
           gradient hue is derived exactly like mapMedia does, so
           fallback cards keep their catalog colours. */
        const hue = s.anilistId ? ((s.anilistId * 47) % 360) : 210;
        const media = {
            id: s.anilistId ? ('a' + s.anilistId) : (s.malId ? ('mal_' + s.malId) : ''),
            anilistId: s.anilistId || null,
            malId: s.malId || null,
            title: s.title || '',
            poster: s.poster || '',
            eps: s.eps || 0,
            nextEp: s.nextEp || null,
            year: s.year || '',
            score: '—',
            hue: hue
        };
        if (s.needsHydration) media.needsHydration = true;
        return {
            entryId: s.entryId,
            status: s.status,
            progress: s.progress || 0,
            score: s.score || 0,
            updatedAt: s.updatedAt || 0,
            createdAt: s.createdAt || 0,
            completedAt: s.completedAt || 0,
            media: media
        };
    },
    expandLists(slim) {
        const out = {};
        Object.keys(slim || {}).forEach(k => {
            const g = slim[k] || {};
            out[k] = { name: g.name || k, entries: (g.entries || []).map(e => this.expandEntry(e)) };
        });
        return out;
    },

    /* ---------- Lists ---------- */
    async getList(provider, pid) {
        await this.init();
        const key = provider + ':' + pid;
        try {
            if (this._db) {
                const row = await this._idb('lists', 'readonly', os => os.get(key));
                return row || null;
            }
            return this._lsGet(this._lsPrefix + 'lists_' + provider + '_' + pid);
        } catch (e) { return null; }
    },
    async putList(provider, pid, lists) {
        await this.init();
        const row = { lists: this.slimLists(lists), at: Date.now() };
        const key = provider + ':' + pid;
        try {
            if (this._db) await this._idb('lists', 'readwrite', os => os.put(row, key));
            else this._lsPut(this._lsPrefix + 'lists_' + provider + '_' + pid, row);
        } catch (e) {
            try { console.warn('[GAnime] TrackStore putList failed: ' + (e && e.message)); } catch (e2) {}
        }
    },
    async deleteList(provider, pid) {
        await this.init();
        const key = provider + ':' + pid;
        try {
            if (this._db) await this._idb('lists', 'readwrite', os => os.delete(key));
            else this._lsDel(this._lsPrefix + 'lists_' + provider + '_' + pid);
        } catch (e) {}
    },

    /* ---------- Titles (hydrated media) ---------- */
    async getTitleByMalId(malId) {
        return this._getTitle('mal:' + malId);
    },
    async getTitleByAnilistId(anilistId) {
        return this._getTitle('anilist:' + anilistId);
    },
    async _getTitle(key) {
        await this.init();
        try {
            if (this._db) return await this._idb('titles', 'readonly', os => os.get(key)) || null;
            return this._lsGet(this._lsPrefix + 'title_' + key);
        } catch (e) { return null; }
    },
    async putTitle(media) {
        await this.init();
        if (!media) return;
        const row = { media: media, fetchedAt: Date.now() };
        const keys = [];
        if (media.malId) keys.push('mal:' + media.malId);
        if (media.anilistId) keys.push('anilist:' + media.anilistId);
        try {
            if (this._db) {
                for (const k of keys) await this._idb('titles', 'readwrite', os => os.put(row, k));
            } else {
                for (const k of keys) this._lsPut(this._lsPrefix + 'title_' + k, row);
            }
        } catch (e) {
            try { console.warn('[GAnime] TrackStore putTitle failed: ' + (e && e.message)); } catch (e2) {}
        }
    },

    /* ---------- Outbox (Phase 6 fills this in) ---------- */
    async getOutbox() {
        await this.init();
        try {
            if (this._db) return await this._idb('outbox', 'readonly', os => os.getAll()) || [];
            const out = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf(this._lsPrefix + 'outbox_') === 0) {
                    const row = this._lsGet(k);
                    if (row) out.push(row);
                }
            }
            return out;
        } catch (e) { return []; }
    },
    async putOutbox(item) {
        await this.init();
        if (!item || !item.id) return;
        try {
            if (this._db) await this._idb('outbox', 'readwrite', os => os.put(item));
            else this._lsPut(this._lsPrefix + 'outbox_' + item.id, item);
        } catch (e) {}
    },
    async deleteOutbox(id) {
        await this.init();
        try {
            if (this._db) await this._idb('outbox', 'readwrite', os => os.delete(id));
            else this._lsDel(this._lsPrefix + 'outbox_' + id);
        } catch (e) {}
    },

    /* ---------- Pending marks (Phase 5 fills this in) ---------- */
    async getPending(titleId) {
        await this.init();
        try {
            if (this._db) return await this._idb('pending', 'readonly', os => os.get(titleId)) || null;
            return this._lsGet(this._lsPrefix + 'pending_' + titleId);
        } catch (e) { return null; }
    },
    async putPending(titleId, data) {
        await this.init();
        try {
            if (this._db) await this._idb('pending', 'readwrite', os => os.put(data, titleId));
            else this._lsPut(this._lsPrefix + 'pending_' + titleId, data);
        } catch (e) {}
    },
    async deletePending(titleId) {
        await this.init();
        try {
            if (this._db) await this._idb('pending', 'readwrite', os => os.delete(titleId));
            else this._lsDel(this._lsPrefix + 'pending_' + titleId);
        } catch (e) {}
    },
    async getAllPending() {
        await this.init();
        try {
            if (this._db) {
                const keys = await this._idb('pending', 'readonly', os => os.getAllKeys());
                const out = [];
                for (const k of (keys || [])) {
                    const v = await this._idb('pending', 'readonly', os => os.get(k));
                    if (v) out.push({ titleId: k, progress: v.progress, status: v.status, at: v.at });
                }
                return out;
            }
            const out = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf(this._lsPrefix + 'pending_') === 0) {
                    const v = this._lsGet(k);
                    if (v) out.push({ titleId: k.slice((this._lsPrefix + 'pending_').length), progress: v.progress, status: v.status, at: v.at });
                }
            }
            return out;
        } catch (e) { return []; }
    },

    /* ---------- One-time migration from the old token blob ---------- */
    async migrateMalListsCache() {
        await this.init();
        let migrated = 0;
        try {
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.indexOf('ganime_tracking_') === 0) keys.push(k);
            }
            for (const k of keys) {
                let all = null;
                try { all = JSON.parse(localStorage.getItem(k)); } catch (e) { all = null; }
                if (all && all.mal && all.mal.listsCache) {
                    const pid = k.slice('ganime_tracking_'.length);
                    await this.putList('MyAnimeList', pid, all.mal.listsCache);
                    const stripped = { ...all.mal };
                    delete stripped.listsCache;
                    stripped.hasList = true;
                    if (typeof Storage !== 'undefined' && Storage.saveMalConn) Storage.saveMalConn(stripped, pid);
                    migrated++;
                }
            }
        } catch (e) { /* migration never blocks boot */ }
        return migrated;
    }
};
