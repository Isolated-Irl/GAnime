// ============================================================
// GAnime — addons.js = STREMIO ADDON ENGINE
// Addons are plain HTTP JSON services: a manifest.json describes
// them; resources (stream / catalog / meta) answer under the
// manifest's base URL. Installed per profile (Storage layer),
// with the primary profile's list shareable ("Use Primary
// Addons"). Streams/catalogs consume this engine.
// ============================================================
const Addons = {
    /* Accepts a base URL, a full manifest URL, or a stremio:// link. */
    /* URL-constructor normalisation: a query string or # fragment
       must not end up in the middle of the manifest path
       (e.g. ...manifest.json?key=abc/manifest.json). The query is
       preserved, the fragment is dropped, /manifest.json is appended
       to the pathname only. */
    normalizeManifestUrl(input) {
        let u = (input || '').trim();
        if (!u) return '';
        if (u.indexOf('stremio://') === 0) u = 'https://' + u.slice('stremio://'.length);
        if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
        try {
            const parsed = new URL(u);
            parsed.hash = '';
            const path = parsed.pathname.replace(/\/+$/, '');
            if (!/\/manifest\.json$/i.test(path)) parsed.pathname = path + '/manifest.json';
            return parsed.toString();
        } catch (e) {
            u = u.split('#')[0].replace(/\/+$/, '');
            if (!/\/manifest\.json$/i.test(u)) u += '/manifest.json';
            return u;
        }
    },

    baseOf(manifestUrl) {
        try {
            const parsed = new URL(manifestUrl);
            return parsed.origin + parsed.pathname.replace(/\/manifest\.json$/i, '');
        } catch (e) {
            return manifestUrl.replace(/\/manifest\.json$/i, '');
        }
    },

    /* Fetch with a timeout (addons cold-start in 15-30s+, so 25s,
       not 10s). AbortError is mapped to a friendly timed-out error. */
    async _fetchTimeout(url, opts, ms) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), ms || 25000);
        try {
            return await fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal }));
        } catch (e) {
            if (e && e.name === 'AbortError') throw new Error('Timed out — the addon did not answer in time');
            throw e;
        } finally { clearTimeout(t); }
    },

    _upgradeHttps(url) {
        /* http:// cannot be fetched from https://ganime.pages.dev
           (mixed content) anyway, so upgrade — except localhost,
           which has no TLS and would break if upgraded. */
        if (/^http:\/\/(localhost|127\.0\.0\.1)([:\/]|$)/i.test(url)) return url;
        return url.replace(/^http:\/\//i, 'https://');
    },

    /* Fetch + validate a manifest, returning an install record. */
    async fetchManifest(input) {
        const url = this._upgradeHttps(this.normalizeManifestUrl(input));
        if (!url) throw new Error('Paste an addon URL first');
        const res = await this._fetchTimeout(url, {}, 25000);
        if (!res.ok) throw new Error('Manifest fetch failed (HTTP ' + res.status + ')');
        let m;
        try { m = await res.json(); } catch (e) { throw new Error('That URL did not return JSON'); }
        if (!m || !m.id || !m.name) throw new Error('Not a valid addon manifest (missing id/name)');
        /* idPrefixes can live at the top level OR inside each
           resource object (Torrentio puts them on the stream
           resource) — merge both, or they read as "accepts all". */
        const prefixSet = new Set(m.idPrefixes || []);
        const typeSet = new Set(m.types || []);
        (m.resources || []).forEach(r => {
            if (r && typeof r === 'object' && Array.isArray(r.idPrefixes)) r.idPrefixes.forEach(p => prefixSet.add(p));
            if (r && typeof r === 'object' && Array.isArray(r.types)) r.types.forEach(t => typeSet.add(t));
        });
        /* Stremio configuration support: an addon declares it in
           behaviorHints (configurationRequired is the documented
           flag; some addons use configurable). Only those addons
           get a Configure button — the rest never show one. */
        const bh = m.behaviorHints || {};
        return {
            uid: m.id + '::' + url,
            id: String(m.id),
            name: String(m.name),
            version: String(m.version || ''),
            description: String(m.description || ''),
            logo: (typeof m.logo === 'string' && /^https?:\/\//i.test(m.logo)) ? m.logo : '',
            resources: (m.resources || []).map(r => (typeof r === 'string' ? r : r.name)),
            types: Array.from(typeSet),
            idPrefixes: Array.from(prefixSet),
            manifestUrl: url,
            baseUrl: this.baseOf(url),
            configurable: bh.configurationRequired === true || bh.configurable === true,
            enabled: true
        };
    },

    /* Streams for a title id (Stremio protocol). Used by the
       Select Stream screen. NOTE: the id goes into the path RAW —
       Stremio ids are colon forms (tt123:1:2, kitsu:47:1:2) and
       addon routers match them literally; percent-encoding the
       colons makes the lookup silently miss (empty stream list). */
    async getStreams(addon, type, id) {
        /* Colon-preserving encoding: identical output for every real
           Stremio id (tt123:1:2), but a space/?/#/ in an id can no
           longer break the request path. */
        const safeId = encodeURIComponent(String(id)).replace(/%3A/gi, ':');
        const res = await this._fetchTimeout(addon.baseUrl + '/stream/' + type + '/' + safeId + '.json', {}, 25000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        return (j && j.streams) || [];
    },

    /* One catalog page (Stremio protocol). */
    async getCatalog(addon, type, catalogId) {
        const res = await this._fetchTimeout(addon.baseUrl + '/catalog/' + type + '/' + encodeURIComponent(catalogId) + '.json', {}, 25000);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        return (j && j.metas) || [];
    }
};
