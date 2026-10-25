// ============================================================
// GAnime — firebase.js = FIREBASE AUTH (Spark, REST, NO SDK)
// Phase 1: real email/password login only. No Firestore sync here
// (Phase 2, separate, batched: one doc per user, key events only).
// Why REST, not the Firebase SDK: zero extra <script> tags, the
// app already loads movi + app code, and the Identity Toolkit
// REST endpoints are the same ones the SDK calls underneath.
// Security notes (read before changing this file):
//  - Config.FIREBASE.apiKey is the PUBLIC web apiKey from the
//    Firebase console. It is not a secret and is not enough on
//    its own: set Authorized Domains in Firebase console to the
//    live Pages URL (+ localhost for testing) or anyone can use
//    the key to spam sign-ups against your quota.
//  - NEVER put a Firebase service-account / Admin SDK key here.
//    That key must never reach browser code or a public repo.
//  - idToken expires in ~1 hour. We save refreshToken + expiresAt
//    and refresh in background on boot (app.js init) / before use.
//    Saving idToken alone (the
//    Gemini paste's bug) would break the session after 1 hour.
//  - Sign In and Create Account are SEPARATE flows. Firebase
//    returns INVALID_LOGIN_CREDENTIALS for both wrong password
//    AND non-existent account, on purpose. Never offer "create
//    an account?" on that error — a mistyped password is not a
//    missing account.
//  - Debrid keys / addon manifest URLs are NEVER synced here.
//    Auth only. Firestore sync (Phase 2) must exclude them too.
// ============================================================
const FirebaseAuth = {
    _cfg() {
        try {
            const c = (typeof Config !== 'undefined' && Config.FIREBASE) || {};
            return c;
        } catch (e) { return {}; }
    },

    isConfigured() {
        const c = this._cfg();
        return !!(c && c.apiKey && c.apiKey !== 'PASTE_YOUR_FIREBASE_API_KEY_HERE');
    },

    _friendly(msg) {
        const m = String(msg || 'Authentication failed');
        if (m.indexOf('INVALID_LOGIN_CREDENTIALS') !== -1 || m.indexOf('INVALID_PASSWORD') !== -1) return 'Wrong email or password. If you do not have an account yet, use Create Account.';
        if (m.indexOf('EMAIL_EXISTS') !== -1) return 'An account with this email already exists. Use Sign In instead.';
        if (m.indexOf('EMAIL_NOT_FOUND') !== -1) return 'No account with this email. Use Create Account.';
        if (m.indexOf('WEAK_PASSWORD') !== -1) return 'Password is too weak. Use at least 6 characters.';
        if (m.indexOf('INVALID_EMAIL') !== -1) return 'That email address does not look valid.';
        if (m.indexOf('TOO_MANY_ATTEMPTS_TRY_LATER') !== -1) return 'Too many attempts. Wait a few minutes and try again.';
        if (m.indexOf('USER_DISABLED') !== -1) return 'This account has been disabled.';
        if (m.indexOf('CONFIGURATION_NOT_FOUND') !== -1) return 'Firebase Auth is not enabled yet. Enable Email/Password in Firebase Console > Authentication > Sign-in method.';
        return m.replace(/_/g, ' ');
    },

    async _post(url, body) {
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(12000)
            });
        } catch (e) {
            if (e && e.name === 'AbortError') {
                const err = new Error('Network timed out — check your connection and try again');
                err.code = 'TIMEOUT';
                throw err;
            }
            throw e;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = (data && data.error && data.error.message) || 'Authentication failed';
            const err = new Error(this._friendly(msg));
            err.code = msg;
            throw err;
        }
        return data;
    },

    _toSession(data) {
        const expiresIn = Number(data.expiresIn || 3600);
        return {
            signedIn: true,
            isGuest: false,
            email: data.email || null,
            uid: data.localId || null,
            idToken: data.idToken || null,
            refreshToken: data.refreshToken || null,
            expiresAt: Date.now() + expiresIn * 1000
        };
    },

    async signIn(email, password) {
        const c = this._cfg();
        const data = await this._post(
            'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + encodeURIComponent(c.apiKey),
            { email: email, password: password, returnSecureToken: true }
        );
        return this._toSession(data);
    },

    async signUp(email, password) {
        const c = this._cfg();
        const data = await this._post(
            'https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + encodeURIComponent(c.apiKey),
            { email: email, password: password, returnSecureToken: true }
        );
        return this._toSession(data);
    },

    async sendPasswordReset(email) {
        const c = this._cfg();
        await this._post(
            'https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=' + encodeURIComponent(c.apiKey),
            { requestType: 'PASSWORD_RESET', email: email }
        );
    },

    async _refresh(refreshToken) {
        const c = this._cfg();
        let res;
        try {
            res = await fetch(
                'https://securetoken.googleapis.com/v1/token?key=' + encodeURIComponent(c.apiKey),
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(refreshToken),
                    signal: AbortSignal.timeout(12000)
                }
            );
        } catch (e) {
            if (e && e.name === 'AbortError') {
                const err = new Error('Session refresh failed');
                err.code = 'TIMEOUT';
                throw err;
            }
            throw e;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error('Session refresh failed');
            err.code = (data && data.error && (data.error.message || data.error.status)) || 'REFRESH_FAILED';
            throw err;
        }
        return {
            idToken: data.id_token || null,
            refreshToken: data.refresh_token || refreshToken,
            expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
        };
    },

    // Return a usable idToken, refreshing if it expires within 60s.
    // Returns null only if there is no session or refresh is rejected
    // (e.g. revoked token). Network errors do NOT clear the session:
    // the caller keeps the old token and retries later.
    _refreshPromise: null,
    _lastRefreshPermanent: false,

    async getValidIdToken() {
        /* Deduplicate concurrent refreshes: one in-flight promise,
           cleared on settle so a failure is never cached forever. */
        if (this._refreshPromise) return this._refreshPromise;
        this._refreshPromise = this._getValidIdTokenInner();
        try { return await this._refreshPromise; }
        finally { this._refreshPromise = null; }
    },

    async _getValidIdTokenInner() {
        this._lastRefreshPermanent = false;
        let auth = null;
        try { auth = (typeof Storage !== 'undefined' && Storage.getAuthState()) || null; } catch (e) { auth = null; }
        if (!auth || !auth.signedIn || auth.isGuest) return null;
        if (auth.idToken && auth.expiresAt && auth.expiresAt > Date.now() + 60000) return auth.idToken;
        if (!auth.refreshToken || !this.isConfigured()) return auth.idToken || null;
        try {
            const r = await this._refresh(auth.refreshToken);
            const next = Object.assign({}, auth, { idToken: r.idToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt });
            try { Storage.saveAuthState(next); } catch (e) {}
            return r.idToken;
        } catch (e) {
            const code = String(e.code || '');
            if (code.indexOf('INVALID_REFRESH_TOKEN') !== -1 || code.indexOf('TOKEN_EXPIRED') !== -1 || code.indexOf('USER_DISABLED') !== -1 || code.indexOf('USER_NOT_FOUND') !== -1) {
                this._lastRefreshPermanent = true;
                return null;
            }
            return auth.idToken || null;
        }
    }
};
if (typeof window !== 'undefined') window.FirebaseAuth = FirebaseAuth;
