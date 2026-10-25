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
    normalizeManifestUrl(input) {
        let u = (input || '').trim();
        if (!u) return '';
        if (u.indexOf('stremio://') === 0) u = 'https://' + u.slice('stremio://'.length);
        if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
        u = u.replace(/\/+$/, '');
        if (!/\/manifest\.json$/i.test(u)) u += '/manifest.json';
        return u;
    },

    baseOf(manifestUrl) {
        return manifestUrl.replace(/\/manifest\.json$/i, '');
    },

    /* Fetch + validate a manifest, returning an install record. */
    async fetchManifest(input) {
        const url = this.normalizeManifestUrl(input);
        if (!url) throw new Error('Paste an addon URL first');
        const res = await fetch(url);
        if (!res.ok) throw new Error('Manifest fetch failed (HTTP ' + res.status + ')');
        let m;
        try { m = await res.json(); } catch (e) { throw new Error('That URL did not return JSON'); }
        if (!m || !m.id || !m.name) throw new Error('Not a valid addon manifest (missing id/name)');
        /* idPrefixes can live at the top level OR inside each
           resource object (Torrentio puts them on the stream
           resource) — merge both, or they read as "accepts all". */
        const prefixSet = new Set(m.idPrefixes || []);
        (m.resources || []).forEach(r => {
            if (r && typeof r === 'object' && Array.isArray(r.idPrefixes)) r.idPrefixes.forEach(p => prefixSet.add(p));
        });
        /* Stremio configuration support: an addon declares it in
           behaviorHints (configurationRequired is the documented
           flag; some addons use configurable). Only those addons
           get a Configure button — the rest never show one. */
        const bh = m.behaviorHints || {};
        return {
            uid: m.id + '::' + url,
            id: m.id,
            name: m.name,
            version: m.version || '',
            description: m.description || '',
            logo: m.logo || '',
            resources: (m.resources || []).map(r => (typeof r === 'string' ? r : r.name)),
            types: m.types || [],
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
        const res = await fetch(addon.baseUrl + '/stream/' + type + '/' + id + '.json');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        return (j && j.streams) || [];
    },

    /* One catalog page (Stremio protocol). */
    async getCatalog(addon, type, catalogId) {
        const res = await fetch(addon.baseUrl + '/catalog/' + type + '/' + encodeURIComponent(catalogId) + '.json');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        return (j && j.metas) || [];
    }
};
