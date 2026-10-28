// ============================================================
// GAnime — anilist.js = ANILIST CLIENT (sole catalog source)
// GraphQL: https://graphql.anilist.co — public data, no key.
// Everything maps to GAnime's shared title shape and feeds
// App.titleCache so Details / My List / Calendar / hover
// panels all work on the same objects.
// ============================================================
const AniList = {
    ENDPOINT: 'https://graphql.anilist.co',
    FIELDS: `
        id idMal
        title { english romaji }
        averageScore episodes duration format status season seasonYear
        startDate { year }
        coverImage { extraLarge large }
        bannerImage
        description(asHtml: false)
        trailer { id site }
        genres
        studios { edges { isMain node { name } } }
        nextAiringEpisode { episode airingAt }
    `,

    async _post(query, variables) {
        /* Retry ONCE on 429 only (Retry-After if present, else ~2s).
           Never retry on 400/401/404. */
        let res = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            res = await fetch(this.ENDPOINT, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ query, variables: variables || {} })
            });
            if (res.status !== 429 || attempt === 1) break;
            const ra = parseInt(res.headers && res.headers.get ? (res.headers.get('Retry-After') || '') : '', 10);
            await new Promise(r => setTimeout(r, (isNaN(ra) ? 2 : ra) * 1000));
        }
        if (!res.ok) {
            let detail = '';
            try {
                const errJson = await res.json();
                if (errJson && errJson.errors && errJson.errors[0]) detail = ': ' + errJson.errors[0].message;
            } catch (e) { /* body not JSON — status alone will do */ }
            throw new Error('AniList ' + res.status + detail);
        }
        const json = await res.json();
        if (json.errors) throw new Error('AniList: ' + (json.errors[0] && json.errors[0].message || 'query error'));
        return json.data;
    },

    async _page(mediaArgs, variables, perPage) {
        const decl = variables && variables.decl ? ', ' + variables.decl : '';
        const query = `query ($page: Int, $perPage: Int${decl}) {
            Page(page: $page, perPage: $perPage) {
                media(type: ANIME, isAdult: false, ${mediaArgs}) { ${this.FIELDS} }
            }
        }`;
        const vars = Object.assign({ page: 1, perPage: perPage || 20 }, (variables && variables.values) || {});
        const data = await this._post(query, vars);
        const media = (data && data.Page && data.Page.media) || [];
        return media.map(m => this.mapMedia(m));
    },

    _cleanDesc(desc) {
        if (!desc) return '';
        const text = desc
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, '')
            .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
            /* Second tag-strip AFTER entity decoding, so an escaped
               tag in a description cannot revive into a live tag. */
            .replace(/<[^>]+>/g, '')
            .replace(/~![\s\S]*?!~/g, '');
        const first = text.split('\n').map(s => s.trim()).filter(Boolean)[0] || '';
        return first.length > 300 ? first.slice(0, 297) + '…' : first;
    },

    mapMedia(m) {
        const titles = m.title || {};
        let studio = '';
        const edges = (m.studios && m.studios.edges) || [];
        const main = edges.find(e => e.isMain) || edges[0];
        if (main && main.node) studio = main.node.name || '';
        return {
            id: 'a' + m.id,
            anilistId: m.id,
            malId: m.idMal || null,
            title: titles.english || titles.romaji || 'Unknown title',
            titleRomaji: titles.romaji || '',
            trailerId: (m.trailer && m.trailer.site === 'youtube' && m.trailer.id) ? m.trailer.id : null,
            year: m.seasonYear || (m.startDate && m.startDate.year) || '—',
            season: m.season || '',
            score: m.averageScore ? (m.averageScore / 10).toFixed(1) : '—',
            scorePct: m.averageScore || null,
            eps: m.episodes || 0,
            duration: m.duration || null,
            type: m.format === 'MOVIE' ? 'Movie' : 'TV',
            format: m.format || '',
            status: m.status || '',
            studio,
            /* Tracker layer Phase 4: grid cards use the lighter
               large poster (hundreds of cards — extraLarge for
               every tile was pure bandwidth); the extraLarge
               variant rides as posterXL for the one-at-a-time big
               displays (mobile hero art, Details fallbacks). */
            poster: (m.coverImage && (m.coverImage.large || m.coverImage.extraLarge)) || '',
            posterXL: (m.coverImage && (m.coverImage.extraLarge || m.coverImage.large)) || '',
            cover: m.bannerImage || (m.coverImage && m.coverImage.extraLarge) || '',
            synopsis: this._cleanDesc(m.description),
            genres: m.genres || [],
            nextRelease: (m.nextAiringEpisode && m.nextAiringEpisode.airingAt)
                ? new Date(m.nextAiringEpisode.airingAt * 1000).toISOString() : null,
            nextEp: (m.nextAiringEpisode && m.nextAiringEpisode.episode) || null,
            hue: (m.id * 47) % 360
        };
    },

    trending(perPage)    { return this._page('sort: TRENDING_DESC', null, perPage || 20); },
    topRated(perPage)    { return this._page('sort: SCORE_DESC', null, perPage || 20); },
    mostPopular(perPage) { return this._page('sort: POPULARITY_DESC', null, perPage || 20); },
    topMovies(perPage)   { return this._page('format: MOVIE, sort: SCORE_DESC', null, perPage || 20); },

    /* SINGLE-REQUEST HOME BATCH: all 6 Home rails in ONE GraphQL
       call. Boot used to fire 6 parallel requests (+1 calendar),
       and repeated refreshes tripped AniList's rate limit, which
       collapsed Home into the sample colored tiles. */
    async homeBatch(curSeason, curYear, nextSeason, nextYear) {
        const query = `query ($curSeason: MediaSeason, $curYear: Int, $nextSeason: MediaSeason, $nextYear: Int) {
            trending: Page(page: 1, perPage: 18) {
                media(type: ANIME, isAdult: false, sort: TRENDING_DESC) { ${this.FIELDS} }
            }
            seasonPop: Page(page: 1, perPage: 18) {
                media(type: ANIME, isAdult: false, season: $curSeason, seasonYear: $curYear, sort: POPULARITY_DESC) { ${this.FIELDS} }
            }
            nextPop: Page(page: 1, perPage: 18) {
                media(type: ANIME, isAdult: false, season: $nextSeason, seasonYear: $nextYear, sort: POPULARITY_DESC) { ${this.FIELDS} }
            }
            popular: Page(page: 1, perPage: 18) {
                media(type: ANIME, isAdult: false, sort: POPULARITY_DESC) { ${this.FIELDS} }
            }
            top: Page(page: 1, perPage: 18) {
                media(type: ANIME, isAdult: false, sort: SCORE_DESC) { ${this.FIELDS} }
            }
            movies: Page(page: 1, perPage: 18) {
                media(type: ANIME, isAdult: false, format: MOVIE, sort: SCORE_DESC) { ${this.FIELDS} }
            }
        }`;
        const data = await this._post(query, { curSeason, curYear, nextSeason, nextYear });
        const mapList = (pageObj) => ((pageObj && pageObj.media) || []).map(m => this.mapMedia(m));
        return [
            { title: 'Trending Now', items: mapList(data.trending) },
            { title: 'Popular This Season', items: mapList(data.seasonPop) },
            { title: 'Upcoming Next Season', items: mapList(data.nextPop) },
            { title: 'All Time Popular', items: mapList(data.popular) },
            { title: 'Top 100 Anime', items: mapList(data.top) },
            { title: 'Top 100 Movies', items: mapList(data.movies) }
        ].filter(r => r.items.length > 0);
    },
    search(text, perPage) {
        const cleanText = text && text.trim();
        if (!cleanText) return this.mostPopular(perPage || 24);
        return this._page('sort: SEARCH_MATCH, search: $search',
            { decl: '$search: String', values: { search: cleanText } }, perPage || 24);
    },
    airing(perPage) {
        return this._page('status: RELEASING, sort: POPULARITY_DESC', null, perPage || 50);
    },

    /* Current / next season helpers (AniList season rules). */
    currentSeason(date) {
        const d = date || new Date();
        const month = d.getMonth();
        const year = d.getFullYear();
        if (month === 11) return { season: 'WINTER', year: year + 1 };
        if (month <= 1) return { season: 'WINTER', year };
        if (month <= 4) return { season: 'SPRING', year };
        if (month <= 7) return { season: 'SUMMER', year };
        return { season: 'FALL', year };
    },
    nextSeason(date) {
        const cur = this.currentSeason(date);
        const order = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
        const i = order.indexOf(cur.season);
        if (i === 3) return { season: 'WINTER', year: cur.year + 1 };
        return { season: order[i + 1], year: cur.year };
    },
    seasonPopular(season, year, perPage) {
        return this._page('season: $season, seasonYear: $year, sort: POPULARITY_DESC',
            { decl: '$season: MediaSeason, $year: Int', values: { season, year } }, perPage || 18);
    },
    seasonScore(season, year, perPage) {
        return this._page('season: $season, seasonYear: $year, sort: SCORE_DESC',
            { decl: '$season: MediaSeason, $year: Int', values: { season, year } }, perPage || 18);
    },

    /* Full filter browse — powers the Search screen's filter bar.
       DYNAMICALLY built: only filters that actually have a value
       are declared and sent. AniList's backend rejects null on
       operator arguments (_in / _greater / _lesser) with a 400
       "Illegal operator and value combination", so unused filters
       are omitted from the query entirely — never sent as null. */
    /* Single-title hydration (cold-boot route restore): fetch the
       exact anime by AniList id when the cache is empty. */
    async byId(id) {
        const cleanId = parseInt(String(id).replace(/^a/, ''), 10);
        if (!cleanId) return null;
        const query = `query ($id: Int) { Media(id: $id, type: ANIME) { ${this.FIELDS} } }`;
        const data = await this._post(query, { id: cleanId });
        return (data && data.Media) ? this.mapMedia(data.Media) : null;
    },

    async browse(f = {}, perPage, page) {
        const norm = v => (v === '' || v === undefined || v === null) ? null : v;
        const arr = v => (Array.isArray(v) && v.length > 0) ? v : null;
        const intVal = v => (v !== '' && v != null && !isNaN(parseInt(v, 10))) ? parseInt(v, 10) : null;

        const cleanSearch = norm(f.q) ? String(f.q).trim() : null;
        let sortVal = f.sort ? (Array.isArray(f.sort) ? f.sort : [f.sort]) : ['POPULARITY_DESC'];
        /* SEARCH_MATCH is only legal alongside an active search string. */
        if (!cleanSearch && sortVal.includes('SEARCH_MATCH')) sortVal = ['POPULARITY_DESC'];

        const defs = [
            { name: 'search', type: 'String', arg: 'search', val: cleanSearch || null },
            { name: 'genreIn', type: '[String]', arg: 'genre_in', val: arr(f.genres) },
            { name: 'tagIn', type: '[String]', arg: 'tag_in', val: arr(f.tags) },
            { name: 'seasonYear', type: 'Int', arg: 'seasonYear', val: intVal(f.year) },
            { name: 'season', type: 'MediaSeason', arg: 'season', val: norm(f.season) },
            { name: 'format', type: 'MediaFormat', arg: 'format', val: norm(f.format) },
            { name: 'status', type: 'MediaStatus', arg: 'status', val: norm(f.status) },
            { name: 'sort', type: '[MediaSort]', arg: 'sort', val: sortVal },
            { name: 'country', type: 'CountryCode', arg: 'countryOfOrigin', val: norm(f.country) },
            { name: 'source', type: 'MediaSource', arg: 'source', val: norm(f.source) },
            { name: 'yearGreater', type: 'FuzzyDateInt', arg: 'startDate_greater', val: intVal(f.yearMin) !== null ? (intVal(f.yearMin) * 10000) - 1 : null },
            { name: 'yearLesser', type: 'FuzzyDateInt', arg: 'startDate_lesser', val: intVal(f.yearMax) !== null ? (intVal(f.yearMax) + 1) * 10000 : null },
            { name: 'epGreater', type: 'Int', arg: 'episodes_greater', val: intVal(f.epMin) !== null ? intVal(f.epMin) - 1 : null },
            { name: 'epLesser', type: 'Int', arg: 'episodes_lesser', val: intVal(f.epMax) !== null ? intVal(f.epMax) + 1 : null },
            { name: 'durGreater', type: 'Int', arg: 'duration_greater', val: intVal(f.durMin) !== null ? intVal(f.durMin) - 1 : null },
            { name: 'durLesser', type: 'Int', arg: 'duration_lesser', val: intVal(f.durMax) !== null ? intVal(f.durMax) + 1 : null }
        ];

        const decls = ['$page: Int', '$perPage: Int'];
        const mediaArgs = ['type: ANIME', 'isAdult: false'];
        const vars = { page: page || 1, perPage: perPage || 36 };
        for (const def of defs) {
            if (def.val !== null) {
                decls.push('$' + def.name + ': ' + def.type);
                mediaArgs.push(def.arg + ': $' + def.name);
                vars[def.name] = def.val;
            }
        }
        const query = `query (${decls.join(', ')}) {
            Page(page: $page, perPage: $perPage) {
                media(${mediaArgs.join(', ')}) { ${this.FIELDS} }
            }
        }`;
        const data = await this._post(query, vars);
        const media = (data && data.Page && data.Page.media) || [];
        return media.map(m => this.mapMedia(m));
    },

    /* Batch-hydrate MAL IDs into full GAnime titles (50 a page).
       TRACKSTORE-FIRST: fresh cached titles (< 7 days) are returned
       with zero network; only missing or stale ids are fetched.
       Chunks run through a small pool (3 at a time): a ~600-title
       Simkl/MAL list used to pay 12-13 sequential round-trips, and
       firing all of them at once risks AniList's burst limiter.
       Each chunk gets up to 3 attempts: a CORS-less 429 makes fetch
       throw (bypassing _post's retry, which is why this uses a raw
       fetch that sees the status), so thrown errors and 429/5xx are
       all retryable, with backoff 1s then 2s (Retry-After wins when
       present); other 4xx fail immediately. A chunk that still
       fails lands its ids in `pending` — never silently dropped,
       never saved as degraded media. Successful titles are cached
       via TrackStore.putTitle. Returns { byMal, pending }. */
    async byMalIds(malIds, opts) {
        const clean = Array.from(new Set((malIds || []).map(x => parseInt(x, 10)).filter(Boolean)));
        if (!clean.length) return { byMal: {}, pending: [] };
        const sleep = (opts && opts.sleep) || (ms => new Promise(r => setTimeout(r, ms)));
        const BACKOFF = [1000, 2000, 4000];
        const FRESH_MS = 7 * 24 * 3600 * 1000;
        const byMal = {};
        const toFetch = [];
        const hasStore = (typeof TrackStore !== 'undefined') && TrackStore && TrackStore.getTitleByMalId;
        for (const id of clean) {
            let row = null;
            if (hasStore) { try { row = await TrackStore.getTitleByMalId(id); } catch (e) {} }
            if (row && row.media && (Date.now() - (row.fetchedAt || 0)) < FRESH_MS) byMal[id] = row.media;
            else toFetch.push(id);
        }
        if (!toFetch.length) return { byMal, pending: [] };
        const chunks = [];
        for (let i = 0; i < toFetch.length; i += 50) chunks.push(toFetch.slice(i, i + 50));
        const fetchChunk = async (chunk) => {
            const query = `query ($ids: [Int]) {
                Page(page: 1, perPage: 50) {
                    media(type: ANIME, idMal_in: $ids) { ${this.FIELDS} }
                }
            }`;
            let lastErr = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (attempt > 0) {
                    const delay = (lastErr && lastErr.retryAfter != null) ? lastErr.retryAfter * 1000 : BACKOFF[attempt - 1];
                    await sleep(delay);
                }
                try {
                    const res = await fetch(this.ENDPOINT, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                        body: JSON.stringify({ query, variables: { ids: chunk } })
                    });
                    if (res.ok) {
                        const json = await res.json();
                        if (json.errors) return null; // bad query — retrying won't help
                        return ((json.data && json.data.Page && json.data.Page.media) || []).map(m => this.mapMedia(m));
                    }
                    const ra = parseInt(res.headers && res.headers.get ? (res.headers.get('Retry-After') || '') : '', 10);
                    const retryable = res.status === 429 || res.status >= 500;
                    lastErr = { retryable, retryAfter: isNaN(ra) ? null : ra, status: res.status };
                    if (!retryable) return null;
                } catch (e) {
                    // Network throw (including a CORS-less 429) — retryable.
                    lastErr = { retryable: true, retryAfter: null };
                }
            }
            return null;
        };
        const results = new Array(chunks.length);
        let next = 0;
        const workers = Array.from({ length: Math.min(3, chunks.length) }, async () => {
            while (next < chunks.length) {
                const idx = next++;
                results[idx] = await fetchChunk(chunks[idx]);
            }
        });
        await Promise.all(workers);
        const pending = [];
        for (let idx = 0; idx < results.length; idx++) {
            const list = results[idx];
            if (!list) { pending.push.apply(pending, chunks[idx]); continue; }
            for (const mapped of list) {
                if (!mapped.malId) continue;
                byMal[mapped.malId] = mapped;
                if (hasStore && TrackStore.putTitle) { try { await TrackStore.putTitle(mapped); } catch (e) {} }
            }
        }
        return { byMal, pending };
    },

    /* TrackStore-only lookup: fresh hydrated titles, no network.
       Used for the first render so lists show instantly; stale or
       missing ids come back as gaps for the background fetch. */
    async byMalIdsCached(malIds) {
        const clean = Array.from(new Set((malIds || []).map(x => parseInt(x, 10)).filter(Boolean)));
        const out = {};
        const hasStore = (typeof TrackStore !== 'undefined') && TrackStore && TrackStore.getTitleByMalId;
        if (!hasStore || !clean.length) return out;
        const FRESH_MS = 7 * 24 * 3600 * 1000;
        for (const id of clean) {
            let row = null;
            try { row = await TrackStore.getTitleByMalId(id); } catch (e) {}
            if (row && row.media && (Date.now() - (row.fetchedAt || 0)) < FRESH_MS) out[id] = row.media;
        }
        return out;
    },

    /* The full AniList tag list (fetched once, cached). */
    _tagsPromise: null,
    tags() {
        if (!this._tagsPromise) {
            this._tagsPromise = this._post('query { MediaTagCollection { name } }')
                .then(data => ((data && data.MediaTagCollection) || []).map(t => t.name))
                .catch(() => []);
        }
        return this._tagsPromise;
    },

    /* ========================================================
       TRACKING — AniList OAuth (PIN flow for local apps) + lists
       The user registers their OWN API client on AniList
       (Settings → Developer) with redirect URL set to
       https://anilist.co/api/v2/oauth/pin — AniList then shows
       a code the user pastes back here. Client secret lives only
       in this profile's local storage, used only against
       anilist.co's token endpoint.
       ======================================================== */
    OAUTH_PIN_REDIRECT: 'https://anilist.co/api/v2/oauth/pin',

    /* Implicit grant (AniList's documented flow for client-side
       apps): response_type=token sends the user to the registered
       PIN page, which displays a JWT access_token directly —
       valid 1 year, no client secret, no token-endpoint exchange
       (that endpoint has no CORS and refresh tokens don't exist
       on AniList). Verified against docs.anilist.co/guide/auth
       on 2026-10-23. */
    authorizeUrl(clientId) {
        return 'https://anilist.co/api/v2/oauth/authorize?client_id=' +
            encodeURIComponent(String(clientId || '').trim()) + '&response_type=token';
    },

    /* Accept the bare JWT, or a full pasted redirect URL whose
       fragment carries it. Authorization codes (hex, e.g. from
       the response_type=code flow) get a specific explanation. */
    async verifyToken(pasted) {
        let clean = String(pasted || '').trim();
        const frag = clean.match(/access_token=([^&\s]+)/);
        if (frag) clean = decodeURIComponent(frag[1]);
        if (!clean) throw new Error('Paste the token from AniList first.');
        if (/^[0-9a-f]{32,}$/i.test(clean) || !clean.includes('.')) {
            throw new Error('That looks like an authorization code, not a token. Click "Open AniList approval page" and approve again — the new page shows the long token (starts with eyJ).');
        }
        const user = await this.viewer(clean);
        if (!user || !user.id) throw new Error('AniList did not recognize that token.');
        return { accessToken: clean, user };
    },

    async _postAuth(query, variables, accessToken) {
        let res = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            res = await fetch(this.ENDPOINT, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json', 'Accept': 'application/json',
                    'Authorization': 'Bearer ' + accessToken
                },
                body: JSON.stringify({ query, variables: variables || {} })
            });
            if (res.status !== 429 || attempt === 1) break;
            const ra = parseInt(res.headers && res.headers.get ? (res.headers.get('Retry-After') || '') : '', 10);
            await new Promise(r => setTimeout(r, (isNaN(ra) ? 2 : ra) * 1000));
        }
        if (!res.ok) {
            let detail = '';
            try {
                const errJson = await res.json();
                if (errJson && errJson.errors && errJson.errors[0]) detail = ': ' + errJson.errors[0].message;
            } catch (e) { /* ignore */ }
            const err = new Error('AniList ' + res.status + detail);
            err.status = res.status;
            throw err;
        }
        const json = await res.json();
        if (json.errors) throw new Error('AniList: ' + (json.errors[0] && json.errors[0].message || 'query error'));
        return json.data;
    },

    async viewer(accessToken) {
        const data = await this._postAuth('query { Viewer { id name avatar { large } } }', {}, accessToken);
        const v = (data && data.Viewer) || {};
        return { id: v.id, name: v.name, avatar: (v.avatar && v.avatar.large) || '' };
    },

    /* The user's anime lists grouped by status. Entries carry
       progress + the full mapped media (same title shape as the
       catalog) so Library / Continue Watching render directly. */
    LIST_STATUSES: [
        { key: 'CURRENT', label: 'Watching' },
        { key: 'COMPLETED', label: 'Completed' },
        { key: 'PAUSED', label: 'On Hold' },
        { key: 'DROPPED', label: 'Dropped' },
        { key: 'PLANNING', label: 'Plan to Watch' },
        { key: 'REPEATING', label: 'Rewatching' }
    ],

    async myLists(accessToken, userId) {
        const query = `query ($userId: Int) {
            MediaListCollection(userId: $userId, type: ANIME) {
                lists { name status entries {
                    id status progress score(format: POINT_10_DECIMAL) updatedAt createdAt
                    completedAt { year month day }
                    startedAt { year month day }
                    media { ${this.FIELDS} }
                } }
            }
        }`;
        const data = await this._postAuth(query, { userId }, accessToken);
        const lists = (data && data.MediaListCollection && data.MediaListCollection.lists) || [];
        const toUnix = d => (d && d.year) ? Math.floor(Date.UTC(d.year, (d.month || 1) - 1, d.day || 1) / 1000) : 0;
        const out = {};
        lists.forEach(list => {
            const entries = (list.entries || []).map(e => ({
                entryId: e.id,
                status: e.status,
                progress: e.progress || 0,
                score: e.score || 0,
                updatedAt: e.updatedAt || 0,
                createdAt: e.createdAt || 0,
                completedAt: toUnix(e.completedAt),
                startedAt: toUnix(e.startedAt),
                media: this.mapMedia(e.media)
            })).filter(e => e.media && e.media.anilistId);
            if (entries.length) {
                if (!out[list.status]) out[list.status] = { name: list.name, entries: [] };
                const seen = new Set(out[list.status].entries.map(x => x.media && x.media.anilistId));
                entries.forEach(x => { if (x.media && x.media.anilistId && !seen.has(x.media.anilistId)) { seen.add(x.media.anilistId); out[list.status].entries.push(x); } });
            }
        });
        return out;
    },

    async saveProgress(accessToken, mediaId, progress, status, extra) {
        /* extra (Tracking editor): { score (0–10), notes,
           startedAt / completedAt as FuzzyDate {y,m,d} } — fields
           are only added to the mutation when actually set, so an
           unset field can never clear an existing value. */
        const ex = extra || {};
        const decls = ['$mediaId: Int', '$progress: Int', '$status: MediaListStatus'];
        const args = ['mediaId: $mediaId', 'progress: $progress', 'status: $status'];
        const vars = { mediaId, progress, status };
        /* scoreRaw is always 0–100 regardless of the profile's
           display scale, so a 0–10 slider value converts exactly
           (8.5 -> 85). A bare Float score would follow the profile
           scale instead — 8.5 on a 100-point profile saves as 8.5. */
        if (typeof ex.score === 'number' && ex.score >= 0) { decls.push('$scoreRaw: Int'); args.push('scoreRaw: $scoreRaw'); vars.scoreRaw = Math.round(ex.score * 10); }
        if (ex.notes) { decls.push('$notes: String'); args.push('notes: $notes'); vars.notes = ex.notes; }
        if (ex.startedAt) { decls.push('$startedAt: FuzzyDateInput'); args.push('startedAt: $startedAt'); vars.startedAt = ex.startedAt; }
        if (ex.completedAt) { decls.push('$completedAt: FuzzyDateInput'); args.push('completedAt: $completedAt'); vars.completedAt = ex.completedAt; }
        const query = `mutation (${decls.join(', ')}) {
            SaveMediaListEntry(${args.join(', ')}) { id progress status }
        }`;
        return this._postAuth(query, vars, accessToken);
    }
};

// ============================================================
// TRACKERS ENGINE — Simkl (PIN flow, api.simkl.com) and
// MyAnimeList (public-list sync). Both map into the SAME list
// shape AniList.myLists returns, so Library sorting, cards and
// Continue Watching work identically for every provider.
// ============================================================
const Trackers = {
    SIMKL_API: 'https://api.simkl.com',

    async simklStartPin(clientId) {
        const r = await fetch(this.SIMKL_API + '/oauth/pin?client_id=' + encodeURIComponent(clientId), { method: 'POST' });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || !j.user_code) throw new Error('Simkl did not return a PIN — check your Client ID.');
        return j;
    },

    async simklCheckPin(clientId, userCode) {
        const r = await fetch(this.SIMKL_API + '/oauth/pin/' + encodeURIComponent(userCode) + '?client_id=' + encodeURIComponent(clientId));
        const j = await r.json().catch(() => null);
        if (j && j.result === 'OK' && j.access_token) return j.access_token;
        return null;
    },

    /* Simkl Phase 1: one shared helper for every AUTHENTICATED
       Simkl call — identification query params, token header,
       JSON parse, and a structured error ({status, error,
       message}) so callers can report Simkl's own words instead
       of a bare status code. The PIN endpoints stay on their own
       calls: they carry no token. */
    async _simklFetch(path, opts) {
        opts = opts || {};
        const sep = path.indexOf('?') !== -1 ? '&' : '?';
        const url = this.SIMKL_API + path + sep + 'client_id=' + encodeURIComponent(opts.clientId || '') + '&app-name=ganime&app-version=1.0';
        const headers = { 'Authorization': 'Bearer ' + opts.token };
        if (opts.clientId) headers['simkl-api-key'] = opts.clientId;
        if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
        const r = await fetch(url, { method: opts.method || 'GET', headers: headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
        const data = (r && typeof r.json === 'function') ? await r.json().catch(() => ({})) : {};
        if (!r.ok) {
            const err = new Error('Simkl request failed (' + r.status + ') - ' + (data.error || 'error') + ': ' + (data.message || ''));
            err.simkl = { status: r.status, error: data.error || null, message: data.message || null };
            throw err;
        }
        return { status: r.status, data: data };
    },

    async simklViewer(clientId, token) {
        const { data: j } = await this._simklFetch('/users/settings', { clientId: clientId, token: token });
        if (!j || !j.user) throw new Error('Simkl auth check failed');
        return {
            id: (j.account && j.account.id) || j.user.name,
            name: j.user.name || 'Simkl User',
            avatar: j.user.avatar || ''
        };
    },

    /* Simkl poster URL. The API's show.poster is NOT a full URL —
       it's a CDN path fragment, so the old 'simkl.in' + poster
       build 404'd and left gradient tiles. Per Simkl's image
       scheme the real form is simkl.in/posters/{prefix}/{image}
       _m.webp, where the prefix dir is the first 2 chars of the
       image hash (every documented example matches: 74/74415…,
       71/71040…, 26/26531…). Full URLs pass through untouched,
       and any existing size suffix is normalised to _m. */
    simklPosterUrl(poster) {
        if (!poster) return '';
        const p = String(poster).trim();
        if (p.startsWith('http://') || p.startsWith('https://')) return p;
        if (p.startsWith('//')) return 'https:' + p;
        const hasSizeSuffix = /_(m|c|ca|cm|s|w)(\.webp|\.jpg|\.jpeg|\.png)?$/.test(p);
        if (p.indexOf('simkl.in/') !== -1) {
            const path = p.replace(/^https?:\/\//, '');
            return 'https://' + (hasSizeSuffix ? path : path.replace(/\.(webp|jpg|jpeg|png)$/, '') + '_m.webp');
        }
        const bare = p.replace(/_(m|c|ca|cm|s|w)(\.webp|\.jpg|\.jpeg|\.png)?$/, '').replace(/\.(webp|jpg|jpeg|png)$/, '');
        if (bare.startsWith('posters/')) return 'https://simkl.in/' + bare + '_m.webp';
        if (bare.indexOf('/') !== -1) return 'https://simkl.in/posters/' + bare + '_m.webp';
        return 'https://simkl.in/posters/' + bare.slice(0, 2) + '/' + bare + '_m.webp';
    },

    /* Simkl lists, fallback-first: the returned entries render
       IMMEDIATELY from cached titles + Simkl's own metadata
       (flagged needsHydration when unhydrated), while the full
       AniList hydration runs in the background and reports via
       onDone(byMal, pending) so the caller can upgrade cards in
       place. No await on hydration here — awaiting it was what
       made the tab skeleton until every chunk landed. */
    async simklLists(clientId, token, onDone) {
        const { data: j } = await this._simklFetch('/sync/all-items/anime/', { clientId: clientId, token: token });
        const items = Array.isArray(j) ? j : ((j && j.anime) || []);
        const statusMap = { watching: 'CURRENT', completed: 'COMPLETED', hold: 'PAUSED', dropped: 'DROPPED', plantowatch: 'PLANNING' };
        const malIds = items.map(x => x.show && x.show.ids && x.show.ids.mal).filter(Boolean);
        const cached = await AniList.byMalIdsCached(malIds);
        const out = {};
        items.forEach(item => {
            const st = statusMap[item.status] || 'CURRENT';
            const ids = (item.show && item.show.ids) || {};
            const malId = ids.mal ? parseInt(ids.mal, 10) : null;
            const media = (malId && cached[malId]) || Object.assign({
                id: malId ? 'mal_' + malId : 'simkl_' + (ids.simkl || ids.simkl_id || 0),
                anilistId: null,
                malId: malId,
                title: (item.show && item.show.title) || 'Unknown title',
                year: (item.show && item.show.year) || '—',
                score: item.user_rating ? Number(item.user_rating).toFixed(1) : '—',
                scorePct: item.user_rating ? item.user_rating * 10 : null,
                eps: item.total_episodes_count || 0,
                type: 'TV', poster: this.simklPosterUrl(item.show && item.show.poster), cover: '', synopsis: '', genres: [],
                hue: ((malId || ids.simkl || ids.simkl_id || 1) * 47) % 360
            }, { needsHydration: true });
            const updatedTs = item.last_watched_at ? Math.floor(new Date(item.last_watched_at).getTime() / 1000) : 0;
            const entry = {
                entryId: ids.simkl || ids.simkl_id || malId || 0,
                status: st,
                progress: item.watched_episodes_count || 0,
                score: item.user_rating || 0,
                updatedAt: updatedTs,
                createdAt: updatedTs,
                completedAt: st === 'COMPLETED' ? updatedTs : 0,
                startedAt: 0,
                media
            };
            if (!out[st]) out[st] = { name: st, entries: [] };
            out[st].entries.push(entry);
        });
        // Background hydration only when the caller wants the result
        // (App passes onDone; the paste flow doesn't — its relay fetch
        // right after does the hydration itself, so no double fetch).
        if (typeof onDone === 'function' && malIds.length) {
            AniList.byMalIds(malIds).then(
                r => { try { onDone(r.byMal, r.pending); } catch (e) {} },
                () => { try { onDone({}, malIds); } catch (e) {} }
            );
        }
        return out;
    },

    /* Simkl progress (+ optional status) in ONE history call.
       Simkl's docs steer sync flows to /sync/history, which
       carries status per item; /sync/add-to-list is only for
       explicit watchlist buttons, and it 403s for this flow —
       and a status failure there used to abort the episode push
       entirely. One call means that can't happen. A status-only
       change sends history with status and no seasons. Failures
       throw so the editor reports them instead of a false ✓. */
    async simklSaveProgress(clientId, token, t, progress, status) {
        const ids = {};
        if (t.malId) ids.mal = t.malId;
        if (t.anilistId) ids.anilist = t.anilistId;
        /* Phase 7: the map takes BOTH vocabularies — the editor's
           labels ('Watching'/'Completed'/…) and the funnel's
           AniList enums ('CURRENT'/'COMPLETED'/…) — so plain
           marks can send status in the same ONE /sync/history
           call instead of progress alone. */
        const simklStatusMap = { 'Watching': 'watching', 'Completed': 'completed', 'Plan to Watch': 'plantowatch', 'On Hold': 'hold', 'Dropped': 'dropped', 'Rewatching': 'watching', 'CURRENT': 'watching', 'COMPLETED': 'completed', 'PLANNING': 'plantowatch', 'PAUSED': 'hold', 'DROPPED': 'dropped', 'REPEATING': 'watching' };
        const show = { title: t.title, ids };
        if (status) show.status = simklStatusMap[status] || 'watching';
        if (progress > 0) {
            const episodes = [];
            for (let i = 1; i <= progress; i++) episodes.push({ number: i });
            show.seasons = [{ number: 1, episodes }];
        }
        if (!show.status && !show.seasons) return; // nothing to send
        /* Simkl Phase 1: the helper carries the identification
           params and parses the body; the error is rethrown with
           Simkl's own error + message, and a 200 that could not
           match the title is a failure, not a success. A network
           failure has no .simkl and passes through untouched. */
        let res;
        try {
            res = await this._simklFetch('/sync/history', { clientId: clientId, token: token, method: 'POST', body: { shows: [show] } });
        } catch (e) {
            if (e && e.simkl) {
                const s = e.simkl;
                throw new Error('Simkl history update failed (' + s.status + ') - ' + (s.error || 'error') + ': ' + (s.message || ''));
            }
            throw e;
        }
        const nf = res.data && res.data.not_found;
        if (nf && nf.shows && nf.shows.length) throw new Error('Simkl could not match this title');
    },

    /* MAL: parse an api.myanimelist.net v2 animelist response
       into the unified list shape. Fallback-first like simklLists:
       cached titles + MAL's own main_picture render immediately
       (flagged needsHydration when unhydrated); the full AniList
       hydration runs in the background and reports via onDone. */
    async malParseListJson(rawItems, onDone) {
        const statusMap = { watching: 'CURRENT', completed: 'COMPLETED', on_hold: 'PAUSED', dropped: 'DROPPED', plan_to_watch: 'PLANNING' };
        const malIds = (rawItems || []).map(x => (x.node && x.node.id) || x.mal_id).filter(Boolean);
        const cached = await AniList.byMalIdsCached(malIds);
        const out = {};
        (rawItems || []).forEach(x => {
            const node = x.node || x;
            const ls = x.list_status || x;
            const malId = node.id || node.mal_id;
            if (!malId) return;
            const rawStatus = String(ls.status || 'watching').toLowerCase().replace(/\s+/g, '_');
            const st = statusMap[rawStatus] || 'CURRENT';
            const media = cached[malId] || Object.assign({
                id: 'mal_' + malId,
                anilistId: null,
                malId: malId,
                title: node.title || 'Unknown title',
                year: (node.start_season && node.start_season.year) || node.year || '—',
                score: node.mean ? Number(node.mean).toFixed(1) : '—',
                scorePct: node.mean ? Math.round(node.mean * 10) : null,
                eps: node.num_episodes || node.episodes || 0,
                type: 'TV',
                poster: (node.main_picture && (node.main_picture.large || node.main_picture.medium)) || '',
                cover: '', synopsis: '', genres: [],
                hue: (malId * 47) % 360
            }, { needsHydration: true });
            const updatedTs = ls.updated_at ? Math.floor(new Date(ls.updated_at).getTime() / 1000) : 0;
            const finishTs = ls.finish_date ? Math.floor(new Date(ls.finish_date).getTime() / 1000) || 0 : 0;
            const entry = {
                entryId: malId,
                status: st,
                progress: ls.num_episodes_watched || ls.episodes_watched || 0,
                score: ls.score || 0,
                updatedAt: updatedTs,
                createdAt: updatedTs,
                completedAt: finishTs || (st === 'COMPLETED' ? updatedTs : 0),
                startedAt: 0,
                media
            };
            if (!out[st]) out[st] = { name: st, entries: [] };
            out[st].entries.push(entry);
        });
        if (typeof onDone === 'function' && malIds.length) {
            AniList.byMalIds(malIds).then(
                r => { try { onDone(r.byMal, r.pending); } catch (e) {} },
                () => { try { onDone({}, malIds); } catch (e) {} }
            );
        }
        return out;
    }
};
