// ============================================================
// GAnime — firestore.js = PHASE 2 CLOUD SYNC (Firestore, REST, no SDK)
// One document per user: users/{uid}. Batched, event-driven only:
// a debounced push after local user-data writes, a boot pull/merge
// after sign-in, and a manual Sync Now in Settings → Account.
// NEVER per second, NEVER on a timer.
//
// What syncs: profiles, per-profile settings, addons, watched,
// local library, My List, episode-design preference, active profile.
// What NEVER syncs (privacy-first, standing rules):
//  - Tracking logins/tokens (AniList / Simkl / MAL) — reconnect
//    those once per browser. Tokens stay in that browser only.
//  - Firebase auth tokens (idToken / refreshToken).
//  - Key-bearing addon URLs: any addon whose manifest URL carries
//    a query string or fragment is left out of the cloud doc
//    entirely (it stays local-only on that device).
//  - Caches (episode data, ID map, home rails, title cache).
//
// Conflict rule (simple, no data loss by design):
//  - New browser with no profiles + cloud has profiles → pull all.
//  - Existing browser + cloud empty → push all.
//  - Both have data → merge per store: watched/library entries are
//    unioned by title (newer per-entry updatedAt wins), My List is
//    unioned, profiles/addons are unioned by id (local wins on a
//    same-id conflict), settings take the store with the newer
//    sync timestamp (tracked in ganime_sync_meta; legacy stores
//    with no timestamp keep local, so a merge never wipes the
//    device you are holding). The merged doc is then pushed back,
//    so both devices converge.
// Security: every request uses the Firebase idToken as a Bearer
// token (no apiKey in the request). Firestore rules must allow
// only `request.auth.uid == userId` on /users/{userId} — see the
// console steps in README-FIRESTORE.md. Without those rules (or
// without a Firestore database at all) sync fails safely with a
// friendly message and local data is untouched.
// ============================================================
const Sync = {
    VERSION: 1,
    META_KEY: 'ganime_sync_meta',
    LAST_KEY: 'ganime_sync_last',
    _applying: false,
    _dirty: false,
    _pushTimer: null,
    _bootPromise: null,
    _bootDone: false,
    lastError: '',
    lastStatus: '',

    /* ---------- Firestore value encoding ---------- */
    _encode(v) {
        if (v === null || v === undefined) return { nullValue: null };
        if (typeof v === 'string') return { stringValue: v };
        if (typeof v === 'boolean') return { booleanValue: v };
        if (typeof v === 'number') {
            return Number.isInteger(v) && Math.abs(v) < 9007199254740991
                ? { integerValue: String(v) } : { doubleValue: v };
        }
        if (Array.isArray(v)) return { arrayValue: { values: v.map(x => this._encode(x)) } };
        if (typeof v === 'object') {
            const fields = {};
            Object.keys(v).forEach(k => { fields[k] = this._encode(v[k]); });
            return { mapValue: { fields } };
        }
        return { nullValue: null };
    },

    _decode(fv) {
        if (!fv || typeof fv !== 'object') return null;
        if ('nullValue' in fv) return null;
        if ('stringValue' in fv) return fv.stringValue;
        if ('booleanValue' in fv) return fv.booleanValue;
        if ('integerValue' in fv) return parseInt(fv.integerValue, 10);
        if ('doubleValue' in fv) return fv.doubleValue;
        if ('arrayValue' in fv) return ((fv.arrayValue && fv.arrayValue.values) || []).map(x => this._decode(x));
        if ('mapValue' in fv) {
            const out = {};
            const fields = (fv.mapValue && fv.mapValue.fields) || {};
            Object.keys(fields).forEach(k => { out[k] = this._decode(fields[k]); });
            return out;
        }
        return null;
    },

    _encodeDoc(obj) {
        const fields = {};
        Object.keys(obj || {}).forEach(k => { fields[k] = this._encode(obj[k]); });
        return { fields };
    },

    _decodeDoc(doc) {
        if (!doc || !doc.fields) return null;
        const out = {};
        Object.keys(doc.fields).forEach(k => { out[k] = this._decode(doc.fields[k]); });
        return out;
    },

    /* ---------- Preconditions ---------- */
    _auth() {
        try { return (typeof Storage !== 'undefined' && Storage.getAuthState()) || null; }
        catch (e) { return null; }
    },

    _projectId() {
        try { return (typeof Config !== 'undefined' && Config.FIREBASE && Config.FIREBASE.projectId) || ''; }
        catch (e) { return ''; }
    },

    _docUrl(uid) {
        return 'https://firestore.googleapis.com/v1/projects/' + encodeURIComponent(this._projectId())
            + '/databases/(default)/documents/users/' + encodeURIComponent(uid);
    },

    _ready() {
        const a = this._auth();
        return !!(a && a.signedIn && !a.isGuest && a.uid && this._projectId()
            && typeof FirebaseAuth !== 'undefined' && FirebaseAuth.getValidIdToken);
    },

    _friendlyHttp(status, bodyText) {
        const t = String(bodyText || '');
        if (status === 404) return 'Firestore database not created yet — follow the console steps in Settings → Account → Cloud Sync, then try again.';
        if (status === 403 || status === 401) {
            if (/PERMISSION_DENIED|not have permission/i.test(t)) return 'Firestore rules are blocking this — set the rules from Settings → Account → Cloud Sync (only your own user document), then try again.';
            if (/API has not been used|SERVICE_DISABLED|Firestore API/i.test(t)) return 'Firestore API is not enabled yet — creating the database in Firebase Console enables it, then try again.';
            return 'Firestore refused the request (HTTP ' + status + ') — check the database and rules, then try again.';
        }
        return 'Cloud sync failed (HTTP ' + status + '). Your local data is untouched.';
    },

    async _token() {
        try { return await FirebaseAuth.getValidIdToken(); } catch (e) { return null; }
    },

    async _getCloud(uid, token) {
        const res = await fetch(this._docUrl(uid), { headers: { 'Authorization': 'Bearer ' + token } });
        if (res.status === 404) return null;
        const text = await res.text();
        if (!res.ok) {
            const err = new Error(this._friendlyHttp(res.status, text));
            err.status = res.status;
            throw err;
        }
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        return this._decodeDoc(json);
    },

    async _putCloud(uid, token, doc, opts) {
        const fields = Object.keys(doc);
        const qs = fields.map(f => 'updateMask.fieldPaths=' + encodeURIComponent(f)).join('&');
        const res = await fetch(this._docUrl(uid) + '?' + qs, {
            method: 'PATCH',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify(this._encodeDoc(doc)),
            /* Pagehide flush: ask the browser to finish this
               request even as the tab closes (best effort — the
               body size limit for such requests is small, so a
               very large doc may still need the next boot sync). */
            keepalive: !!(opts && opts.keepalive)
        });
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const err = new Error(this._friendlyHttp(res.status, text));
            err.status = res.status;
            throw err;
        }
        return true;
    },

    /* ---------- Sync metadata (per-store timestamps) ---------- */
    _meta() {
        try {
            const raw = localStorage.getItem(this.META_KEY);
            return raw ? JSON.parse(raw) : { profiles: 0, byProfile: {} };
        } catch (e) { return { profiles: 0, byProfile: {} }; }
    },

    _saveMeta(meta) {
        try { localStorage.setItem(this.META_KEY, JSON.stringify(meta)); } catch (e) {}
    },

    _metaFor(pid, store) {
        const m = this._meta();
        return ((m.byProfile && m.byProfile[pid] && m.byProfile[pid][store]) || 0);
    },

    _touchMeta(pid, store, ts) {
        const m = this._meta();
        if (!m.byProfile) m.byProfile = {};
        if (!m.byProfile[pid]) m.byProfile[pid] = {};
        m.byProfile[pid][store] = ts || Date.now();
        this._saveMeta(m);
    },

    /* Called from Storage._write for user-data keys only. During a
       cloud apply this is skipped (see _applying), so a pull can
       never trigger a push loop. */
    markDirty(key) {
        if (this._applying) return;
        if (!key || typeof key !== 'string') return;
        const now = Date.now();
        try {
            if (key === 'ganime_profiles_list') {
                const m = this._meta(); m.profiles = now; this._saveMeta(m);
            } else {
                const mm = key.match(/^ganime_(settings|addons|watched|locallib|mylist)_(.+)$/);
                if (mm) this._touchMeta(mm[2], mm[1], now);
            }
        } catch (e) {}
        this._dirty = true;
        this._schedulePush();
    },

    _schedulePush() {
        if (this._pushTimer) clearTimeout(this._pushTimer);
        /* Prompt sync (2026-10-26, his ruling: logged-in data
           must reach the cloud effectively instantly): a burst
           of writes still batches into ONE push, but only 3s
           after the last write instead of 8s — fast enough that
           you never have to think about it, slow enough that
           marking 20 episodes watched is still one write, not
           20 (a write on literally every tap would also risk
           two devices overwriting each other's doc mid-burst). */
        this._pushTimer = setTimeout(() => { this._pushTimer = null; this.pushOnly().catch(() => {}); }, 3000);
        this._bindFlush();
    },

    /* Flush on leaving: closing the tab, switching apps, or
       hiding the tab pushes any pending changes immediately
       instead of leaving them to the 3s timer that would never
       fire. Bound once, on first dirty write. */
    _bindFlush() {
        if (this._flushBound) return;
        this._flushBound = true;
        try {
            const flush = () => {
                if (!this._dirty || !this._ready()) return;
                this.pushOnly({ keepalive: true }).catch(() => {});
            };
            if (typeof window !== 'undefined' && window.addEventListener) {
                window.addEventListener('pagehide', flush);
            }
            if (typeof document !== 'undefined' && document.addEventListener) {
                document.addEventListener('visibilitychange', () => {
                    if (document.hidden) flush();
                });
            }
        } catch (e) {}
    },

    _setLast(status, detail) {
        this.lastStatus = status;
        try { localStorage.setItem(this.LAST_KEY, JSON.stringify({ at: Date.now(), status, detail: detail || '' })); } catch (e) {}
    },

    getLast() {
        try {
            const raw = localStorage.getItem(this.LAST_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch (e) { return null; }
    },

    /* ---------- Collect / apply ---------- */
    _cleanAddon(a) {
        if (!a || typeof a !== 'object') return null;
        const url = String(a.manifestUrl || '');
        /* Key-bearing URLs never sync: any query or fragment means
           the addon stays local-only on this device. */
        if (!url || url.indexOf('?') !== -1 || url.indexOf('#') !== -1) return null;
        if (!/^https:\/\//i.test(url)) return null;
        const logo = (typeof a.logo === 'string' && /^https?:\/\//i.test(a.logo)) ? a.logo : '';
        return {
            uid: String(a.id) + '::' + url,
            id: String(a.id || ''),
            name: String(a.name || ''),
            version: String(a.version || ''),
            description: String(a.description || ''),
            logo,
            resources: Array.isArray(a.resources) ? a.resources.map(String) : [],
            types: Array.isArray(a.types) ? a.types.map(String) : [],
            idPrefixes: Array.isArray(a.idPrefixes) ? a.idPrefixes.map(String) : [],
            manifestUrl: url,
            baseUrl: String(a.baseUrl || ''),
            configurable: !!a.configurable,
            enabled: a.enabled !== false
        };
    },

    collectLocal() {
        const profiles = (Storage.getProfiles() || []).map(p => ({
            id: String(p.id || ''),
            name: String(p.name || ''),
            avatarName: String(p.avatarName || ''),
            avatarUrl: (typeof p.avatarUrl === 'string' && /^https?:\/\//i.test(p.avatarUrl)) ? p.avatarUrl : '',
            isPrimary: !!p.isPrimary,
            usePrimaryAddons: !!p.usePrimaryAddons
        })).filter(p => p.id);
        const meta = this._meta();
        const byProfile = {};
        profiles.forEach(p => {
            const pid = p.id;
            const raw = key => {
                try {
                    const v = localStorage.getItem(key);
                    return v ? JSON.parse(v) : null;
                } catch (e) { return null; }
            };
            const addonsRaw = raw('ganime_addons_' + pid) || [];
            byProfile[pid] = {
                settings: raw('ganime_settings_' + pid) || {},
                addons: (Array.isArray(addonsRaw) ? addonsRaw : []).map(a => this._cleanAddon(a)).filter(Boolean),
                watched: raw('ganime_watched_' + pid) || {},
                locallib: raw('ganime_locallib_' + pid) || {},
                mylist: raw('ganime_mylist_' + pid) || [],
                _ts: {
                    settings: this._metaFor(pid, 'settings'),
                    addons: this._metaFor(pid, 'addons'),
                    watched: this._metaFor(pid, 'watched'),
                    locallib: this._metaFor(pid, 'locallib'),
                    mylist: this._metaFor(pid, 'mylist')
                }
            };
        });
        let activeProfileId = '';
        try { activeProfileId = Storage.getActiveProfileId() || ''; } catch (e) {}
        let epDesign = 'minimal';
        try { epDesign = Storage.getEpDesign() || 'minimal'; } catch (e) {}
        return {
            version: this.VERSION,
            updatedAt: Date.now(),
            profiles,
            activeProfileId,
            epDesign,
            _profilesTs: meta.profiles || 0,
            byProfile
        };
    },

    applyDoc(doc) {
        if (!doc || typeof doc !== 'object') return;
        this._applying = true;
        try {
            if (Array.isArray(doc.profiles)) Storage.saveProfiles(doc.profiles);
            if (doc.activeProfileId) {
                try {
                    const exists = (Storage.getProfiles() || []).some(p => p.id === doc.activeProfileId);
                    if (exists) Storage.setActiveProfileId(doc.activeProfileId);
                } catch (e) {}
            }
            if (doc.epDesign) {
                try { Storage.saveEpDesign(doc.epDesign); } catch (e) {}
            }
            const byProfile = doc.byProfile || {};
            Object.keys(byProfile).forEach(pid => {
                const s = byProfile[pid] || {};
                try { localStorage.setItem('ganime_settings_' + pid, JSON.stringify(s.settings || {})); } catch (e) {}
                try { localStorage.setItem('ganime_addons_' + pid, JSON.stringify(s.addons || [])); } catch (e) {}
                try { localStorage.setItem('ganime_watched_' + pid, JSON.stringify(s.watched || {})); } catch (e) {}
                try { localStorage.setItem('ganime_locallib_' + pid, JSON.stringify(s.locallib || {})); } catch (e) {}
                try { localStorage.setItem('ganime_mylist_' + pid, JSON.stringify(s.mylist || [])); } catch (e) {}
                /* Adopt the cloud store timestamps so the next
                   merge compares correctly. */
                if (s._ts) {
                    Object.keys(s._ts).forEach(store => this._touchMeta(pid, store, s._ts[store] || 0));
                }
            });
            if (doc._profilesTs) {
                const m = this._meta(); m.profiles = doc._profilesTs; this._saveMeta(m);
            }
        } finally {
            this._applying = false;
        }
    },

    /* ---------- Profile cleanup (2026-10-26, duplicate bug) ----------
       Two devices each create their own first profile, and every
       first profile is auto-PRIMARY — so a merge can produce two
       identical profiles that are BOTH primary, and addon sharing
       then picks the first one (possibly the empty one). Fix, run
       on every merged/pulled/pushed doc:
       1. Drop an EMPTY duplicate: same name + same avatar as
          another profile, with zero data of its own (no addons,
          no watched, no library, no My List, no saved settings).
          The profile WITH data always survives. A profile that
          has any data is never dropped, even if its name matches.
       2. Exactly one primary: if several remain primary, the
          earliest-created (lowest numeric id suffix — ids are
          'p' + Date.now()) keeps the badge, the rest lose it.
          If none is primary, the first profile becomes primary. */
    _profileDataSize(pid, doc) {
        const s = (doc.byProfile && doc.byProfile[pid]) || {};
        return ((s.addons || []).length)
            + Object.keys(s.watched || {}).length
            + Object.keys(s.locallib || {}).length
            + ((s.mylist || []).length)
            + Object.keys(s.settings || {}).length;
    },

    _normalizeProfiles(doc) {
        if (!doc || !Array.isArray(doc.profiles)) return false;
        let changed = false;
        /* 1. Drop empty duplicates (same name + avatar). */
        const groups = {};
        doc.profiles.forEach(p => {
            const key = String(p.name || '').trim() + '\n' + String(p.avatarName || '') + '\n' + String(p.avatarUrl || '');
            (groups[key] = groups[key] || []).push(p);
        });
        const dropped = new Set();
        Object.keys(groups).forEach(key => {
            const group = groups[key];
            if (group.length < 2) return;
            const withData = group.filter(p => this._profileDataSize(p.id, doc) > 0);
            if (!withData.length || withData.length === group.length) return;
            group.forEach(p => {
                if (withData.indexOf(p) === -1) dropped.add(p.id);
            });
        });
        if (dropped.size) {
            const keptByGroup = {};
            doc.profiles = doc.profiles.filter(p => {
                if (!dropped.has(p.id)) return true;
                return false;
            });
            dropped.forEach(pid => { if (doc.byProfile) delete doc.byProfile[pid]; });
            /* Active profile pointed at a dropped duplicate →
               point it at the surviving profile with the same
               name + avatar, else the first remaining profile. */
            if (dropped.has(doc.activeProfileId)) {
                const survivor = doc.profiles[0];
                doc.activeProfileId = survivor ? survivor.id : '';
            }
            changed = true;
        }
        /* 2. Exactly one primary. */
        const primaries = doc.profiles.filter(p => p.isPrimary);
        if (primaries.length > 1) {
            const num = p => { const n = parseInt(String(p.id || '').replace(/^p/, ''), 10); return isNaN(n) ? Infinity : n; };
            let keeper = primaries[0];
            primaries.forEach(p => { if (num(p) < num(keeper)) keeper = p; });
            doc.profiles.forEach(p => { if (p.id !== keeper.id && p.isPrimary) { p.isPrimary = false; changed = true; } });
        } else if (primaries.length === 0 && doc.profiles.length) {
            doc.profiles[0].isPrimary = true;
            changed = true;
        }
        return changed;
    },

    /* ---------- Merge (both sides have data) ---------- */
    _mergeWatched(localW, cloudW) {
        const out = {};
        const ids = new Set(Object.keys(localW || {}).concat(Object.keys(cloudW || {})));
        ids.forEach(id => {
            const l = (localW || {})[id], c = (cloudW || {})[id];
            if (!l) { out[id] = c; return; }
            if (!c) { out[id] = l; return; }
            const eps = Array.from(new Set([].concat(l.eps || [], c.eps || []))).sort((a, b) => a - b);
            const useCloudMeta = (c.updatedAt || 0) > (l.updatedAt || 0);
            out[id] = {
                eps,
                meta: useCloudMeta ? (c.meta || l.meta || null) : (l.meta || c.meta || null),
                updatedAt: Math.max(l.updatedAt || 0, c.updatedAt || 0)
            };
        });
        return out;
    },

    _mergeLocallib(localL, cloudL) {
        const out = {};
        const ids = new Set(Object.keys(localL || {}).concat(Object.keys(cloudL || {})));
        ids.forEach(id => {
            const l = (localL || {})[id], c = (cloudL || {})[id];
            if (!l) { out[id] = c; return; }
            if (!c) { out[id] = l; return; }
            out[id] = (c.updatedAt || 0) > (l.updatedAt || 0) ? c : l;
        });
        return out;
    },

    mergeDocs(local, cloud) {
        const merged = JSON.parse(JSON.stringify(local));
        merged.updatedAt = Date.now();
        /* Profiles: union by id, local wins on a same-id conflict. */
        const byId = {};
        (local.profiles || []).forEach(p => { byId[p.id] = p; });
        (cloud.profiles || []).forEach(p => { if (!byId[p.id]) byId[p.id] = p; });
        merged.profiles = Object.keys(byId).map(k => byId[k]);
        if (!merged.activeProfileId && cloud.activeProfileId) merged.activeProfileId = cloud.activeProfileId;
        if (!merged.byProfile) merged.byProfile = {};
        const cloudBy = cloud.byProfile || {};
        Object.keys(cloudBy).forEach(pid => {
            const cs = cloudBy[pid] || {};
            const ls = merged.byProfile[pid] || { settings: {}, addons: [], watched: {}, locallib: {}, mylist: [], _ts: {} };
            const cTs = cs._ts || {}, lTs = ls._ts || {};
            /* Settings: newer store timestamp wins; no timestamp on
               either side (legacy) keeps local — never wipes. */
            if ((cTs.settings || 0) > (lTs.settings || 0)) ls.settings = cs.settings || ls.settings;
            else ls.settings = Object.assign({}, cs.settings || {}, ls.settings || {});
            /* Addons: union by manifestUrl (or id), local wins. */
            const seen = new Set((ls.addons || []).map(a => a.manifestUrl || a.id));
            (cs.addons || []).forEach(a => {
                const key = a.manifestUrl || a.id;
                if (key && !seen.has(key)) { seen.add(key); ls.addons.push(a); }
            });
            ls.watched = this._mergeWatched(ls.watched || {}, cs.watched || {});
            ls.locallib = this._mergeLocallib(ls.locallib || {}, cs.locallib || {});
            ls.mylist = Array.from(new Set([].concat(ls.mylist || [], cs.mylist || [])));
            ls._ts = {
                settings: Math.max(lTs.settings || 0, cTs.settings || 0),
                addons: Math.max(lTs.addons || 0, cTs.addons || 0),
                watched: Math.max(lTs.watched || 0, cTs.watched || 0),
                locallib: Math.max(lTs.locallib || 0, cTs.locallib || 0),
                mylist: Math.max(lTs.mylist || 0, cTs.mylist || 0)
            };
            merged.byProfile[pid] = ls;
        });
        merged._profilesTs = Math.max(local._profilesTs || 0, cloud._profilesTs || 0);
        /* Duplicate-primary cleanup (2026-10-26): drop empty
           same-name duplicates, keep exactly one primary. */
        this._normalizeProfiles(merged);
        return merged;
    },

    /* ---------- Push only (debounced, after local writes) ---------- */
    async pushOnly(opts) {
        if (!this._ready()) return { status: 'skipped' };
        if (!this._dirty && this._bootDone) return { status: 'clean' };
        const auth = this._auth();
        const token = await this._token();
        if (!token) return { status: 'no-token' };
        const doc = this.collectLocal();
        if (this._normalizeProfiles(doc)) this.applyDoc(doc);
        try {
            await this._putCloud(auth.uid, token, doc, opts);
            this._dirty = false;
            this.lastError = '';
            this._setLast('synced', 'Cloud copy updated');
            return { status: 'pushed' };
        } catch (e) {
            this.lastError = (e && e.message) || 'Sync failed';
            this._setLast('error', this.lastError);
            return { status: 'error', message: this.lastError };
        }
    },

    /* ---------- Full sync: pull / push / merge ---------- */
    async syncNow(opts) {
        const manual = !!(opts && opts.manual);
        if (!this._ready()) {
            const a = this._auth();
            if (a && a.isGuest) return { status: 'guest', message: 'Guest mode does not sync — sign in to sync.' };
            return { status: 'not-ready', message: 'Sign in first, then sync.' };
        }
        const auth = this._auth();
        const token = await this._token();
        if (!token) return { status: 'no-token', message: 'Could not get a fresh sign-in token. Try signing in again.' };
        const local = this.collectLocal();
        /* Duplicate-primary cleanup also applies to the local doc
           itself (covers the cloud-empty first-push case): a
           cleaned local doc is written back locally first, so the
           device and the cloud converge on the same profile list. */
        if (this._normalizeProfiles(local)) this.applyDoc(local);
        const localHasProfiles = (local.profiles || []).length > 0;
        let cloud = null;
        try {
            cloud = await this._getCloud(auth.uid, token);
        } catch (e) {
            this.lastError = (e && e.message) || 'Sync failed';
            this._setLast('error', this.lastError);
            return { status: 'error', message: this.lastError };
        }
        let cloudCleaned = false;
        if (cloud) cloudCleaned = this._normalizeProfiles(cloud);
        try {
            if (!cloud) {
                if (!localHasProfiles) {
                    this._setLast('empty', 'Nothing to sync yet');
                    return { status: 'empty', message: 'Nothing to sync yet — create a profile first.' };
                }
                await this._putCloud(auth.uid, token, local);
                this._dirty = false;
                this.lastError = '';
                this._setLast('synced', 'First cloud copy created');
                return { status: 'pushed', message: 'First cloud copy created.' };
            }
            if (!localHasProfiles) {
                this.applyDoc(cloud);
                /* If the cloud doc itself had duplicates, push the
                   cleaned copy straight back so every device
                   converges now, not on the next manual sync. */
                if (cloudCleaned) {
                    try { await this._putCloud(auth.uid, token, this.collectLocal()); } catch (e) {}
                }
                this._dirty = false;
                this.lastError = '';
                this._setLast('synced', 'Downloaded from cloud');
                return { status: 'pulled', message: 'Your profiles and data were downloaded from the cloud.', pulled: true };
            }
            const merged = this.mergeDocs(local, cloud);
            const localChanged = JSON.stringify(merged) !== JSON.stringify(local);
            const cloudChanged = JSON.stringify(merged) !== JSON.stringify(cloud);
            if (localChanged) this.applyDoc(merged);
            if (cloudChanged) await this._putCloud(auth.uid, token, merged);
            this._dirty = false;
            this.lastError = '';
            this._setLast('synced', localChanged || cloudChanged ? 'Merged and synced' : 'Already in sync');
            return { status: 'merged', message: (localChanged || cloudChanged) ? 'Merged this device with the cloud.' : 'Already in sync.' };
        } catch (e) {
            this.lastError = (e && e.message) || 'Sync failed';
            this._setLast('error', this.lastError);
            return { status: 'error', message: this.lastError };
        }
    },

    /* Boot sync: runs once per session, before the profile picker /
       shell decision (app.js awaits it with a timeout). Never
       throws — a failure just leaves local data untouched. */
    bootSync() {
        if (this._bootPromise) return this._bootPromise;
        this._bootPromise = (async () => {
            try {
                if (!this._ready()) return { status: 'skipped' };
                const r = await this.syncNow({});
                this._bootDone = true;
                return r;
            } catch (e) {
                this._bootDone = true;
                return { status: 'error', message: (e && e.message) || 'Sync failed' };
            }
        })();
        return this._bootPromise;
    }
};
if (typeof window !== 'undefined') window.Sync = Sync;
