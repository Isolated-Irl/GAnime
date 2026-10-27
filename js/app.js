// ============================================================
// GAnime — app.js
// Step 2 engine + Step 3 settings + Step 3 Tweaks build:
//  - Add Profile is a full screen (avatar catalog, preview card)
//  - Settings = sidebar tabs (Account / General) with sub-pages
// ============================================================

/* Tracking providers kept for GAnime (Tweak 2): AniList, MyAnimeList, Simkl */
const TRACKING_PROVIDERS = [
    { name: 'AniList',     desc: 'Sync your anime list, progress and scores with AniList.' },
    { name: 'MyAnimeList', desc: 'Sync your anime list and watch history with MyAnimeList.' },
    { name: 'Simkl',       desc: 'Connect Simkl to sync lists, watched history, playback progress, and scrobbles.', visit: 'Visit Simkl' }
];

const App = {
    currentScreen: 'screen-home',
    settingsParent: 'account',     // tab Back returns to from a sub-page
    settingsPage: null,            // null = tab home; else sub-page id
    _np: null,                     // Add Profile draft state

    /* ---------- Boot ---------- */
    init() {
        /* Phase 2 boot sync (2026-10-26): starts immediately, so a
           new browser can pull the cloud profiles BEFORE the
           profile-picker decision below. proceed() awaits it with
           a 5s timeout — a slow/failed sync never blocks boot,
           it just leaves local data untouched. Guests never sync. */
        let bootSyncPromise = null;
        try { if (typeof Sync !== 'undefined') bootSyncPromise = Sync.bootSync(); } catch (e) {}
        this.loadTitleCache();
        this.bindTouchLongPress();
        this.bindHoverDismiss();
        this.bindHashRouting();
        this.handleOAuthCallback();
        /* Background token refresh (audit bundle, Phase 2-ready):
           never blocks boot. Only a permanently revoked token
           (expired + refresh rejected) sends the user to the gate;
           network errors keep the old token and never log out. */
        try {
            if (typeof FirebaseAuth !== 'undefined' && FirebaseAuth.getValidIdToken) {
                FirebaseAuth.getValidIdToken().then(tok => {
                    if (tok) return;
                    try {
                        const a = Storage.getAuthState();
                        if (a && a.signedIn && !a.isGuest && FirebaseAuth._lastRefreshPermanent) {
                            Storage.clearAuthState();
                            this.showGate();
                            alert('Your session was revoked or expired. Please sign in again.');
                        }
                    } catch (e) {}
                }).catch(() => {});
            }
        } catch (e) {}
        this.applyTheme();
        this.renderProfiles();
        /* Splash (2026-10-24, reversed same day at his order):
           first open of a tab plays it; refreshes in the same tab
           skip it via sessionStorage. Logo click still replays
           it (replaySplash clears the skip class). */
        const splash = document.getElementById('splashScreen');
        const proceed = async () => {
            splash.classList.add('hidden');
            splash.classList.remove('splash-fading');
            /* Wait for the boot sync (max 5s) so a pulled cloud
               profile list is in localStorage before we decide
               between picker and shell. Then re-render profiles. */
            let bootResult = null;
            if (bootSyncPromise) {
                try { bootResult = await Promise.race([bootSyncPromise, new Promise(r => setTimeout(() => r({ status: 'timeout' }), 5000))]); } catch (e) { bootResult = { status: 'error' }; }
                try { this.renderProfiles(); } catch (e) {}
            }
            const auth = Storage.getAuthState();
            if (auth.signedIn || auth.isGuest) {
                let savedScreen = '';
                try { savedScreen = (JSON.parse(localStorage.getItem('ganime_last_route') || '{}') || {}).screen || ''; } catch (e) {}
                /* Cloud-unreachable guard (2026-10-26 fix): signed
                   in, the boot pull failed, nothing local — show
                   retry, never create-first. A stale add-profile
                   route is likewise ignored when profiles exist. */
                const bootPullFailed = auth.signedIn && !auth.isGuest && bootResult
                    && (bootResult.status === 'error' || bootResult.status === 'no-token' || bootResult.status === 'timeout');
                if (bootPullFailed && !Storage.getProfiles().length) { this.showCloudRetry(); return; }
                if (savedScreen === 'add-profile') {
                    if (!Storage.getProfiles().length) { this.openAddProfile(); return; }
                    /* else fall through: profiles exist, don't let a
                       stale route hide them behind create-first */
                }
                /* Landing rule (2026-10-26, refined same day):
                   a FRESH tab landing (splash not yet played this
                   tab) always goes to the profile picker page for
                   a session (account or guest), never straight
                   into Home, no matter how many profiles there
                   are — and to the gate when there is no session.
                   A REFRESH in the same tab is different: it
                   resumes where you were (Home stays Home, picker
                   stays picker), which is the 2026-10-24 resume
                   behaviour he saw yesterday inside a profile.
                   `seen` is the sessionStorage splash flag, set
                   below before proceed() ever runs. */
                if (!seen) { this.showProfilePicker(); return; }
                if (savedScreen === 'profile-picker') { this.showProfilePicker(); return; }
                const active = Storage.getActiveProfile();
                if (active) {
                    Storage.setActiveProfileId(active.id);
                    this.launchShell();
                } else {
                    this.showProfilePicker();
                }
            } else {
                this.showGate();
            }
        };
        let seen = false;
        try { seen = !!sessionStorage.getItem('ganime_splash_played'); } catch (e) {}
        if (seen) {
            proceed();
        } else {
            try { sessionStorage.setItem('ganime_splash_played', '1'); } catch (e) {}
            setTimeout(() => {
                splash.classList.add('splash-fading');
                setTimeout(proceed, 520);
            }, 1950);
        }
    },

    /* Hover panel dismissal: #hoverPanel is position:fixed and
       its coordinates are computed once on mouseenter — browsers
       don't reliably fire mouseleave while scrolling, so the
       panel would hang frozen mid-air over a scrolled-away card.
       Scroll events on inner rails don't bubble, so the window
       listener uses capture to catch every scroll on the way
       down, plus wheel/blur/mousedown for the first tick. */
    bindHoverDismiss() {
        if (this._hoverDismissBound) return;
        this._hoverDismissBound = true;
        window.addEventListener('scroll', () => this.hoverOut(), { capture: true, passive: true });
        window.addEventListener('wheel', () => this.hoverOut(), { passive: true });
        window.addEventListener('blur', () => this.hoverOut());
        document.addEventListener('mousedown', () => this.hoverOut(), { passive: true });
    },

    /* Touch long-press on poster cards (Fix 12): the mobile
       counterpart of the desktop hover panel — a small action
       sheet instead of navigation. */
    bindTouchLongPress() {
        if (this._lpBound) return;
        this._lpBound = true;
        let timer = null;
        let startEl = null;
        const clear = () => { if (timer) clearTimeout(timer); timer = null; startEl = null; };
        document.addEventListener('touchstart', e => {
            const card = e.target && e.target.closest ? e.target.closest('.poster-card') : null;
            if (!card || !card.dataset.tid) return;
            startEl = card;
            const id = card.dataset.tid;
            timer = setTimeout(() => {
                timer = null;
                this.openPosterActions(id);
            }, 550);
        }, { passive: true });
        document.addEventListener('touchmove', clear, { passive: true });
        document.addEventListener('touchend', e => {
            /* A fired long-press must not also trigger the tap. */
            if (!timer && startEl && e.target && startEl.contains(e.target)) e.preventDefault();
            clear();
        }, { passive: false });
    },

    openPosterActions(id) {
        const t = this.titleById(id);
        if (!t) return;
        const entry = Storage.getLocalEntry(id);
        this.openModal(`
            <h3 class="modal-title">${this._escEp(t.title)}</h3>
            <button class="btn-primary" onclick="App.closeModal(); App.openDetails('${id}')">Open Details</button>
            ${['Watching', 'Plan to Watch', 'Completed'].map(s => `<button class="btn-secondary" onclick="App.closeModal(); Storage.setLocalStatus('${id}', '${s}', App.titleMeta(App.titleById('${id}'))); if (App.currentScreen === 'screen-library') App.renderLibrary();">${entry && entry.status === s ? '✓ ' : ''}${s}</button>`).join('')}
            <button class="btn-secondary" onclick="App.closeModal()">Close</button>
        `);
    },

    showGate() {
        this._clearAuthPassword();
        Storage.clearActiveProfileId();
        localStorage.removeItem('ganime_last_route');
        document.getElementById('addProfileScreen').classList.add('hidden');
        document.getElementById('profilePickerScreen').classList.add('hidden');
        /* Bug 3 (2026-10-26 audit): when the gate fires mid-app
           (e.g. token revoked), the app shell behind it must hide
           too, or the gate renders over the main UI. launchShell
           re-shows both on the next sign-in. */
        document.getElementById('appViewport').classList.add('hidden');
        document.getElementById('floatingNav').classList.add('hidden');
        document.getElementById('authGateScreen').classList.remove('hidden');
    },

    showProfilePicker() {
        /* No profiles yet = create-first (2026-10-23 ruling):
           there is no default profile to fall back to, so the
           picker is skipped straight to Add Profile. */
        if (!Storage.getProfiles().length) { this.openAddProfile(); return; }
        /* Choosing a profile = no profile open: clear the active
           id and record the picker in the route, so a refresh
           here stays here instead of resuming into the app. */
        Storage.clearActiveProfileId();
        try { localStorage.setItem('ganime_last_route', JSON.stringify({ screen: 'profile-picker', at: Date.now() })); } catch (e) {}
        this.renderProfiles();
        document.getElementById('authGateScreen').classList.add('hidden');
        document.getElementById('addProfileScreen').classList.add('hidden');
        document.getElementById('appViewport').classList.add('hidden');
        document.getElementById('floatingNav').classList.add('hidden');
        document.getElementById('profilePickerScreen').classList.remove('hidden');
    },

    /* ---------- Auth: Firebase (Spark, REST) — Phase 1 ----------
       The old skeleton ("any input signs in") is GONE. If Firebase
       is not configured, Sign In / Create Account do NOT fake a
       login — they tell the user to use Guest mode until a Firebase
       project is connected. Sign In and Create Account are separate:
       never offer creation on a wrong-password error. */
    _clearAuthPassword() {
        const pw = document.getElementById('authPassword');
        if (pw) pw.value = '';
    },

    _authFormValues() {
        const em = document.getElementById('authEmail');
        const pw = document.getElementById('authPassword');
        return { email: em ? em.value.trim() : '', password: pw ? pw.value : '' };
    },

    _authBusy(btn, busy) {
        if (!btn) return;
        if (busy) { btn.disabled = true; btn.dataset._label = btn.textContent; btn.textContent = 'Please wait…'; }
        else { btn.disabled = false; if (btn.dataset._label) btn.textContent = btn.dataset._label; }
    },

    async handleSignIn(event) {
        if (event) event.preventDefault();
        const { email, password } = this._authFormValues();
        if (!email || !password) { alert('Enter your email and password.'); return; }
        if (typeof FirebaseAuth === 'undefined' || !FirebaseAuth.isConfigured()) {
            alert('Live login is not connected yet. Use "Continue without an account" (Guest mode) for now — your data stays on this device until Firebase is connected.');
            return;
        }
        const btn = event && event.target ? event.target.querySelector('button[type="submit"]') : null;
        this._authBusy(btn, true);
        try {
            const session = await FirebaseAuth.signIn(email, password);
            this._clearAuthPassword();
            Storage.saveAuthState(session);
            /* Sign-in pull (2026-10-26 fix): sign-in used to go
               straight to the picker on local data only, so a
               wiped device was pushed to create a brand-new
               profile even though the cloud had its profiles. */
            await this._pullThenRoute();
        } catch (err) {
            alert('Sign-in error: ' + (err && err.message ? err.message : 'Authentication failed'));
        } finally { this._authBusy(btn, false); }
    },

    /* Pull-then-route (2026-10-26 fix): a FRESH syncNow, not the
       bootSync memoized at page boot when there was no session
       (that one stays "skipped" forever). Success, or local
       profiles already present, goes to the picker; a failed pull
       with nothing local goes to the retry screen, never straight
       to create-first. A failed pull still routes to the picker
       when local profiles exist (fail open to local). */
    async _pullThenRoute() {
        let res = null;
        try {
            if (typeof Sync !== 'undefined' && Sync.syncNow) {
                res = await Promise.race([
                    Sync.syncNow({}),
                    new Promise(r => setTimeout(() => r({ status: 'timeout' }), 8000))
                ]);
            }
        } catch (e) { res = { status: 'error' }; }
        /* Bug 2 (2026-10-26 audit): bootSync memoized 'skipped' at
           page boot (no session) never set _bootDone, and syncNow
           doesn't either — so pushOnly could never early-return
           clean after a sign-in pull. Mark boot done, but only on
           a successful pull (a failed pull must not claim it). */
        try {
            if (res && ['pulled', 'merged', 'pushed', 'empty'].includes(res.status)
                && typeof Sync !== 'undefined') Sync._bootDone = true;
        } catch (e) {}
        const failed = res && (res.status === 'error' || res.status === 'no-token' || res.status === 'timeout');
        if (failed && !Storage.getProfiles().length) { this.showCloudRetry(); return; }
        this.showProfilePicker();
    },

    /* Cloud-unreachable screen (2026-10-26 fix): Retry re-runs
       the pull; "Continue on this device" is the user's explicit
       choice to proceed local-only (the old behaviour), never a
       silent push toward creating a duplicate profile. */
    showCloudRetry() {
        this.openModal(`
            <h3 class="modal-title">Couldn't reach your cloud</h3>
            <p class="text-secondary">Your profiles live in the cloud, but the app couldn't reach it just now. Check your connection and try again — don't create a new profile yet, or you'll end up with a duplicate.</p>
            <button class="btn-primary" onclick="App.closeModal(); App._pullThenRoute()">Retry</button>
            <button class="btn-secondary" onclick="App.closeModal(); App.showProfilePicker()">Continue on this device</button>
        `);
    },

    async handleSignUp(btn) {
        const { email, password } = this._authFormValues();
        if (!email || !password) { alert('Enter your email and password.'); return; }
        if (typeof FirebaseAuth === 'undefined' || !FirebaseAuth.isConfigured()) {
            alert('Live login is not connected yet. Use "Continue without an account" (Guest mode) for now.');
            return;
        }
        if (password.length < 6) { alert('Password must be at least 6 characters.'); return; }
        this._authBusy(btn, true);
        try {
            const session = await FirebaseAuth.signUp(email, password);
            this._clearAuthPassword();
            Storage.saveAuthState(session);
            /* Same sign-in pull as handleSignIn: a fresh account
               pulls (empty cloud) and lands on create-first, while
               an existing device's local profiles push up. */
            await this._pullThenRoute();
        } catch (err) {
            alert('Create account error: ' + (err && err.message ? err.message : 'Authentication failed'));
        } finally { this._authBusy(btn, false); }
    },

    async handleForgotPassword() {
        const { email } = this._authFormValues();
        if (!email) { alert('Enter your email first, then tap Forgot password.'); return; }
        if (typeof FirebaseAuth === 'undefined' || !FirebaseAuth.isConfigured()) {
            alert('Live login is not connected yet.'); return;
        }
        try {
            await FirebaseAuth.sendPasswordReset(email);
            alert('If an account exists for that email, a password reset link has been sent.');
        } catch (err) {
            alert('If an account exists for that email, a password reset link has been sent.');
        }
    },

    enterGuestMode() {
        Storage.saveAuthState({ signedIn: false, isGuest: true, email: null });
        this.showProfilePicker();
    },

    signOut() {
        /* clearAuthState removes the whole stored session, including
           Firebase idToken + refreshToken (they live in that object). */
        Storage.clearAuthState();
        this.settingsPage = null;
        document.getElementById('appViewport').classList.add('hidden');
        document.getElementById('floatingNav').classList.add('hidden');
        this.showGate();
    },

    /* ---------- Avatars ---------- */
    avatarOf(profile) {
        return Config.AVATAR_CATALOG.find(a => a.name === (profile && profile.avatarName)) || Config.AVATAR_CATALOG[0];
    },

    profileAvatarHTML(profile, cls) {
        cls = cls || '';
        if (profile && profile.avatarUrl && /^https?:\/\//i.test(String(profile.avatarUrl).trim())) {
            return `<span class="profile-avatar ${cls}"><img src="${this.esc(profile.avatarUrl)}" alt=""></span>`;
        }
        const av = this.avatarOf(profile);
        return `<span class="profile-avatar ${cls}" style="background:${av.bg}">${av.emoji}</span>`;
    },

    /* ---------- Profiles ---------- */
    renderProfiles() {
        const grid = document.getElementById('profilesGridContainer');
        if (!grid) return;
        const profiles = Storage.getProfiles();
        const limit = Config.PROFILE_LIMIT || 3;
        const atLimit = profiles.length >= limit;
        grid.innerHTML = profiles.map(p => `
            <button class="profile-card" onclick="App.selectProfile('${p.id}')">
                ${this.profileAvatarHTML(p)}
                <span class="profile-name">${this.esc(p.name)}</span>
                ${p.isPrimary ? '<span class="primary-badge">PRIMARY</span>' : ''}
            </button>
        `).join('') + (atLimit ? `
            <div class="profile-card add-card is-disabled" aria-disabled="true">
                <span class="profile-avatar add-avatar">✓</span>
                <span class="profile-name">Profile limit reached (${profiles.length}/${limit})</span>
            </div>` : `
            <button class="profile-card add-card" onclick="App.openAddProfile()">
                <span class="profile-avatar add-avatar">+</span>
                <span class="profile-name">Add Profile</span>
            </button>`);
    },

    selectProfile(id) {
        Storage.setActiveProfileId(id);
        this.applyTheme();
        document.getElementById('profilePickerScreen').classList.add('hidden');
        /* Tapping a profile = a fresh start at Home (2026-10-24),
           NOT a resume of the page left before. (Fresh-tab boot
           lands on the picker per the 2026-10-26 landing rule;
           same-tab refresh resumes instead.) */
        this.launchShell(true);
    },

    nextProfileName() {
        const profiles = Storage.getProfiles();
        let n = profiles.length + 1;
        while (profiles.some(p => p.name === 'Profile ' + n)) n++;
        return 'Profile ' + n;
    },

    /* ----- Add Profile screen (Tweak 1) ----- */
    openAddProfile() {
        const profiles = Storage.getProfiles();
        if (profiles.length >= (Config.PROFILE_LIMIT || 3)) {
            this.openModal(`
                <h3 class="modal-title">Profile limit reached</h3>
                <p class="text-secondary">GAnime supports up to ${Config.PROFILE_LIMIT || 3} profiles. Delete one from Manage Profiles to add another.</p>
                <button class="btn-secondary" onclick="App.closeModal()">Close</button>
            `);
            return;
        }
        try { localStorage.setItem('ganime_last_route', JSON.stringify({ screen: 'add-profile', at: Date.now() })); } catch (e) {}
        this._editId = null;
        this._np = { name: '', avatarName: 'Bram', avatarUrl: '', usePrimaryAddons: false };
        document.getElementById('profilePickerScreen').classList.add('hidden');
        document.getElementById('authGateScreen').classList.add('hidden');
        document.getElementById('addProfileScreen').classList.remove('hidden');
        this.renderAddProfile();
    },

    closeAddProfile() {
        document.getElementById('addProfileScreen').classList.add('hidden');
        this.showProfilePicker();
    },

    renderAddProfile() {
        const root = document.getElementById('addProfileRoot');
        if (!root || !this._np) return;
        const np = this._np;
        /* Edit mode (2026-10-26): the same full form, pre-filled,
           with Save instead of Create. The Use Primary Addons row
           only makes sense for a secondary profile: it is hidden
           when creating the first profile (which becomes primary)
           and when editing the primary profile itself. */
        const editing = this._editId ? Storage.getProfile(this._editId) : null;
        const showPrimaryToggle = editing ? !editing.isPrimary : (Storage.getProfiles().length > 0);
        const av = Config.AVATAR_CATALOG.find(a => a.name === np.avatarName) || Config.AVATAR_CATALOG[0];
        const previewAvatar = (np.avatarUrl && /^https?:\/\//i.test(String(np.avatarUrl).trim()))
            ? `<span class="profile-avatar lg-avatar"><img src="${this.esc(np.avatarUrl)}" alt=""></span>`
            : `<span class="profile-avatar lg-avatar" style="background:${av.bg}">${av.emoji}</span>`;
        const catalog = Config.AVATAR_CATALOG.map(a => `
            <button class="avatar-option ${np.avatarName === a.name && !np.avatarUrl ? 'active' : ''}" title="${a.name}"
                style="background:${a.bg}" onclick="App.npSetAvatar('${a.name}')">${a.emoji}</button>
        `).join('');
        root.innerHTML = `
            <div class="subpage-header">
                ${Storage.getProfiles().length ? `<button class="back-btn" onclick="App.${editing ? 'closeEditProfilePage' : 'closeAddProfile'}()">←</button>` : ''}
                <h2 class="subpage-title">${editing ? 'Edit Profile' : 'Add Profile'}</h2>
            </div>
            ${Storage.getProfiles().length ? '' : '<p class="gate-subtext" style="margin-bottom:14px">Create your first profile to start using GAnime.</p>'}

            <div class="np-preview-card">
                ${previewAvatar}
                <div class="np-preview-text">
                    <div class="np-preview-title">${this.esc(np.name.trim()) || 'New profile'}</div>
                    <div class="setting-desc">${showPrimaryToggle ? `Primary addons ${np.usePrimaryAddons ? 'on' : 'off'}` : 'Primary profile'}</div>
                    <div class="setting-desc">Avatar: ${np.avatarUrl ? 'Custom URL' : av.name}</div>
                </div>
            </div>

            <input type="text" class="app-input" placeholder="Profile name" value="${this.esc(np.name)}"
                oninput="App.npSetName(this.value)">

            ${showPrimaryToggle ? `
            <div class="settings-group">
                <div class="setting-row">
                    <div class="setting-text">
                        <div class="setting-label">Use Primary Addons</div>
                        <div class="setting-desc">Share the main profile's addon setup instead of managing a separate list.</div>
                    </div>
                    <label class="switch">
                        <input type="checkbox" ${np.usePrimaryAddons ? 'checked' : ''} onchange="App.npSetPrimaryAddons(this.checked)">
                        <span class="switch-track"></span>
                    </label>
                </div>
            </div>` : ''}

            <div class="np-block">
                <div class="setting-label">Custom avatar URL</div>
                <div class="setting-desc">Paste an image link, or leave this empty to use the built-in avatar catalog.</div>
                <input type="text" class="app-input" placeholder="https://example.com/avatar.png" value="${this.esc(np.avatarUrl)}"
                    oninput="App.npSetUrl(this.value)">
            </div>

            <div class="np-block">
                <div class="setting-label">Choose an avatar</div>
                <div class="setting-desc">${np.avatarUrl ? 'Custom URL in use' : av.name}</div>
                <div class="avatar-grid">${catalog}</div>
            </div>

            ${editing ? `<button class="btn-primary" onclick="App.saveProfilePage()">Save</button>` : `<button class="btn-primary" onclick="App.createProfile()">Create Profile</button>`}
        `;
    },

    npSetName(value) {
        this._np.name = value;
        const title = document.querySelector('.np-preview-title');
        if (title) title.textContent = value.trim() || 'New profile';
    },

    npSetUrl(value) {
        this._np.avatarUrl = value.trim();
        this.renderAddProfile();
        const input = document.querySelector('#addProfileRoot .np-block .app-input');
        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    },

    npSetAvatar(name) {
        this._np.avatarName = name;
        this._np.avatarUrl = '';
        this.renderAddProfile();
    },

    npSetPrimaryAddons(checked) {
        this._np.usePrimaryAddons = checked;
        this.renderAddProfile();
    },

    createProfile() {
        const profiles = Storage.getProfiles();
        if (profiles.length >= (Config.PROFILE_LIMIT || 3)) { this.openAddProfile(); return; }
        const preset = Config.ACCENT_PRESETS[profiles.length % Config.ACCENT_PRESETS.length];
        profiles.push({
            id: 'p' + Date.now(),
            name: this._np.name.trim() || this.nextProfileName(),
            isPrimary: profiles.length === 0,
            color: preset.color,
            avatarName: this._np.avatarName,
            avatarUrl: this._np.avatarUrl,
            usePrimaryAddons: this._np.usePrimaryAddons,
            pin: '',
            backgroundUrl: ''
        });
        Storage.saveProfiles(profiles);
        this.closeAddProfile();
    },

    openManageProfilesModal() {
        const profiles = Storage.getProfiles();
        const rows = profiles.map(p => `
            <div class="manage-row">
                ${this.profileAvatarHTML(p, 'small')}
                <span class="manage-name">${this.esc(p.name)}${p.isPrimary ? ' · PRIMARY' : ''}</span>
                <button class="btn-mini" onclick="App.editProfile('${p.id}')">Edit</button>
                ${profiles.length > 1 ? `<button class="btn-mini danger" onclick="App.deleteProfile('${p.id}')">Delete</button>` : ''}
            </div>
        `).join('');
        this.openModal(`
            <h3 class="modal-title">Manage Profiles</h3>
            <div class="manage-list">${rows}</div>
            <button class="btn-secondary" onclick="App.closeModal()">Done</button>
        `);
    },

    /* Full-page Edit (2026-10-26): Edit no longer opens a small
       name+avatar popup — it opens the SAME full form as Add
       Profile (name, custom avatar URL, avatar picker, and the
       Use Primary Addons row for secondary profiles), pre-filled,
       with Save instead of Create. Back returns to Manage
       Profiles, which lives on the picker screen. */
    editProfile(id) {
        this.openEditProfilePage(id);
    },

    openEditProfilePage(id) {
        const profile = Storage.getProfile(id);
        if (!profile) return;
        this.closeModal();
        this._editId = id;
        this._np = {
            name: profile.name || '',
            avatarName: profile.avatarName || Config.AVATAR_CATALOG[0].name,
            avatarUrl: profile.avatarUrl || '',
            usePrimaryAddons: !!profile.usePrimaryAddons
        };
        document.getElementById('profilePickerScreen').classList.add('hidden');
        document.getElementById('authGateScreen').classList.add('hidden');
        document.getElementById('appViewport').classList.add('hidden');
        document.getElementById('floatingNav').classList.add('hidden');
        document.getElementById('addProfileScreen').classList.remove('hidden');
        this.renderAddProfile();
    },

    closeEditProfilePage() {
        this._editId = null;
        document.getElementById('addProfileScreen').classList.add('hidden');
        document.getElementById('profilePickerScreen').classList.remove('hidden');
        this.openManageProfilesModal();
    },

    saveProfilePage() {
        const profile = Storage.getProfile(this._editId);
        if (!profile || !this._np) return;
        const profiles = Storage.getProfiles();
        const target = profiles.find(p => p.id === this._editId);
        if (!target) return;
        const name = (this._np.name || '').trim();
        if (name) target.name = name;
        target.avatarName = this._np.avatarName || target.avatarName;
        target.avatarUrl = this._np.avatarUrl || '';
        /* A primary profile never shares addons (its row is
           hidden), so its flag is forced off; a secondary
           follows the toggle. Other fields (id, isPrimary,
           color, pin, background) are preserved untouched. */
        target.usePrimaryAddons = target.isPrimary ? false : !!this._np.usePrimaryAddons;
        Storage.saveProfiles(profiles);
        this.renderProfiles();
        this.renderTopBar();
        this.closeEditProfilePage();
    },

    /* Delete rules (2026-10-26, his corrections):
       - Only 1 profile: no Delete button at all (the Manage
         modal hides it) — the last profile cannot be deleted.
       - 2+ profiles, deleting the primary: the first remaining
         profile becomes primary. If any remaining profile shares
         the primary's addons, a warning popup comes FIRST: on
         confirm, the primary's addon list is copied to the new
         primary (or unioned with its own live list if it was not
         sharing, so nothing is lost), and only then is the old
         primary deleted. A sharing profile's own stored key is
         stale by definition (its writes went to the primary),
         so it is never unioned back in. */
    deleteProfile(id) {
        const profiles = Storage.getProfiles();
        if (profiles.length <= 1) return;
        const target = profiles.find(p => p.id === id);
        if (!target) return;
        const remaining = profiles.filter(p => p.id !== id);
        if (target.isPrimary && remaining.some(p => p.usePrimaryAddons)) {
            const sharers = remaining.filter(p => p.usePrimaryAddons).map(p => p.name).join(', ');
            const next = remaining[0];
            this.openModal(`
                <h3 class="modal-title">Delete the primary profile?</h3>
                <p class="text-secondary">${this.esc(sharers)} use${remaining.filter(p => p.usePrimaryAddons).length > 1 ? '' : 's'} the primary profile's addons. Deleting it will copy that addon list to ${this.esc(next.name)}, which will become the new primary — nothing will be lost.</p>
                <div style="display:flex;gap:10px">
                    <button class="btn-secondary" style="color:#f87171; border-color:rgba(248,113,113,0.3)" onclick="App.deleteProfileConfirmed('${id}')">Delete anyway</button>
                    <button class="btn-secondary" onclick="App.openManageProfilesModal()">Cancel</button>
                </div>
            `);
            return;
        }
        if (!confirm('Delete this profile? Its settings will be removed.')) return;
        this._doDeleteProfile(id);
    },

    deleteProfileConfirmed(id) {
        this._doDeleteProfile(id);
    },

    _doDeleteProfile(id) {
        const profiles = Storage.getProfiles();
        const target = profiles.find(p => p.id === id);
        if (!target) return;
        /* Sync tombstone (2026-10-26): without this, the union
           merge resurrects the deleted profile from the other
           device's copy on the next sync. */
        try { if (typeof Sync !== 'undefined' && Sync.recordDeleted) Sync.recordDeleted('profiles', id, id); } catch (e) {}
        const remaining = profiles.filter(p => p.id !== id);
        const wasPrimary = !!target.isPrimary;
        const wasActive = Storage.getActiveProfileId() === id;
        /* Read the primary's addon list BEFORE deleting anything.
           For a primary, getAddonOwnerId returns itself, so this
           is its own live list. For a non-primary it is unused. */
        let primaryAddons = null;
        if (wasPrimary) {
            try { primaryAddons = Storage.getAddons(id) || []; } catch (e) { primaryAddons = []; }
        }
        /* Promote first remaining to primary (flag + sharing off)
           BEFORE writing its addon list, so saveAddons resolves
           to its own key, not the old primary's. */
        if (wasPrimary && remaining.length) {
            const next = remaining[0];
            const wasSharing = !!next.usePrimaryAddons;
            next.isPrimary = true;
            next.usePrimaryAddons = false;
            Storage.saveProfiles(remaining);
            if (primaryAddons && primaryAddons.length) {
                let own = [];
                if (!wasSharing) {
                    try { own = JSON.parse(localStorage.getItem('ganime_addons_' + next.id) || '[]') || []; } catch (e) { own = []; }
                }
                const seen = new Set(own.map(a => a.manifestUrl || a.id));
                const merged = own.slice();
                primaryAddons.forEach(a => {
                    const key = a.manifestUrl || a.id;
                    if (key && !seen.has(key)) { seen.add(key); merged.push(a); }
                });
                Storage.saveAddons(merged, next.id);
            }
        } else {
            Storage.saveProfiles(remaining);
        }
        for (const key of ['ganime_settings_', 'ganime_addons_', 'ganime_watched_', 'ganime_locallib_', 'ganime_tracking_', 'ganime_mylist_']) {
            localStorage.removeItem(key + id);
        }
        /* Delete-done rule (2026-10-26 fix): a delete isn't done
           until its tombstone is in the cloud. Push right now
           instead of waiting for the 3s debounce — if it fails,
           the dirty flag plus the next sign-in pull send it.
           Guest deletes skip (pushOnly is signed-in-only). */
        try { if (typeof Sync !== 'undefined' && Sync.pushOnly) Sync.pushOnly().catch(() => {}); } catch (e) {}
        if (wasActive) {
            /* You deleted the profile you were using — back to
               the picker (the landing rule's home base), not a
               silent switch to somebody else's profile. */
            Storage.clearActiveProfileId();
            this.closeModal();
            const left = Storage.getProfiles();
            if (!left.length) { this.openAddProfile(); return; }
            this.showProfilePicker();
            return;
        }
        this.renderProfiles();
        this.openManageProfilesModal();
    },

    returnToProfilePicker() {
        this.showProfilePicker();
    },

    /* ---------- Device link (skeleton: shows a pairing code) ---------- */
    openDeviceLinkModal() {
        const code = 'GAN-' + Math.random().toString(36).slice(2, 6).toUpperCase();
        this.openModal(`
            <h3 class="modal-title">Link with another device</h3>
            <p class="text-secondary">Open GAnime on your other device, choose "Link with another device", and enter this code:</p>
            <div class="device-code">${code}</div>
            <p class="text-secondary">Device linking is a skeleton in this build — the code is not verified yet.</p>
            <button class="btn-secondary" onclick="App.closeModal()">Close</button>
        `);
    },

    /* ---------- Shell + navigation ---------- */
    launchShell(toHome) {
        document.getElementById('appViewport').classList.remove('hidden');
        document.getElementById('floatingNav').classList.remove('hidden');
        this.applyTheme();
        this.renderProfileHeader();
        this.renderSettings();
        this.renderHome();
        this.renderTopBar();
        this.shellLaunched = true;
        /* OAuth landing (audit bundle): if the AniList callback
           finished during the splash, boot restored Home and the
           connection was saved with no landing. A pending flag
           set by handleOAuthCallback() sends the user to
           Profile → Tracking instead. */
        if (this._pendingOAuthLanding) {
            this._pendingOAuthLanding = false;
            this.settingsPage = 'tracking';
            this.navigate('screen-profile');
            return;
        }
        /* toHome (manual profile tap) = fresh start at Home.
           Refresh-restore (Fix 11, boot path only): reopen where
           the user was, not Home, whenever a saved route exists. */
        if (toHome) { this.navigate('screen-home'); return; }
        if (!this.restoreRoute()) this.navigate('screen-home');
    },

    /* ---------- Top bar (Fix 1) + slide-expand profile swap ----------
       His spec (2026-10-23/24): tapping the profile chip makes it
       SLIDE and EXPAND in place, revealing the other profiles
       inline — no dropdown panel. With only ONE profile, tapping
       does nothing (the chip renders static, no caret). */
    renderTopBar() {
        const box = document.getElementById('tbSwap');
        if (!box) return;
        const profiles = Storage.getProfiles();
        const profile = Storage.getActiveProfile();
        if (!profile) { box.innerHTML = ''; return; }
        if (profiles.length <= 1) {
            /* Home avatar rule (2026-10-26): with a single profile
               there is no switcher to open, so the chip is a plain
               button straight to the picker page — no dropdown. */
            box.classList.remove('open');
            box.innerHTML = `<button class="tb-chip" title="Profiles" onclick="App.returnToProfilePicker()">${this.profileAvatarHTML(profile, 'tb-avatar')}<span class="tb-chip-name">${this.esc(profile.name)}</span></button>`;
            return;
        }
        const others = profiles.filter(p => p.id !== profile.id);
        box.innerHTML = `
            <button class="tb-chip" onclick="App.tbToggle(event)">${this.profileAvatarHTML(profile, 'tb-avatar')}<span class="tb-chip-name">${this.esc(profile.name)}</span><span class="tb-caret">▾</span></button>
            <span class="tb-alts">${others.map(p => `
                <button class="tb-alt" title="${this.esc(p.name)}" onclick="App.quickSwapProfile('${p.id}')">${this.profileAvatarHTML(p, 'tb-avatar')}<span class="tb-alt-name">${this.esc(p.name)}</span></button>`).join('')}
                <button class="tb-alt tb-alt-all" title="All profiles" onclick="App.returnToProfilePicker()">⋯</button>
            </span>`;
    },

    tbToggle(ev) {
        if (ev) ev.stopPropagation();
        const box = document.getElementById('tbSwap');
        if (!box) return;
        const opening = !box.classList.contains('open');
        box.classList.toggle('open', opening);
        if (opening) {
            const off = e => {
                if (!box.contains(e.target)) { this.tbClose(); document.removeEventListener('click', off); }
            };
            setTimeout(() => document.addEventListener('click', off), 0);
        }
    },

    tbClose() {
        const box = document.getElementById('tbSwap');
        if (box) box.classList.remove('open');
    },

    /* Top-bar logo click (his spec, 2026-10-24): play the FULL
       splash animation, refresh Home, and stay there. (The logo
       no longer opens the Profile page — that's the nav's
       Profile tab.) */
    logoHome() {
        this.tbClose();
        this.navigate('screen-home');
        window.scrollTo(0, 0);
        this.lastHomeFetch = 0;
        if (this.shellLaunched) this.loadLiveHome();
        this.replaySplash();
    },

    replaySplash() {
        const splash = document.getElementById('splashScreen');
        if (!splash) return;
        /* Restart the CSS animations by replacing the SVG node —
           a fresh node replays every keyframe from zero. */
        const svg = splash.querySelector('svg');
        if (svg) { const clone = svg.cloneNode(true); svg.replaceWith(clone); }
        document.documentElement.classList.remove('splash-skip');
        splash.classList.remove('hidden', 'splash-fading');
        clearTimeout(this._splashReplayTimer);
        this._splashReplayTimer = setTimeout(() => {
            splash.classList.add('splash-fading');
            setTimeout(() => {
                splash.classList.add('hidden');
                splash.classList.remove('splash-fading');
            }, 520);
        }, 1950);
    },

    quickSwapProfile(id) {
        this.tbClose();
        if (id === Storage.getActiveProfileId()) return;
        Storage.setActiveProfileId(id);
        /* Swapping profiles is a fresh start, not a re-render of
           wherever you were: drop the old profile's tracker/page
           state and land on Home (his rule, same as tapping a
           profile card). */
        this.trackingLists = null;
        this.trackingListsAt = 0;
        this.trackingError = '';
        this.settingsPage = 'account';
        this.applyTheme();
        this.renderTopBar();
        this.renderProfileHeader();
        this.renderSettings();
        this.renderHome();
        this.renderCalendar();
        this.navigate('screen-home');
    },

    /* URL hash routing: every navigate() also writes the screen
       into location.hash (no reload), so Back/Forward, bookmarks
       and refreshes all land on the real screen instead of the
       app guessing from localStorage alone. Picker/gate screens
       never navigate, so they never write a hash — and boot
       checks those gates before any hash, by design. */
    syncHash() {
        let hash = (this.currentScreen || '').replace(/^screen-/, '');
        if (this.currentScreen === 'screen-details' && this.currentTitleId) hash = 'details/' + this.currentTitleId;
        if (this.currentScreen === 'screen-streams' && this.streamsState) {
            hash = 'streams/' + this.streamsState.titleId + (this.streamsState.episode ? '/ep' + this.streamsState.episode : '');
        }
        if (!hash) return;
        const want = '#' + hash;
        if (window.location.hash !== want) { this._hashSync = true; window.location.hash = want; }
    },

    bindHashRouting() {
        if (this._hashBound) return;
        this._hashBound = true;
        window.addEventListener('hashchange', () => {
            /* Our own syncHash write fires this too — swallow it. */
            if (this._hashSync) { this._hashSync = false; return; }
            this.restoreFromHash();
        });
    },

    restoreFromHash() {
        if (!this.shellLaunched) return false;
        /* Hash leak (2026-10-25 final): browser Back while the player
           is open must close the player, not change screens underneath
           the overlay. Close, restore the hash to the current screen
           (syncHash swallows its own hashchange), and swallow this one. */
        const _ov = document.getElementById('playerOverlay');
        if (_ov && !_ov.classList.contains('hidden') && typeof Player !== 'undefined' && Player.close) {
            Player.close();
            this.syncHash();
            return true;
        }
        const raw = (window.location.hash || '').replace(/^#/, '');
        if (!raw) return false;
        const parts = raw.split('/');
        if (parts[0] === 'details' && parts[1]) {
            if (this.currentScreen !== 'screen-details' || this.currentTitleId !== parts[1]) this.openDetails(parts[1]);
            return true;
        }
        if (parts[0] === 'streams' && parts[1]) {
            const ep = parts[2] ? (parseInt(parts[2].replace(/^ep/, ''), 10) || null) : null;
            this.openStreams(parts[1], ep);
            return true;
        }
        const target = 'screen-' + parts[0];
        if (document.getElementById(target)) {
            if (this.currentScreen !== target) this.navigate(target);
            return true;
        }
        return false;
    },

    /* ---------- Refresh-restore (Fix 11) ---------- */
    persistRoute() {
        try {
            const route = { screen: this.currentScreen, at: Date.now() };
            if (this.currentScreen === 'screen-details' && this.currentTitleId) {
                route.detailsId = this.currentTitleId;
                route.meta = this.titleMeta(this.titleById(this.currentTitleId));
            }
            if (this.currentScreen === 'screen-streams' && this.streamsState) {
                route.streamsTitleId = this.streamsState.titleId;
                route.streamsEpisode = this.streamsState.episode;
                route.meta = this.titleMeta(this.titleById(this.streamsState.titleId));
            }
            localStorage.setItem('ganime_last_route', JSON.stringify(route));
        } catch (e) { /* storage full/blocked — restore is a bonus */ }
    },

    restoreRoute() {
        /* A URL hash, when present, outranks the stored route —
           it's the address the user actually asked for (bookmark,
           Back button, shared link). Without one, the stored
           route logic below runs exactly as before. */
        if (this.restoreFromHash()) return true;
        try {
            const raw = localStorage.getItem('ganime_last_route');
            if (!raw) return false;
            const route = JSON.parse(raw);
            if (!route || !route.screen) return false;
            const seedId = route.detailsId || route.streamsTitleId;
            if (seedId && !this.titleCache[seedId] && route.meta && route.meta.title) {
                /* Cold boot: the cache is empty and titleById would
                   fall back to the sample Frieren entry. Seed the
                   real title from the persisted route meta first,
                   then hydrate the full record in the background. */
                this.titleCache[seedId] = {
                    id: seedId, title: route.meta.title, poster: route.meta.poster || '',
                    cover: route.meta.cover || '', eps: route.meta.total || 0,
                    anilistId: route.meta.anilistId || parseInt(String(seedId).replace(/^a/, ''), 10) || null,
                    year: route.meta.year || '—', hue: route.meta.hue || 210,
                    type: route.meta.type || 'TV', score: '—', synopsis: '', genres: []
                };
                if (/^a\d+$/.test(seedId)) {
                    AniList.byId(seedId).then(full => {
                        if (!full) return;
                        this.cacheTitles([full]);
                        if (this.currentScreen === 'screen-details') { this.loadEpisodeData(full); this.renderDetails(); }
                        if (this.currentScreen === 'screen-streams') this.renderStreams();
                    }).catch(() => { /* seeded meta already renders */ });
                }
            }
            if (route.screen === 'screen-details' && route.detailsId) { this.openDetails(route.detailsId); return true; }
            if (route.screen === 'screen-streams' && route.streamsTitleId) { this.openStreams(route.streamsTitleId, route.streamsEpisode || null); return true; }
            if (['screen-home', 'screen-search', 'screen-calendar', 'screen-library', 'screen-profile'].includes(route.screen)) {
                this.navigate(route.screen);
                return true;
            }
        } catch (e) { /* fall through to Home */ }
        return false;
    },
    shellLaunched: false,

    /* ---------- Calendar: day strip + week navigation + row list ---------- */
    calPool: null,        // live entries grouped by JS weekday; null = sample pool
    calLoading: false,      // a calendar fetch is in flight (prevents dupes)
    calFailed: false,       // last calendar fetch failed — tab visits retry, footer offers Retry
    calWeekOffset: 0,     // 0 = this week, -1 = last week, +1 = next week…
    calSelectedIdx: null, // 0 = Monday … 6 = Sunday (defaults to today)

    calSamplePool() {
        const pool = {};
        Object.keys(Config.SAMPLE_SCHEDULE).forEach(k => {
            pool[k] = Config.SAMPLE_SCHEDULE[k].map(e => ({
                name: e.title, sub: e.ep + ' · ' + e.time, hue: e.hue, poster: '', id: '', minutes: 0
            }));
        });
        return pool;
    },

    renderCalendar() {
        const root = document.getElementById('calendarRoot');
        if (!root) return;
        const now = new Date();
        if (this.calSelectedIdx === null) this.calSelectedIdx = (now.getDay() + 6) % 7;
        const monday = new Date(now);
        monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) + this.calWeekOffset * 7);
        monday.setHours(0, 0, 0, 0);
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        const rangeLabel = monday.toLocaleString('en-US', { month: 'short', day: 'numeric' }) + ' – ' +
            sunday.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        /* Same pattern as Home: a cached pool restores instantly
           (zero requests on refresh); a failed pool retries on
           every tab visit instead of staying sample forever. */
        if (!this.calPool) {
            try {
                const cachedCal = JSON.parse(sessionStorage.getItem('ganime_cal_pool') || 'null');
                if (cachedCal && typeof cachedCal === 'object' && Object.keys(cachedCal).length) this.calPool = cachedCal;
            } catch (e) { /* corrupt cache — fetch fresh below */ }
        }
        const pool = this.calPool || this.calSamplePool();
        const dayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

        const strip = dayNames.map((name, i) => {
            const date = new Date(monday);
            date.setDate(monday.getDate() + i);
            const weekday = date.getDay();
            const count = (pool[weekday] || []).length;
            const isToday = date.toDateString() === now.toDateString();
            return `
                <button class="cal2-day ${i === this.calSelectedIdx ? 'selected' : ''} ${isToday ? 'is-today' : ''}" onclick="App.calSelect(${i})">
                    <span class="cal2-day-name">${name}</span>
                    <span class="cal2-day-date">${date.getDate()}</span>
                    <span class="cal2-day-count">${count ? count + (count === 1 ? ' show' : ' shows') : '—'}</span>
                </button>`;
        }).join('');

        const selectedDate = new Date(monday);
        selectedDate.setDate(monday.getDate() + this.calSelectedIdx);
        const entries = (pool[selectedDate.getDay()] || []).slice().sort((a, b) => (a.minutes || 0) - (b.minutes || 0));
        const rows = entries.length ? entries.map(e => `
            <div class="cal2-row" ${e.id ? `onclick="App.openDetails('${e.id}')"` : ''}>
                <div class="cal2-thumb" ${e.id ? `onmouseenter="App.hoverIn(this,'${e.id}')" onmouseleave="App.hoverOut()"` : ''}
                    style="background:linear-gradient(150deg, hsl(${e.hue} 65% 42%), hsl(${e.hue + 40} 70% 26%))">${this._safeImgUrl(e.poster) ? `<img class="cal-poster-img" src="${this._safeImgUrl(e.poster)}" alt="" loading="lazy">` : `<span>${e.name.charAt(0)}</span>`}</div>
                <div class="cal2-info">
                    <div class="cal2-title">${this.esc(e.name)}</div>
                    <div class="cal2-sub">${this.esc(e.sub)}</div>
                </div>
                <span class="cal2-chevron">›</span>
            </div>`).join('')
            : '<div class="cal-none">No releases this day in the current data.</div>';

        root.innerHTML = `
            <div class="panel-title">Anime Release Calendar</div>
            <div class="cal2-nav">
                <button class="cal2-arrow" onclick="App.calNav(-1)">‹</button>
                <div class="cal2-range">${rangeLabel}${this.calWeekOffset === 0 ? ' · This week' : ''}</div>
                <button class="cal2-arrow" onclick="App.calNav(1)">›</button>
                ${this.calWeekOffset !== 0 ? '<button class="btn-mini" onclick="App.calToday()">Today</button>' : ''}
            </div>
            <div class="cal2-strip">${strip}</div>
            <div class="section-label" style="margin-top:18px">${selectedDate.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase()}${this.calPool ? ' · LIVE FROM ANILIST' : ' · SAMPLE'}</div>
            <div class="cal2-rows">${rows}</div>
            ${this.calPool
                ? ''
                : (this.calFailed
                    ? `<p class="text-secondary" style="margin-top:14px">Live data couldn't load — AniList may be rate-limiting. Showing the sample schedule for now.</p>
                       <button class="btn-primary" style="max-width:220px; margin-top:6px" onclick="App.retryCalendar()">↻ Retry Live Calendar</button>`
                    : `<p class="text-secondary" style="margin-top:14px">Sample schedule — live AniList data is loading…</p>`)}`;
        if (!this.calPool && !this.calLoading) {
            this.loadLiveCalendar();
        }
    },

    calNav(dir) {
        this.calWeekOffset += dir;
        this.renderCalendar();
    },

    calSelect(idx) {
        this.calSelectedIdx = idx;
        this.renderCalendar();
    },

    calToday() {
        this.calWeekOffset = 0;
        this.calSelectedIdx = (new Date().getDay() + 6) % 7;
        this.renderCalendar();
    },

    retryCalendar() {
        this.calFailed = false;
        this.renderCalendar();
    },

    async loadLiveCalendar() {
        if (this.calLoading) return;
        this.calLoading = true;
        try {
            const shows = await AniList.airing(50);
            this.cacheTitles(shows);
            const grouped = {};
            shows.forEach(t => {
                if (!t.nextRelease) return;
                const d = new Date(t.nextRelease);
                const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                const key = d.getDay();
                if (!grouped[key]) grouped[key] = [];
                grouped[key].push({
                    name: t.title,
                    sub: (t.nextEp ? 'EP ' + t.nextEp + ' · ' : 'Next EP · ') + time,
                    hue: t.hue, poster: t.poster, id: t.id,
                    minutes: d.getHours() * 60 + d.getMinutes()
                });
            });
            /* Success counts even if nothing had a next episode:
               an empty (truthy) pool stops renderCalendar from
               refetching on every nav click. Only non-empty pools
               are session-cached, so an empty one never blocks a
               fresh fetch next session. */
            this.calPool = grouped;
            this.calFailed = false;
            if (Object.keys(grouped).length) {
                try { sessionStorage.setItem('ganime_cal_pool', JSON.stringify(grouped)); } catch (e) {}
            }
            this.renderCalendar();
        } catch (e) {
            /* Old code swallowed this silently AND calLoaded was
               already true, so a rate-limited first attempt meant
               sample schedule forever. Now the footer offers Retry
               and the next tab visit retries automatically. */
            this.calFailed = true;
            this.renderCalendar();
        } finally {
            this.calLoading = false;
        }
    },

    /* QOL (2026-10-25): bottom-bar taps ALWAYS land on the
       default sub-view — Settings → Account, Library → Local /
       Watching — instead of reopening where he left off. Only
       the bottom bar uses navTo; refresh-restore and flows like
       openAddonSettings (which navigates then picks its own tab)
       still use navigate() directly and are untouched. */
    navTo(screenId) {
        if (screenId === 'screen-profile') {
            this.settingsPage = 'account';
            this.settingsParent = 'account';
            /* Mobile: Settings opens on the menu, not on Account. */
            this.mobileSettings = null;
            this.renderSettings();
        }
        if (screenId === 'screen-library') {
            this.librarySourceTab = 'Local';
            this.localLibFilter = 'ALL';
        }
        this.navigate(screenId);
    },

    navigate(screenId) {
        const prev = this.currentScreen;
        if (prev && prev !== 'screen-details' && prev !== 'screen-streams' && prev !== screenId) this._returnScreen = prev;
        this.currentScreen = screenId;
        this.hoverOut();
        if (screenId === 'screen-search' && !this.searchReady) this.renderSearch();
        // Continue Watching reflects the watched store EVERY time
        // Home is entered — it used to render only once at launch,
        // so episodes marked in Details never showed up here.
        if (screenId === 'screen-home') this.renderContinueWatching();
        if (screenId === 'screen-library') this.renderLibrary();
        if (screenId === 'screen-calendar') this.renderCalendar();
        // Home re-fetches live AniList data when revisited (45s throttle).
        if (screenId === 'screen-home' && this.shellLaunched && Date.now() - (this.lastHomeFetch || 0) > 45000) {
            this.loadLiveHome();
        }
        document.querySelectorAll('.spa-screen').forEach(s => {
            s.classList.toggle('active-screen', s.id === screenId);
        });
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.screen === screenId);
        });
        window.scrollTo(0, 0);
        this.persistRoute();
        this.syncHash();
    },

    renderProfileHeader() {
        /* Removed (Fix 8c): "no need, we have top bar" — profile
           identity, switching and sign-out live in the top bar
           and the Account pages now. The container stays empty. */
        const box = document.getElementById('profileHeader');
        if (box) box.innerHTML = '';
    },

    /* ---------- Home (Stage 4) ---------- */
    heroIndex: 0,
    heroTimer: null,
    currentTitleId: null,

    titleCache: {},
    heroList: null,      // live hero titles (AniList); null = sample fallback
    liveRails: null,     // live rails (AniList); null = not loaded yet
    homeLiveFailed: false, // true only after a fetch round produced nothing

    cacheTitles(list) {
        (list || []).forEach(t => { if (t && t.id) this.titleCache[t.id] = t; });
        try {
            const keys = Object.keys(this.titleCache).filter(k => !this.titleCache[k].isPlaceholder);
            const toSave = {};
            keys.slice(-80).forEach(k => { toSave[k] = this.titleCache[k]; });
            sessionStorage.setItem('ganime_title_cache', JSON.stringify(toSave));
        } catch (e) { /* storage full/blocked — cache still works in RAM */ }
    },

    loadTitleCache() {
        try {
            const raw = sessionStorage.getItem('ganime_title_cache');
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') Object.assign(this.titleCache, parsed);
            }
        } catch (e) {}
    },

    /* Cold-boot hydration: real title for an id the RAM cache
       doesn't know (refresh, new tab, shared link). byId already
       exists in anilist.js — no new endpoint needed. */
    async ensureTitle(id) {
        if (!id) return null;
        if (this.titleCache[id] && !this.titleCache[id].isPlaceholder) return this.titleCache[id];
        if (typeof AniList !== 'undefined' && typeof AniList.byId === 'function') {
            try {
                const media = await AniList.byId(id);
                if (media) { this.cacheTitles([media]); return media; }
            } catch (e) { /* placeholder already renders; retry on next open */ }
        }
        return this.titleById(id);
    },

    titleById(id) {
        if (!id) return null;
        if (this.titleCache[id]) return this.titleCache[id];
        const sample = Config.SAMPLE_TITLES.find(t => t.id === id);
        if (sample) return sample;
        /* NEVER fall back to SAMPLE_TITLES[0] — that substitution
           is exactly the refresh-shows-Frieren bug. An unknown id
           renders as "Loading…" until ensureTitle() fills it in. */
        const numId = parseInt(String(id).replace(/^a/, ''), 10) || null;
        return {
            id, anilistId: numId, title: 'Loading…', poster: '', cover: '',
            year: '', score: '', eps: 0, type: 'TV', synopsis: '', genres: [],
            hue: ((numId || 1) * 47) % 360, isPlaceholder: true
        };
    },

    heroTitles() {
        if (this.heroList && this.heroList.length) return this.heroList;
        return Config.HERO_IDS.map(id => this.titleById(id));
    },

    posterArt(t, cls, inner) {
        const bg = `background:linear-gradient(155deg, hsl(${t.hue} 65% 44%), hsl(${t.hue + 45} 72% 24%))`;
        const _poster = this._safeImgUrl(t.poster);
        if (_poster) {
            return `<div class="poster-art ${cls || ''}" style="${bg}">${inner || ''}<img class="poster-img" src="${_poster}" alt="" loading="lazy"></div>`;
        }
        return `<div class="poster-art ${cls || ''}" style="${bg}">${inner || ''}<span>${t.title.charAt(0)}</span></div>`;
    },

    posterCardHTML(t, badgeHTML) {
        return `
            <div class="poster-card" data-tid="${t.id}" onclick="App.openDetails('${t.id}')"
                onmouseenter="App.hoverIn(this,'${t.id}')" onmouseleave="App.hoverOut()">
                ${this.posterArt(t, '', badgeHTML)}
                <div class="poster-title">${this.esc(t.title)}</div>
                <div class="poster-meta">★ ${t.score} · ${t.year}</div>
            </div>`;
    },

    /* ---------- Hover info panel (desktop, works everywhere) ---------- */
    hoverIn(el, id) {
        if (!window.matchMedia || !window.matchMedia('(pointer: fine)').matches) return;
        const t = this.titleById(id);
        const panel = document.getElementById('hoverPanel');
        if (!t || !panel || !el) return;
        const seasonLine = t.season
            ? t.season.charAt(0) + t.season.slice(1).toLowerCase() + ' ' + t.year
            : String(t.year);
        let airingLine;
        if (t.nextEp && t.nextRelease) {
            const ms = new Date(t.nextRelease).getTime() - Date.now();
            const days = Math.floor(ms / 86400000);
            const hrs = Math.floor((ms % 86400000) / 3600000);
            airingLine = ms > 0
                ? `EP ${t.nextEp} airing in ${days > 0 ? days + 'd ' : ''}${hrs}h`
                : `EP ${t.nextEp} just aired`;
        } else {
            airingLine = t.scorePct ? '★ ' + t.scorePct + '%' : '★ ' + t.score;
        }
        const formatLabel = { TV: 'TV Show', MOVIE: 'Movie', TV_SHORT: 'TV Short', SPECIAL: 'Special', OVA: 'OVA', ONA: 'ONA', MUSIC: 'Music' }[t.format] || t.type;
        const countLine = t.type === 'Movie'
            ? formatLabel + (t.duration ? ' • ' + t.duration + ' min' : '')
            : formatLabel + (t.eps ? ' • ' + t.eps + ' episodes' : ' • Ongoing');
        panel.innerHTML = `
            <div class="hover-season">${seasonLine}</div>
            <div class="hover-score">${airingLine}</div>
            ${t.studio ? `<div class="hover-studio">${this.esc(t.studio)}</div>` : ''}
            <div class="hover-count">${countLine}</div>
            ${(t.genres && t.genres.length) ? `<div class="hover-genres">${t.genres.map(g => `<span class="hover-pill">${g.toLowerCase()}</span>`).join('')}</div>` : ''}`;
        const rect = el.getBoundingClientRect();
        const pw = 240, ph = 190;
        let left = rect.right + 12;
        if (left + pw > window.innerWidth - 8) left = rect.left - pw - 12;
        if (left < 8) left = 8;
        let top = rect.top;
        if (top + ph > window.innerHeight - 8) top = window.innerHeight - ph - 8;
        if (top < 8) top = 8;
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.classList.remove('hidden');
    },

    hoverOut() {
        const panel = document.getElementById('hoverPanel');
        if (panel) panel.classList.add('hidden');
    },

    renderHome() {
        this.renderHero();
        this.renderContinueWatching();
        this.renderRails();
        this.loadLiveHome();
    },

    /* Continue Watching is REAL now: it lists only titles the user
       has marked episodes on (the eye / tick), newest activity
       first — no watched titles, no section. Data comes from the
       watched store's meta snapshots, so cards render even before
       AniList rails land. */
    renderContinueWatching() {
        const cw = document.getElementById('homeContinueWatching');
        if (!cw) return;
        const map = Storage.getWatched();
        const entries = Object.keys(map)
            .map(id => ({ id, eps: map[id].eps || [], meta: map[id].meta || null, updatedAt: map[id].updatedAt || 0 }))
            .filter(e => e.eps.length)
            .sort((a, b) => b.updatedAt - a.updatedAt);
        /* Tracking merge: with AniList connected, its Watching and
           Rewatching progress joins in — the shown count is the
           further-along of local marks and tracker progress.
           The Tracking page's Data Source selector (Fix 8b) gates
           this: 'tracked' merges as below; 'cloud' shows only the
           app's own store (the future GAnime Cloud source). */
        if ((Storage.getSettings().continueWatchingSource || 'tracked') === 'tracked' && this.activeTrackerName() !== 'Local') {
            if ((!this.trackingLists || this.trackingListsProvider !== this.activeTrackerName() || Date.now() - this.trackingListsAt > 60000) && !this.trackingFetch) {
                this.fetchTrackingLists().then(() => { if (this.currentScreen === 'screen-home') this.renderContinueWatching(); });
            }
            if (this.trackingLists) {
                const byId = {};
                entries.forEach(e => { byId[e.id] = e; });
                ['CURRENT', 'REPEATING'].forEach(key => {
                    const g = this.trackingLists[key];
                    if (!g) return;
                    (g.entries || []).forEach(le => {
                        if (!le.progress || !le.media) return;
                        const id = le.media.id;
                        const meta = { title: le.media.title, poster: le.media.poster, cover: le.media.cover, total: le.media.eps || 0, anilistId: le.media.anilistId, year: le.media.year, hue: le.media.hue };
                        if (byId[id]) {
                            byId[id].trackerProgress = Math.max(byId[id].trackerProgress || 0, le.progress);
                            if (le.updatedAt) byId[id].updatedAt = Math.max(byId[id].updatedAt || 0, le.updatedAt * 1000);
                            if (!byId[id].meta) byId[id].meta = meta;
                        } else {
                            const ne = { id, eps: [], trackerProgress: le.progress, updatedAt: le.updatedAt ? le.updatedAt * 1000 : 1, meta };
                            entries.push(ne); byId[id] = ne;
                        }
                    });
                });
                entries.sort((a, b) => b.updatedAt - a.updatedAt);
            }
        }
        if (!entries.length) { cw.innerHTML = ''; return; }
        cw.innerHTML = `
            <div class="home-section">
                <div class="section-label">CONTINUE WATCHING</div>
                <div class="rail-row">
                    ${entries.map(e => {
                        const cached = this.titleCache[e.id];
                        const meta = e.meta || {};
                        if (!cached && meta.title) {
                            /* Seed a minimal title so Details/streams
                               can open this card in a fresh session. */
                            this.titleCache[e.id] = {
                                id: e.id, title: meta.title, poster: meta.poster || '', cover: meta.cover || '',
                                eps: meta.total || 0, anilistId: meta.anilistId || null, year: meta.year || '',
                                hue: meta.hue || 210, type: 'TV', score: '', synopsis: '', genres: [], studio: '', duration: 24
                            };
                        }
                        const t = this.titleCache[e.id] || {};
                        const name = meta.title || t.title || 'Unknown title';
                        const total = meta.total || t.eps || 0;
                        const watchedCount = Math.max(e.eps.length, e.trackerProgress || 0);
                        const done = total && watchedCount >= total;
                        const next = done ? total : watchedCount + 1;
                        const epData = (meta.anilistId || t.anilistId) ? Storage.getEpisodeData(meta.anilistId || t.anilistId) : null;
                        const nextEp = epData && epData.eps ? epData.eps.find(x => x.n === next) : null;
                        const sub = done
                            ? 'Completed ✓'
                            : 'EP ' + next + (nextEp && nextEp.title ? ' · ' + this._escEp(nextEp.title) : '') + (total ? ' · ' + watchedCount + '/' + total + ' watched' : '');
                        const pct = total ? Math.round(watchedCount / total * 100) : 0;
                        const art = this._safeImgUrl(meta.cover || t.cover)
                            ? `background-image:url('${this._safeImgUrl(meta.cover || t.cover)}'); background-size:cover; background-position:center 30%`
                            : `background:linear-gradient(150deg, hsl(${meta.hue || t.hue || 210} 60% 38%), hsl(${(meta.hue || t.hue || 210) + 45} 65% 20%))`;
                        return `
                        <div class="cw-card" onclick="App.openDetails('${e.id}')"
                            ${cached ? `onmouseenter="App.hoverIn(this,'${e.id}')" onmouseleave="App.hoverOut()"` : ''}>
                            <div class="cw-art" style="${art}"><span>▶</span></div>
                            <div class="cw-info">
                                <div class="cw-title">${this._escEp(name)}</div>
                                <div class="setting-desc">${sub}</div>
                                <div class="progress-track"><div class="progress-fill" style="width:${pct}%"></div></div>
                            </div>
                        </div>`;
                    }).join('')}
                </div>
            </div>`;
    },

    railStore: {},      // key -> { title, items } for See-All pages
    dataSource: '',     // 'ANILIST' | 'KITSU' once live data lands

    railHeadHTML(key, title) {
        return `
            <div class="rail-head">
                <div class="section-label">${title.toUpperCase()}</div>
                <button class="viewall-link" onclick="App.openSeeAll('${key}')">View All</button>
            </div>`;
    },

    renderRails() {
        const rails = document.getElementById('homeRails');
        if (!rails) return;
        this.railStore = {};
        if (!this.liveRails && !this.homeLiveFailed) {
            /* Loading: neutral shimmer sections — NEVER the sample
               letter tiles (his complaint 2026-10-22: fake posters
               "not even same" flashing on every load). Samples are
               only an offline fallback after a failed fetch. */
            const titles = ['Trending Now', 'Popular This Season', 'Upcoming Next Season', 'All Time Popular', 'Top 100 Anime', 'Top 100 Movies'];
            rails.innerHTML = titles.map(title => `
                <div class="home-section">
                    <div class="rail-head"><div class="section-label">${title.toUpperCase()}</div></div>
                    <div class="rail-row">${'<div class="poster-card"><div class="skl-poster"></div></div>'.repeat(7)}</div>
                </div>`).join('');
            return;
        }
        if (this.liveRails) {
            rails.innerHTML = this.liveRails.map((rail, i) => {
                const key = 'rail' + i;
                this.railStore[key] = rail;
                return `
                <div class="home-section">
                    ${this.railHeadHTML(key, rail.title)}
                    <div class="rail-row">${rail.items.map(t => this.posterCardHTML(t)).join('')}</div>
                </div>`;
            }).join('');
            return;
        }
        /* Failed + nothing cached: a Retry card, NEVER the fake
           sample tiles (his complaint: ugly colored blocks). */
        rails.innerHTML = `
                <div class="settings-group" style="margin-top:24px; padding:20px; text-align:center">
                    <div class="setting-label">Could not reach AniList right now</div>
                    <p class="text-secondary" style="margin:8px 0 14px">AniList may be rate-limiting or temporarily offline.</p>
                    <button class="btn-primary" style="max-width:220px; margin:0 auto" onclick="App.homeLiveFailed=false; App.renderHome()">↻ Retry Loading Home</button>
                </div>`;

    },

    /* ---------- See-All page (rail arrow → full grid) ---------- */
    openSeeAll(key) {
        const entry = this.railStore[key];
        if (!entry) return;
        const box = document.getElementById('seeAllRoot');
        if (box) {
            box.innerHTML = `
                <button class="back-btn" onclick="App.goBack()">←</button>
                <div class="panel-title" style="margin-top:14px">${entry.title}</div>
                <div class="section-label">${entry.items.length} TITLES</div>
                <div class="search-grid">${entry.items.map(t => this.posterCardHTML(t)).join('')}</div>`;
        }
        this.navigate('screen-seeall');
    },

    /* Fetch live data from AniList (sole source). Sample content
       stays on screen if AniList is unreachable. */
    lastHomeFetch: 0,

    async loadLiveHome() {
        /* Instant restore: cached rails render immediately and a
           refresh within 120s costs ZERO AniList requests — the
           old 6-parallel-requests burst is what tripped the rate
           limit and collapsed Home into sample colored tiles. */
        if (!this.liveRails) {
            try {
                const cachedHome = JSON.parse(sessionStorage.getItem('ganime_home_rails') || 'null');
                if (cachedHome && Array.isArray(cachedHome) && cachedHome.length) {
                    cachedHome.forEach(r => this.cacheTitles(r.items));
                    this.liveRails = cachedHome;
                    const trending = cachedHome.find(r => r.title === 'Trending Now') || cachedHome[0];
                    this.heroList = trending.items.slice(0, 4);
                    this.homeLiveFailed = false;
                    this.renderHero();
                    this.renderRails();
                    let savedTs = 0;
                    try { savedTs = Number(sessionStorage.getItem('ganime_home_ts') || 0); } catch (e) {}
                    if (savedTs) this.lastHomeFetch = savedTs;
                    if (Date.now() - (this.lastHomeFetch || 0) < 120000) return;
                }
            } catch (e) { /* corrupt cache — fetch fresh below */ }
        }
        this.lastHomeFetch = Date.now();
        try {
            const cur = AniList.currentSeason();
            const nxt = AniList.nextSeason();
            const rails = await AniList.homeBatch(cur.season, cur.year, nxt.season, nxt.year);
            if (!rails || !rails.length) {
                if (!this.liveRails) this.homeLiveFailed = true;
                this.renderHero();
                this.renderRails();
                return;
            }
            rails.forEach(r => this.cacheTitles(r.items));
            try { sessionStorage.setItem('ganime_home_rails', JSON.stringify(rails)); sessionStorage.setItem('ganime_home_ts', String(Date.now())); } catch (e) {}
            this.homeLiveFailed = false;
            this.dataSource = 'ANILIST';
            const trending = rails.find(r => r.title === 'Trending Now') || rails[0];
            this.heroList = trending.items.slice(0, 4);
            this.heroIndex = 0;
            this.liveRails = rails;
            this.renderHero();
            this.renderRails();
        } catch (e) {
            /* A cached Home keeps showing — only a cold boot with
               nothing cached may show the Retry card. */
            if (!this.liveRails) this.homeLiveFailed = true;
            this.renderHero();
            this.renderRails();
        }
    },


    renderHero() {
        const box = document.getElementById('homeHero');
        if (!box) return;
        if (!this.heroList || !this.heroList.length) {
            box.innerHTML = this.homeLiveFailed ? '' : '<div class="skl-hero"></div>';
            return;
        }
        const heroes = this.heroList;
        if (this.heroIndex >= heroes.length) this.heroIndex = 0;
        const t = heroes[this.heroIndex];
        const localEntry = Storage.getLocalEntry(t.id);
        const inList = !!(localEntry && localEntry.status);
        const dots = heroes.map((h, i) =>
            `<button class="hero-dot ${i === this.heroIndex ? 'active' : ''}" onclick="App.heroGo(${i})"></button>`).join('');
        /* Mobile hero (2026-10-27, v3): the wide banner crops badly
           in a tall phone frame, so mobile uses the portrait poster
           instead; desktop keeps the banner. Falls back to the
           banner when a title has no poster. */
        const isMobileHero = typeof window !== 'undefined' && !!window.matchMedia &&
            window.matchMedia('(max-width: 640px)').matches;
        const heroBg = (isMobileHero && t.poster) ? t.poster : t.cover;
        const coverStyle = heroBg
            ? `background-image:url('${this._safeImgUrl(heroBg)}'); background-size:cover; background-position:center 22%`
            : `background:linear-gradient(160deg, hsl(${t.hue} 62% 36%), hsl(${t.hue + 50} 70% 14%) 70%)`;
        /* Hero per Fix 3 ("our new design"): chips row (score ·
           format · status · year), big title, second-language
           title line, CLICKABLE genre pills (→ Search with that
           genre selected), justified synopsis. */
        const statusLabel = t.status ? String(t.status).replace(/_/g, ' ') : '';
        box.innerHTML = `
            <div class="hero" style="${coverStyle}" onmouseenter="App._heroPaused=true" onmouseleave="App._heroPaused=false">
                <div class="hero-shade"></div>
                <div class="hero-content">
                    <div class="hero-chips">
                        <span class="hchip">★ ${t.score}</span>
                        <span class="hchip">${t.type}</span>
                        ${statusLabel ? `<span class="hchip">${statusLabel}</span>` : ''}
                        <span class="hchip">${t.year}</span>
                    </div>
                    <div class="hero-title">${this.esc(t.title)}</div>
                    ${(t.titleRomaji && t.titleRomaji !== t.title) ? `<div class="hero-title-sub">${this._escEp(t.titleRomaji)}</div>` : ''}
                    ${(t.genres && t.genres.length) ? `<div class="hero-genres">${t.genres.map(g => `<button class="gpill" data-genre="${this.esc(g)}" onclick="App.searchGenre(this.dataset.genre)">${this.esc(g)}</button>`).join('')}</div>` : ''}
                    <div class="hero-synopsis justified">${this.esc(t.synopsis)}</div>
                    <div class="hero-actions">
                        <button class="btn-play" onclick="App.playTitle('${t.id}')">▶ Play</button>
                        <button class="btn-ghost btn-mylist" onclick="App.toggleMyList('${t.id}')">${inList ? '✓ ' + localEntry.status : '+ My List'}</button>
                        <button class="btn-ghost btn-details" onclick="App.openDetails('${t.id}')">Details</button>
                    </div>
                    <div class="hero-dots">${dots}</div>
                </div>
            </div>`;
        if (this.heroTimer) clearInterval(this.heroTimer);
        this.heroTimer = setInterval(() => {
            if (this.currentScreen !== 'screen-home') return;
            if (this._heroPaused) return;
            this.heroGo((this.heroIndex + 1) % this.heroList.length);
        }, 6000);
    },

    heroGo(i) {
        this.heroIndex = i;
        this.renderHero();
    },

    toggleMyList(id) {
        const t = this.titleById(id);
        const entry = Storage.getLocalEntry(id);
        const nextStatus = (entry && entry.status) ? null : 'Plan to Watch';
        Storage.setLocalStatus(id, nextStatus, t ? this.titleMeta(t) : null);
        if (this.currentScreen === 'screen-home') this.renderHero();
        if (this.currentScreen === 'screen-details') this.renderDetails();
        if (this.currentScreen === 'screen-library') this.renderLibrary();
    },

    /* ---------- Search: AniList filter bar + sections + fuzzy (Full Mirror) ---------- */
    searchTimer: null,
    searchReady: false,
    tagList: [],
    lastResults: [],
    GENRES: ['Action', 'Adventure', 'Comedy', 'Drama', 'Ecchi', 'Fantasy', 'Horror', 'Mahou Shoujo', 'Mecha', 'Music', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Supernatural', 'Thriller'],
    SEASONS: [['WINTER', 'Winter'], ['SPRING', 'Spring'], ['SUMMER', 'Summer'], ['FALL', 'Fall']],
    FORMATS: [['TV', 'TV Show'], ['MOVIE', 'Movie'], ['TV_SHORT', 'TV Short'], ['SPECIAL', 'Special'], ['OVA', 'OVA'], ['ONA', 'ONA'], ['MUSIC', 'Music']],
    STATUSES: [['RELEASING', 'Airing'], ['FINISHED', 'Finished'], ['NOT_YET_RELEASED', 'Not Yet Aired'], ['CANCELLED', 'Cancelled']],
    SORTS: [['POPULARITY_DESC', 'Popularity'], ['SCORE_DESC', 'Average Score'], ['TRENDING_DESC', 'Trending'], ['TITLE_ROMAJI', 'Title'], ['FAVOURITES_DESC', 'Favorites'], ['START_DATE_DESC', 'Release Date'], ['ID_DESC', 'Date Added']],
    COUNTRIES: [['JP', 'Japan'], ['KR', 'South Korea'], ['CN', 'China'], ['TW', 'Taiwan']],
    searchState: null,

    defaultSearchState() {
        return {
            q: '', genres: [], tags: [], year: '', season: '', format: '', status: '',
            sort: 'POPULARITY_DESC', view: 'grid', country: '',
            filtersOpen: false, panel: null
        };
    },

    renderSearch() {
        const bar = document.getElementById('searchBar');
        if (!bar) return;
        if (!this.searchState) this.searchState = this.defaultSearchState();
        const s = this.searchState;
        bar.innerHTML = this.renderSearchBarHTML(s.q);
        this.searchReady = true;
        AniList.tags().then(list => { this.tagList = list; if (this.searchState && this.searchState.panel === 'tags') this.refreshFilterBar(false); });
        if (this.isFiltering()) this.runBrowse();
        else this.renderSearchSections();
    },

    refreshFilterBar(rerun = true) {
        const keep = document.getElementById('ganimeSearchInput');
        const val = keep ? keep.value : (this.searchState ? this.searchState.q : '');
        const focus = document.activeElement && document.activeElement.id === 'ganimeSearchInput';
        this.renderSearchShellOnly(val);
        if (focus) {
            const input = document.getElementById('ganimeSearchInput');
            if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
        }
        if (rerun) this.applyFilters();
    },

    /* Rebuilds only the bar (renderSearch would loop through applyFilters). */
    renderSearchShellOnly(val) {
        const bar = document.getElementById('searchBar');
        if (!bar) return;
        const s = this.searchState;
        const had = s.panel;
        const wasReady = this.searchReady;
        this.searchReady = false;               // stop renderSearch's tail logic
        const oldPanel = s.panel;
        s.panel = oldPanel;
        const tmp = this.renderSearchBarHTML(val);
        bar.innerHTML = tmp;
        this.searchReady = wasReady;
        s.panel = had;
    },

    /* Search-bar rebuild (2026-10-27): AniList-style top row — a big
       search bar plus a filter button. Tapping the filter button
       opens the filter row below the bar (same fctrl controls as
       before, kept as-is). Country of Origin is the last kept
       filter; Source / Year Range / Episodes / Duration / Doujin
       were removed at the user's direction. */
    renderSearchBarHTML(val) {
        const s = this.searchState;
        const sum = (arr, label) => arr.length ? `${label}: ${arr[0]}${arr.length > 1 ? ' +' + (arr.length - 1) : ''}` : 'Any';
        const pick = (pairs, v) => { const hit = pairs.find(p => p[0] === v); return hit ? hit[1] : 'Any'; };
        const ctrl = (name, label, summary) => `
            <div class="fctrl">
                <div class="fctrl-label">${label}</div>
                <button class="fctrl-btn ${s.panel === name ? 'open' : ''}" onclick="App.togglePanel('${name}')">${summary} <span class="fctrl-chev">▾</span></button>
            </div>`;
        const slidersIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2.2" fill="var(--bg-card)"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2.2" fill="var(--bg-card)"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="11" cy="18" r="2.2" fill="var(--bg-card)"/></svg>`;
        return `
            <div class="search-toprow">
                <div class="search-wrap">
                    <span class="search-icon">🔍</span>
                    <input type="text" id="ganimeSearchInput" class="app-input search-input" placeholder="Search anime…"
                        value="${(val != null ? val : s.q).replace(/"/g, '&quot;')}" oninput="App.onSearchInput(this.value)">
                    <button class="search-clear ${s.q ? '' : 'hidden'}" id="searchClearBtn" onclick="App.clearSearch()">✕</button>
                </div>
                <button class="fctrl-btn fctrl-sliders ${s.filtersOpen ? 'open' : ''}" title="Filters" onclick="App.toggleFilters()">${slidersIcon}</button>
            </div>
            ${s.filtersOpen ? `<div class="filter-bar filter-row">
                ${ctrl('genres', 'Genres', sum(s.genres, 'Genres'))}
                ${ctrl('tags', 'Tags', sum(s.tags, 'Tags'))}
                ${ctrl('year', 'Year', s.year || 'Any')}
                ${ctrl('season', 'Season', pick(this.SEASONS, s.season))}
                ${ctrl('format', 'Format', pick(this.FORMATS, s.format))}
                ${ctrl('status', 'Airing Status', pick(this.STATUSES, s.status))}
                ${ctrl('country', 'Country of Origin', pick(this.COUNTRIES, s.country))}
            </div>` : ''}
            <div id="filterPanels">${s.panel ? this.filterPanelHTML(s.panel) : ''}</div>
            <div id="activeChips">${this.activeChipsHTML()}</div>`;
    },

    togglePanel(name) {
        this.searchState.panel = this.searchState.panel === name ? null : name;
        const panels = document.getElementById('filterPanels');
        const bar = document.getElementById('searchBar');
        if (bar) {
            const input = document.getElementById('ganimeSearchInput');
            const val = input ? input.value : this.searchState.q;
            bar.innerHTML = this.renderSearchBarHTML(val);
            const ni = document.getElementById('ganimeSearchInput');
            if (ni && document.activeElement !== ni && this._searchHadFocus) { ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); }
        }
        if (panels) panels.innerHTML = this.searchState.panel ? this.filterPanelHTML(this.searchState.panel) : '';
    },

    /* Search-bar rebuild: show/hide the whole filter row below the
       big search bar. Closing the row also closes any open
       dropdown panel, so no orphan panel renders without its row. */
    toggleFilters() {
        const s = this.searchState;
        s.filtersOpen = !s.filtersOpen;
        if (!s.filtersOpen) s.panel = null;
        const bar = document.getElementById('searchBar');
        if (bar) {
            const input = document.getElementById('ganimeSearchInput');
            const val = input ? input.value : s.q;
            bar.innerHTML = this.renderSearchBarHTML(val);
            const ni = document.getElementById('ganimeSearchInput');
            if (ni && document.activeElement !== ni && this._searchHadFocus) { ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); }
        }
    },

    filterPanelHTML(name) {
        const s = this.searchState;
        if (name === 'genres' || name === 'tags') {
            const list = name === 'genres' ? this.GENRES : (this.tagList.length ? this.tagList : []);
            const chosen = name === 'genres' ? s.genres : s.tags;
            const note = name === 'tags' && !this.tagList.length ? '<p class="text-secondary">Tag list loading from AniList…</p>' : '';
            const searchBox = name === 'tags' ? `<input type="text" class="app-input tag-filter-input" placeholder="Filter tags…" oninput="App.filterTagChips(this.value)">` : '';
            return `<div class="fpanel">${searchBox}${note}<div class="chip-grid" id="${name}ChipGrid">${list.map(g =>
                `<button class="fchip ${chosen.includes(g) ? 'on' : ''}" data-tag="${this.esc(g)}" onclick="App.toggleListFilter('${name}', this.dataset.tag)">${this.esc(g)}</button>`).join('')}</div></div>`;
        }
        if (name === 'year') {
            const years = ['Any'];
            for (let y = 2027; y >= 1940; y--) years.push(String(y));
            return `<div class="fpanel"><div class="fopt-list">${years.map(y =>
                `<button class="fopt ${(s.year || 'Any') === y ? 'on' : ''}" onclick="App.setSingleFilter('year','${y === 'Any' ? '' : y}')">${y}</button>`).join('')}</div></div>`;
        }
        if (name === 'season' || name === 'format' || name === 'status' || name === 'country') {
            const pairs = name === 'season' ? this.SEASONS : name === 'format' ? this.FORMATS : name === 'country' ? this.COUNTRIES : this.STATUSES;
            const key = name;
            return `<div class="fpanel"><div class="fopt-list">
                <button class="fopt ${!s[key] ? 'on' : ''}" onclick="App.setSingleFilter('${key}','')">Any</button>
                ${pairs.map(p => `<button class="fopt ${s[key] === p[0] ? 'on' : ''}" onclick="App.setSingleFilter('${key}','${p[0]}')">${p[1]}</button>`).join('')}
                </div></div>`;
        }
        return '';
    },

    filterTagChips(q) {
        const grid = document.getElementById('tagsChipGrid');
        if (!grid) return;
        const needle = q.trim().toLowerCase();
        grid.querySelectorAll('.fchip').forEach(chip => {
            chip.style.display = chip.dataset.tag.toLowerCase().includes(needle) ? '' : 'none';
        });
    },

    activeChipsHTML() {
        const s = this.searchState;
        if (!s) return '';
        const chips = [];
        const one = (label, clearFn) => chips.push(`<button class="active-chip" onclick="${clearFn}">${this.esc(label)} ✕</button>`);
        const oneTag = (label, kind, val) => chips.push(`<button class="active-chip" data-kind="${kind}" data-value="${this.esc(val)}" onclick="App.clearFilterChip(this)">${this.esc(label)} ✕</button>`);
        if (s.q) one('Search: ' + s.q, "App.clearSearch()");
        s.genres.forEach(g => oneTag(g, 'genres', g));
        s.tags.forEach(t => oneTag(t, 'tags', t));
        if (s.year) one('Year: ' + s.year, "App.setSingleFilter('year','')");
        if (s.season) one('Season: ' + s.season, "App.setSingleFilter('season','')");
        if (s.format) one('Format: ' + s.format, "App.setSingleFilter('format','')");
        if (s.status) one('Status: ' + s.status, "App.setSingleFilter('status','')");
        if (s.country) one('Country: ' + s.country, "App.setSingleFilter('country','')");
        if (!chips.length) return '';
        return `<div class="active-chips">${chips.join('')}<button class="clear-all" onclick="App.clearAllFilters()">Clear all</button></div>`;
    },

    isFiltering() {
        const s = this.searchState;
        if (!s) return false;
        return s.q.trim().length >= 2 || s.genres.length || s.tags.length || s.year || s.season ||
            s.format || s.status || s.country;
    },

    applyFilters() {
        const wrap = document.getElementById('activeChips');
        if (wrap) wrap.innerHTML = this.activeChipsHTML();
        clearTimeout(this.searchTimer);
        this.searchTimer = setTimeout(() => {
            if (this.isFiltering()) this.runBrowse();
            else this.renderSearchSections();
        }, 350);
    },

    /* Genre pill (hero / Details) → Search with that genre kept
       selected in the filters (Fix 3b). */
    searchGenre(genre) {
        this.navigate('screen-search');
        if (!this.searchReady) this.renderSearch();
        this.searchState.genres = [genre];
        const bar = document.getElementById('searchBar');
        if (bar) bar.innerHTML = this.renderSearchBarHTML(this.searchState.q || '');
        this.applyFilters();
    },

    clearFilterChip(el) {
        if (!el) return;
        this.toggleListFilter(el.dataset.kind, el.dataset.value);
    },

    toggleListFilter(kind, value) {
        const arr = kind === 'genres' ? this.searchState.genres : this.searchState.tags;
        const i = arr.indexOf(value);
        if (i >= 0) arr.splice(i, 1); else arr.push(value);
        // refresh chip states + bar summaries without losing panel/input
        const bar = document.getElementById('searchBar');
        const input = document.getElementById('ganimeSearchInput');
        const hadFocus = document.activeElement && document.activeElement.id === 'ganimeSearchInput';
        if (bar) bar.innerHTML = this.renderSearchBarHTML(input ? input.value : this.searchState.q);
        if (hadFocus) { const ni = document.getElementById('ganimeSearchInput'); if (ni) { ni.focus(); ni.setSelectionRange(ni.value.length, ni.value.length); } }
        this.applyFilters();
    },

    setSingleFilter(key, value) {
        this.searchState[key] = value;
        const bar = document.getElementById('searchBar');
        const input = document.getElementById('ganimeSearchInput');
        if (bar) bar.innerHTML = this.renderSearchBarHTML(input ? input.value : this.searchState.q);
        this.applyFilters();
    },

    clearAllFilters() {
        const q = '';
        this.searchState = Object.assign(this.defaultSearchState(), { sort: this.searchState.sort, view: this.searchState.view });
        const bar = document.getElementById('searchBar');
        if (bar) bar.innerHTML = this.renderSearchBarHTML(q);
        this.applyFilters();
    },

    onSearchInput(value) {
        this._searchHadFocus = true;
        this.searchState.q = value;
        const clearBtn = document.getElementById('searchClearBtn');
        if (clearBtn) clearBtn.classList.toggle('hidden', !value);
        this.applyFilters();
    },

    clearSearch() {
        this.searchState.q = '';
        const input = document.getElementById('ganimeSearchInput');
        if (input) input.value = '';
        const clearBtn = document.getElementById('searchClearBtn');
        if (clearBtn) clearBtn.classList.add('hidden');
        const wrap = document.getElementById('activeChips');
        if (wrap) wrap.innerHTML = this.activeChipsHTML();
        this.applyFilters();
    },

    /* Default view: Search is search + filters only now — the six
       discovery sections live on Home. Idle state makes no AniList
       calls at all (kinder to the rate limit, instant open). */
    async renderSearchSections() {
        const results = document.getElementById('searchResults');
        if (!results) return;
        if (this.isFiltering()) return;
        results.innerHTML = '';
        return true;
    },

    setSort(value) {
        this.searchState.sort = value;
        this.runBrowse();
    },

    setView(value) {
        this.searchState.view = value;
        this.renderResultsOnly();
    },

    resultRowHTML(t) {
        return `
            <div class="result-row" onclick="App.openDetails('${t.id}')"
                onmouseenter="App.hoverIn(this,'${t.id}')" onmouseleave="App.hoverOut()">
                <div class="result-thumb" style="background:linear-gradient(150deg, hsl(${t.hue} 65% 42%), hsl(${t.hue + 40} 70% 26%))">${this._safeImgUrl(t.poster) ? `<img class="cal-poster-img" src="${this._safeImgUrl(t.poster)}" alt="" loading="lazy">` : `<span>${t.title.charAt(0)}</span>`}</div>
                <div class="cal2-info">
                    <div class="cal2-title">${this.esc(t.title)}</div>
                    <div class="cal2-sub">★ ${t.score} · ${t.year} · ${t.type}${t.eps ? ' · ' + t.eps + ' eps' : ''}${(t.genres && t.genres.length) ? ' · ' + t.genres.slice(0, 3).map(g => this.esc(g)).join(', ') : ''}</div>
                </div>
                <span class="cal2-chevron">›</span>
            </div>`;
    },

    renderResultsOnly() {
        const results = document.getElementById('searchResults');
        if (!results) return;
        const items = this.lastResults || [];
        const body = this.searchState.view === 'list'
            ? `<div class="cal2-rows">${items.map(t => this.resultRowHTML(t)).join('')}</div>`
            : `<div class="search-grid">${items.map(t => this.posterCardHTML(t)).join('')}</div>`;
        results.innerHTML = this.resultsToolbarHTML(items.length) + body + (this.lastFuzzy && this.lastFuzzy.length ? `
            <div class="section-label" style="margin-top:20px">CLOSEST MATCHES (FUZZY)</div>
            <div class="search-grid">${this.lastFuzzy.map(t => this.posterCardHTML(t)).join('')}</div>` : '');
    },

    resultsToolbarHTML(count) {
        const s = this.searchState;
        return `
            <div class="results-toolbar">
                <div class="section-label" style="margin:0">${count} RESULT${count === 1 ? '' : 'S'}</div>
                <div class="results-tools">
                    <select class="app-input sort-select" onchange="App.setSort(this.value)">
                        ${this.SORTS.map(p => `<option value="${p[0]}" ${s.sort === p[0] ? 'selected' : ''}>${p[1]}</option>`).join('')}
                    </select>
                    <button class="view-toggle ${s.view === 'grid' ? 'on' : ''}" onclick="App.setView('grid')" title="Grid view">▦</button>
                    <button class="view-toggle ${s.view === 'list' ? 'on' : ''}" onclick="App.setView('list')" title="List view">☰</button>
                </div>
            </div>`;
    },

    /* Fuzzy helpers — misspelled queries still find their anime. */
    _lev(a, b) {
        if (Math.abs(a.length - b.length) > 3) return 99;
        const row = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
            let prev = row[0];
            row[0] = i;
            for (let j = 1; j <= b.length; j++) {
                const tmp = row[j];
                row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
                prev = tmp;
            }
        }
        return row[b.length];
    },

    _fuzzyScore(q, title) {
        const needle = q.toLowerCase();
        const hay = title.toLowerCase();
        if (hay.includes(needle)) return 100;
        let best = 0;
        hay.split(/[^a-z0-9]+/).forEach(word => {
            if (!word) return;
            if (word.startsWith(needle.slice(0, 3))) best = Math.max(best, 50);
            const d = this._lev(needle, word);
            if (d <= 2) best = Math.max(best, 70 - d * 10);
        });
        // subsequence check
        let i = 0;
        for (const ch of hay) { if (ch === needle[i]) i++; if (i === needle.length) break; }
        if (i === needle.length) best = Math.max(best, 40);
        return best;
    },

    fuzzyLocal(q, excludeIds, limit) {
        const scored = Object.values(this.titleCache)
            .filter(t => !excludeIds.includes(t.id))
            .map(t => ({ t, score: this._fuzzyScore(q, t.title) }))
            .filter(x => x.score >= 40)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit || 8)
            .map(x => x.t);
        return scored;
    },

    async runBrowse() {
        const results = document.getElementById('searchResults');
        if (!results || !this.searchState) return;
        const reqId = (this._browseReqId = (this._browseReqId || 0) + 1);
        const s = this.searchState;
        results.innerHTML = '<p class="text-secondary" style="margin-top:16px">Searching AniList…</p>';
        const filters = Object.assign({}, s, { tags: s.tags.slice() });
        try {
            let found = await AniList.browse(filters, 36);
            if (reqId !== this._browseReqId) return;
            this.cacheTitles(found);
            this.lastFuzzy = [];
            if (s.q && found.length < 5) {
                // Misspelling rescue: retry AniList with the longest word,
                // then fuzzy-match what GAnime already knows.
                const tokens = s.q.trim().split(/\s+/).filter(Boolean);
                const longest = tokens.sort((a, b) => b.length - a.length)[0];
                const sameAsQuery = longest && longest.toLowerCase() === s.q.trim().toLowerCase();
                if (longest && longest.length >= 3 && !(sameAsQuery && s.sort === 'SEARCH_MATCH')) {
                    try {
                        const retry = await AniList.browse(Object.assign({}, filters, { q: longest, sort: 'SEARCH_MATCH' }), 12);
                        if (reqId !== this._browseReqId) return;
                        this.cacheTitles(retry);
                        const seen = new Set(found.map(t => t.id));
                        retry.forEach(t => { if (!seen.has(t.id)) { this.lastFuzzy.push(t); seen.add(t.id); } });
                    } catch (e) { /* fuzzy is best-effort */ }
                }
                if (reqId !== this._browseReqId) return;
                const local = this.fuzzyLocal(s.q, found.map(t => t.id).concat(this.lastFuzzy.map(t => t.id)), 8);
                this.lastFuzzy = this.lastFuzzy.concat(local);
            }
            this.lastResults = found;
            this._browseFilters = filters;
            this._browsePage = 1;
            this._browseFull = found.length >= 36;
            if (!found.length && !this.lastFuzzy.length) {
                results.innerHTML = this.resultsToolbarHTML(0) + `<p class="text-secondary">No anime found — try loosening the filters or check the spelling.</p>`;
                return;
            }
            this.renderResultsOnly();
            this._appendLoadMore();
        } catch (e) {
            results.innerHTML = `<p class="text-secondary">Search failed (${e.message}) — AniList unreachable right now.</p>`;
        }
    },

    goBack() {
        this.navigate(this._returnScreen || 'screen-home');
    },

    _appendLoadMore() {
        if (!this._browseFull) return;
        const results = document.getElementById('searchResults');
        if (!results || document.getElementById('browseLoadMore')) return;
        results.innerHTML += `<div id="browseLoadMore" style="text-align:center; padding:18px 0 6px"><button class="btn-secondary" style="max-width:260px" onclick="App.loadMoreBrowse(this)">Load more results</button></div>`;
    },

    async loadMoreBrowse(btn) {
        if (!this._browseFilters || !this._browseFull) return;
        if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
        try {
            const more = await AniList.browse(this._browseFilters, 36, this._browsePage + 1);
            this._browsePage += 1;
            this._browseFull = more.length >= 36;
            this.cacheTitles(more);
            const seen = new Set(this.lastResults.map(t => t.id));
            this.lastResults = this.lastResults.concat(more.filter(t => !seen.has(t.id)));
            this.renderResultsOnly();
            this._appendLoadMore();
        } catch (e) {
            if (btn) { btn.disabled = false; btn.textContent = 'Load more results'; }
        }
    },

    /* ---------- Details (Stage 4 bridge) ---------- */
    openDetails(id) {
        this.currentTitleId = id;
        this.detailsUi = { range: null, design: Storage.getEpDesign(), filterOpen: false, epData: null, epLoadingFor: null };
        const t = this.titleById(id);
        if (t) this.loadEpisodeData(t);
        this.renderDetails();
        this.navigate('screen-details');
        /* Refresh/new-tab path: the title was a placeholder —
           fetch the real record and re-render in place. The
           screen/id guard stops a stale fetch repainting a
           screen the user has already left. */
        if (!t || t.isPlaceholder) {
            this.ensureTitle(id).then(full => {
                if (full && !full.isPlaceholder && this.currentScreen === 'screen-details' && this.currentTitleId === id) {
                    this.loadEpisodeData(full);
                    this.renderDetails();
                }
            });
        }
    },

    /* ---------- Details: episodes section (spec v3) ----------
       Watching Progress card + range bar ([Filter][All] pinned,
       ranges scroll) + Filter sheet expanding downward with two
       stacked designs: Minimal (picture only + EP/date inside)
       and Detailed (big cards). Episode data (titles, stills,
       air dates, runtimes, overviews) syncs live from
       AniList/ani.zip per title and caches in Storage. */
    detailsUi: { range: null, design: 'minimal', filterOpen: false, epData: null, epLoadingFor: null },

    esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    /* Privacy (2026-10-25 final): display-only masking for addon
       manifest URLs. Configured Torrentio/AIO URLs can embed a debrid
       key in the path, so a shared screenshot must not show it.
       Storage is untouched — only the Addons page display is masked. */
    maskAddonUrl(url) {
        return String(url || '').replace(/(https?:\/\/[^/]+\/)([^/]+)(\/manifest\.json)/i, '$1••••••••$3');
    },

    /* Progress sync (2026-10-25 final): Details used local watched
       only, while Continue Watching merged tracker progress, so a
       title could show EP 5 on Home and EP 1 on Details. This helper
       merges the same way, but respects the continueWatchingSource
       gate ('tracked' merges, 'cloud' does not) and the active
       tracker, instead of merging unconditionally. */
    getEffectiveWatchedEps(t) {
        if (!t) return [];
        const local = ((Storage.getWatched()[t.id] || {}).eps || []).slice();
        let trackerProg = 0;
        try {
            if ((Storage.getSettings().continueWatchingSource || 'tracked') === 'tracked' && this.trackingLists) {
                Object.values(this.trackingLists).forEach(g => (g.entries || []).forEach(e => {
                    if (e.media && (e.media.id === t.id || (t.anilistId && e.media.anilistId === t.anilistId))) {
                        trackerProg = Math.max(trackerProg, e.progress || 0);
                    }
                }));
            }
        } catch (e) {}
        const merged = new Set(local);
        for (let n = 1; n <= trackerProg; n++) merged.add(n);
        return Array.from(merged).sort((a, b) => a - b);
    },

    _escEp(s) {
        return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    },

    /* Inspection fix (2026-10-25): image URLs from AniList / ani.zip are
       interpolated into src="..." and url('...'). Only https:// URLs without
       quotes or whitespace are rendered; anything else falls back to the
       gradient, so a quote in a URL can never break out of the attribute. */
    _safeImgUrl(u) {
        const s = String(u || '');
        return (/^https?:\/\//i.test(s) && !/[\'"\s]/.test(s)) ? s : '';
    },

    formatEpDate(iso) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
        if (!m) return iso ? String(iso).slice(0, 10) : '';
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return parseInt(m[3], 10) + ' ' + months[parseInt(m[2], 10) - 1] + ' ' + m[1];
    },

    async loadEpisodeData(t) {
        if (!t || !t.anilistId) return;
        const cached = Storage.getEpisodeData(t.anilistId);
        if (cached && cached.eps && cached.eps.length && !t.isPlaceholder) {
            if (this.currentTitleId === t.id) {
                this.detailsUi.epData = cached.eps;
                if (this.currentScreen === 'screen-details') this.renderDetails();
            }
            return;
        }
        if (this.detailsUi.epLoadingFor === t.id) return;
        this.detailsUi.epLoadingFor = t.id;
        try {
            const r = await fetch('https://api.ani.zip/mappings?anilist_id=' + t.anilistId);
            const j = await r.json();
            const zm = (j && j.mappings) || {};
            if (zm.kitsu_id || zm.imdb_id) {
                const idCache = Storage.getIdMap();
                const prevEntry = idCache[t.anilistId] || {};
                const zep1 = j && j.episodes && j.episodes['1'];
                idCache[t.anilistId] = {
                    imdb: prevEntry.imdb || ((zm.imdb_id && /^tt\d+/.test(zm.imdb_id)) ? zm.imdb_id : null),
                    kitsu: prevEntry.kitsu || (zm.kitsu_id ? String(zm.kitsu_id) : null),
                    season: (prevEntry.season !== undefined && prevEntry.season !== null) ? prevEntry.season
                        : ((zep1 && typeof zep1.seasonNumber === 'number' && zep1.seasonNumber > 0) ? zep1.seasonNumber : null),
                    epOffset: prevEntry.epOffset || ((zep1 && typeof zep1.absoluteEpisodeNumber === 'number' && zep1.absoluteEpisodeNumber > 1) ? zep1.absoluteEpisodeNumber - 1 : 0)
                };
                Storage.saveIdMap(idCache);
            }
            const raw = (j && j.episodes) || {};
            let eps = Object.keys(raw).filter(k => /^\d+$/.test(k)).map(k => {
                const e = raw[k] || {};
                return {
                    n: (typeof e.episodeNumber === 'number') ? e.episodeNumber : parseInt(k, 10),
                    title: (e.title && (e.title.en || e.title.ja)) || '',
                    img: e.image || '',
                    date: e.airDate || '',
                    runtime: e.runtime || null,
                    overview: e.overview || ''
                };
            }).filter(e => e.n >= 1).sort((a, b) => a.n - b.n);
            /* Cold-boot heal: if AniList was rate-limited, this
               title may still be a "Loading…" placeholder — but
               ani.zip (a different host, still answering) just
               returned the real title, images and episode count. */
            const cur = this.titleCache[t.id] || t;
            if (cur.isPlaceholder || !cur.cover || cur.title === 'Loading…') {
                const zTitles = (j && j.titles) || {};
                const zImages = (j && Array.isArray(j.images)) ? j.images : [];
                const fanart = (zImages.find(im => im.coverType === 'Fanart' || im.coverType === 'Banner') || {}).url || (eps[0] && eps[0].img) || '';
                const poster = (zImages.find(im => im.coverType === 'Poster') || {}).url || '';
                this.cacheTitles([Object.assign({}, cur, {
                    id: t.id, anilistId: t.anilistId, malId: cur.malId || zm.mal_id || null,
                    title: (cur.title && cur.title !== 'Loading…') ? cur.title : (zTitles.en || zTitles['x-jat'] || zTitles.ja || 'Anime #' + t.anilistId),
                    poster: cur.poster || poster || fanart,
                    cover: cur.cover || fanart || poster,
                    eps: cur.eps || (j && j.episodeCount) || eps.length || 0,
                    isPlaceholder: false
                })]);
            }
            const finalT = this.titleById(t.id);
            if (finalT && finalT.eps) eps = eps.filter(e => e.n <= finalT.eps);
            if (eps.length) Storage.saveEpisodeData(t.anilistId, { eps });
            if (this.currentTitleId === t.id) {
                this.detailsUi.epData = eps;
                this.detailsUi.epLoadingFor = null;
                if (this.currentScreen === 'screen-details') this.renderDetails();
            }
        } catch (e) {
            this.detailsUi.epLoadingFor = null;
        }
    },

    episodeChunkSize(total) {
        if (total > 300) return 100;
        if (total > 96) return 24;
        return 12;
    },

    episodeRanges(total) {
        const chunk = this.episodeChunkSize(total);
        const out = [];
        for (let s = 1; s <= total; s += chunk) {
            const e = Math.min(s + chunk - 1, total);
            out.push({ from: s, to: e, count: e - s + 1, label: s + ' - ' + e });
        }
        return out;
    },

    epDataFor(n) {
        const data = this.detailsUi.epData || [];
        return data.find(e => e.n === n) || null;
    },

    setEpRange(from) { this.detailsUi.range = from; this.renderDetails(); },
    toggleEpFilter() { this.detailsUi.filterOpen = !this.detailsUi.filterOpen; this.renderDetails(); },
    setEpDesign(design) {
        this.detailsUi.design = design;
        this.detailsUi.filterOpen = false;
        Storage.saveEpDesign(design);
        this.renderDetails();
    },
    toggleWatchedEp(titleId, n) {
        const t = this.titleById(titleId);
        const meta = t ? {
            title: t.title, poster: t.poster || '', cover: t.cover || '',
            total: t.eps || 0, anilistId: t.anilistId || null,
            year: t.year || '', hue: t.hue || 210
        } : null;
        Storage.toggleWatched(titleId, n, meta);
        this.renderDetails();
        this.pushAnilistProgress(t);
    },

    wavePathD() {
        let d = 'M0 7 Q 18 1, 37 7';
        for (let x = 75; x <= 600; x += 37.5) d += ' T ' + x + ' 7';
        return d;
    },

    episodesSectionHtml(t) {
        const ui = this.detailsUi;
        const epData = ui.epData;
        const total = (t.eps && t.eps > 0) ? t.eps : (epData ? epData.length : 0);
        if (!total) {
            return `<div class="section-label">EPISODES</div>
                <p class="text-secondary">${ui.epLoadingFor ? 'Fetching episode details…' : 'Episode details will appear here once AniList data loads.'}</p>`;
        }
        if (ui.range === null) ui.range = total > 48 ? 1 : 'all';
        const ranges = this.episodeRanges(total);
        if (ui.range !== 'all' && !ranges.some(r => r.from === ui.range)) ui.range = 'all';
        const active = ui.range === 'all' ? { from: 1, to: total } : ranges.find(r => r.from === ui.range);
        const watchedEps = this.getEffectiveWatchedEps(t).filter(n => n <= total);
        const savedEps = ((Storage.getLocalEntry(t.id) || {}).savedEps || []);
        const saveSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
        const pct = total ? Math.round(watchedEps.length / total * 100) : 0;
        const wave = this.wavePathD();
        const nums = [];
        for (let n = active.from; n <= active.to; n++) nums.push(n);
        const fallbackArt = this._safeImgUrl(t.cover)
            ? `background-image:url('${this._safeImgUrl(t.cover)}'); background-size:cover; background-position:center 30%`
            : `background:linear-gradient(150deg, hsl(${t.hue} 55% 32%), hsl(${t.hue + 40} 60% 14%))`;
        const artFor = (ep) => (ep && this._safeImgUrl(ep.img))
            ? `background-image:url('${this._safeImgUrl(ep.img)}'); background-size:cover; background-position:center`
            : fallbackArt;

        /* Episode body per design — BOTH designs use the same
           View eye as the watched marker (his ask, 2026-10-22). */
        const eyeSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
        let body = '';
        if (ui.design === 'details') {
            body = `<div class="ep-big-strip">` + nums.map(n => {
                const ep = this.epDataFor(n);
                const watched = watchedEps.includes(n);
                return `<div class="ep-big" onclick="App.playTitle('${t.id}', ${n})">
                    <div class="ep-big-still" style="${artFor(ep)}">
                        <div class="ep-big-shade"></div>
                        <button class="ep-save ${savedEps.includes(n) ? 'on' : ''}" title="${savedEps.includes(n) ? 'Saved — tap to unsave' : 'Save this episode'}" onclick="event.stopPropagation(); App.toggleSavedEp('${t.id}', ${n})">${saveSvg}</button>
                        <button class="ep-eye ${watched ? 'on' : ''}" title="${watched ? 'Viewed — tap to unmark' : 'Mark as viewed'}" onclick="event.stopPropagation(); App.toggleWatchedEp('${t.id}', ${n})">${eyeSvg}</button>
                        <div class="ep-big-body">
                            <span class="ep-chip">S1E${n}</span>
                            <div class="ep-big-title">${ep && ep.title ? this._escEp(ep.title) : 'Episode ' + n}</div>
                            ${ep && ep.overview ? `<div class="ep-big-syn">${this._escEp(ep.overview)}</div>` : ''}
                            <div class="ep-big-foot"><span>${ep && ep.runtime ? ep.runtime + 'm' : (t.duration ? t.duration + 'm' : '')}</span><span>${ep ? this.formatEpDate(ep.date) : ''}</span></div>
                        </div>
                    </div>
                </div>`;
            }).join('') + `</div>`;
        } else {
            body = `<div class="ep-pic-grid">` + nums.map(n => {
                const ep = this.epDataFor(n);
                const watched = watchedEps.includes(n);
                return `<div class="ep-pic" style="${artFor(ep)}" onclick="App.playTitle('${t.id}', ${n})">
                    <button class="ep-save ${savedEps.includes(n) ? 'on' : ''}" title="${savedEps.includes(n) ? 'Saved — tap to unsave' : 'Save this episode'}" onclick="event.stopPropagation(); App.toggleSavedEp('${t.id}', ${n})">${saveSvg}</button>
                    <button class="ep-eye ${watched ? 'on' : ''}" title="${watched ? 'Viewed — tap to unmark' : 'Mark as viewed'}" onclick="event.stopPropagation(); App.toggleWatchedEp('${t.id}', ${n})">${eyeSvg}</button>
                    <span class="ep-badge">EP ${n}</span>
                    ${ep && ep.date ? `<span class="ep-date-badge">${this.formatEpDate(ep.date)}</span>` : ''}
                </div>`;
            }).join('') + `</div>`;
        }

        /* Filter menu (expands downward, compact original rows —
           the big stacked cards were reverted 2026-10-22: too big) */
        const previewEp = (epData && epData[0]) || null;
        const menuRow = (id, name, previewInner) => `
            <button class="ep-menu-row ${ui.design === id ? 'on' : ''}" onclick="App.setEpDesign('${id}')">
                <span class="ep-menu-prev" style="${artFor(previewEp)}">${previewInner}</span>
                <span class="ep-menu-name">${name}</span>
                ${ui.design === id ? '<span class="ep-menu-tick">✓</span>' : ''}
            </button>`;
        const sheet = ui.filterOpen ? `
            <div class="ep-menu">
                <div class="ep-menu-title">EPISODE DESIGN</div>
                ${menuRow('minimal', 'Minimal', '<span class="ep-menu-epb">EP 1</span>')}
                ${menuRow('details', 'Detailed', '<span class="ep-menu-ttl">Title…</span>')}
            </div>` : '';

        return `
            <div class="wp-card">
                <div class="wp-top"><span class="wp-lbl">Watching Progress</span><span class="wp-cnt">${watchedEps.length} / ${total}</span><button class="btn-mini" onclick="App.openTrackingEditor('${t.id}')">⚙ Tracking</button></div>
                <svg class="wp-wave" viewBox="0 0 600 14" preserveAspectRatio="none" aria-hidden="true">
                    <path d="${wave}" fill="none" stroke="var(--focus-bg)" stroke-width="5" stroke-linecap="round"/>
                    <path d="${wave}" pathLength="100" stroke-dasharray="${pct} 100" fill="none" stroke="var(--accent)" stroke-width="5" stroke-linecap="round"/>
                </svg>
            </div>
            <div class="section-label">EPISODES</div>
            <div class="ep-barwrap">
                <div class="ep-fixed">
                    <button class="ep-filter-btn ${ui.filterOpen ? 'open' : ''}" onclick="App.toggleEpFilter()">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2.2" fill="currentColor" stroke="none"/><circle cx="10" cy="17" r="2.2" fill="currentColor" stroke="none"/></svg>
                        Filter
                    </button>
                    <button class="ep-pill ${ui.range === 'all' ? 'on' : ''}" onclick="App.setEpRange('all')">All<span class="ep-pill-n">${total}</span></button>
                </div>
                <div class="ep-scroll">
                    ${ranges.map(r => `<button class="ep-pill ${ui.range === r.from ? 'on' : ''}" onclick="App.setEpRange(${r.from})">${r.label}<span class="ep-pill-n">${r.count}</span></button>`).join('')}
                </div>
            </div>
            ${sheet}
            ${body}
            ${ui.epLoadingFor ? '<p class="text-secondary" style="margin-top:14px">Fetching episode details…</p>' : ''}`;
    },

    /* Meta snapshot stored alongside Local/watched entries so
       Library + Continue Watching can render before the title
       is cached this session. */
    titleMeta(t) {
        return t ? {
            title: t.title, poster: t.poster || '', cover: t.cover || '',
            total: t.eps || 0, anilistId: t.anilistId || null,
            year: t.year || '', hue: t.hue || 210, type: t.type || 'TV'
        } : null;
    },

    renderDetails() {
        const box = document.getElementById('screen-details');
        if (!box || !this.currentTitleId) return;
        const t = this.titleById(this.currentTitleId);
        const detailsCover = this._safeImgUrl(t.cover)
            ? `background-image:url('${this._safeImgUrl(t.cover)}'); background-size:cover; background-position:center 22%`
            : `background:linear-gradient(160deg, hsl(${t.hue} 62% 36%), hsl(${t.hue + 50} 70% 13%) 75%)`;
        const statusLabel = t.status ? String(t.status).replace(/_/g, ' ') : '';
        const watchedEps = this.getEffectiveWatchedEps(t);
        const total = t.type === 'Movie' ? 1 : (t.eps || 0);
        let nextEp = 1;
        while (nextEp <= total && watchedEps.includes(nextEp)) nextEp++;
        if (nextEp > total) nextEp = 1;
        // Mark-watched toggle label uses LOCAL watched (same source as
        // the toggle) so the button and the action never disagree.
        const localWatchedEps = ((Storage.getWatched()[t.id] || {}).eps || []);
        const markTotal = t.type === 'Movie' ? 1 : (t.eps || (this.detailsUi.epData ? this.detailsUi.epData.length : 0));
        const allWatchedLocal = markTotal > 0 && Array.from({ length: markTotal }, (_, i) => i + 1).every(n => localWatchedEps.includes(n));
        const libEntry = Storage.getLocalEntry(t.id);
        const libStatuses = ['Watching', 'Completed', 'Plan to Watch', 'On Hold', 'Dropped', 'Rewatching'];
        const lower = t.type === 'Movie' ? this.movieSectionHtml(t) : this.episodesSectionHtml(t);
        box.innerHTML = `
            <div class="details-hero" style="${detailsCover}">
                <button class="back-btn" onclick="App.goBack()">←</button>
                <div class="hero-content">
                    <div class="hero-chips">
                        <span class="hchip">★ ${t.score}</span>
                        <span class="hchip">${t.type}</span>
                        ${statusLabel ? `<span class="hchip">${statusLabel}</span>` : ''}
                        <span class="hchip">${t.year}</span>
                        ${t.studio ? `<span class="hchip">${this._escEp(t.studio)}</span>` : ''}
                    </div>
                    <div class="hero-title">${this.esc(t.title)}</div>
                    ${(t.titleRomaji && t.titleRomaji !== t.title) ? `<div class="hero-title-sub">${this._escEp(t.titleRomaji)}</div>` : ''}
                    ${(t.genres && t.genres.length) ? `<div class="hero-genres">${t.genres.map(g => `<button class="gpill" data-genre="${this.esc(g)}" onclick="App.searchGenre(this.dataset.genre)">${this.esc(g)}</button>`).join('')}</div>` : ''}
                    <div class="hero-synopsis justified">${this.esc(t.synopsis)}</div>
                    <div class="hero-actions">
                        <button class="btn-play" onclick="App.playTitle('${t.id}', ${nextEp})">${t.type === 'Movie' ? '▶ Play Movie' : '▶ Play Ep ' + nextEp}</button>
                        <div class="lib-wrap">
                            <button class="btn-ghost" onclick="App.toggleLibMenu(event)">${libEntry && libEntry.status ? '✓ ' + libEntry.status : 'Add to Library'} ▾</button>
                            <div class="lib-menu hidden" id="libMenu">
                                ${libStatuses.map(s => `<button class="lib-menu-row ${libEntry && libEntry.status === s ? 'active' : ''}" onclick="App.setLibraryStatus('${s}')">${s}</button>`).join('')}
                                ${libEntry && libEntry.status ? '<button class="lib-menu-row danger" onclick="App.setLibraryStatus(null)">Remove from Library</button>' : ''}
                            </div>
                        </div>
                        <button class="btn-ghost" onclick="App.markAllWatched()">${t.type === 'Movie' ? (localWatchedEps.includes(1) ? '✓ Watched' : 'Mark Watched') : (allWatchedLocal ? '✓ All Watched' : 'Mark All Watched')}</button>
                        ${t.trailerId ? `<button class="btn-ghost" onclick="App.openTrailer()">🎬 Trailer</button>` : ''}
                    </div>
                </div>
            </div>
            <div class="screen-pad">
                ${lower}
            </div>`;
        // Mobile inside layout v2 (2026-10-27): clean banner on top,
        // everything below it on dark. Desktop keeps everything
        // inside the hero, untouched.
        if (window.matchMedia('(max-width: 640px)').matches) {
            const hero = box.querySelector('.details-hero');
            const content = hero && hero.querySelector('.hero-content');
            const chips = content && content.querySelector('.hero-chips');
            const dTitle = content && content.querySelector('.hero-title');
            const sub = content && content.querySelector('.hero-title-sub');
            const genres = content && content.querySelector('.hero-genres');
            const syn = content && content.querySelector('.hero-synopsis');
            const acts = content && content.querySelector('.hero-actions');
            const play = acts && acts.querySelector('.btn-play');
            const mark = acts && acts.querySelector('button[onclick="App.markAllWatched()"]');
            const trailer = acts && acts.querySelector('button[onclick="App.openTrailer()"]');
            const libWrap = acts && acts.querySelector('.lib-wrap');
            if (hero && content && chips && dTitle && syn && acts) {
                const below = document.createElement('div');
                below.className = 'details-below';
                const divider = document.createElement('div');
                divider.className = 'details-divider';
                const aboutH = document.createElement('div');
                aboutH.className = 'details-about-h';
                aboutH.textContent = 'About this anime';
                below.append(chips, dTitle);
                if (sub) below.append(sub);
                if (genres) below.append(genres);
                below.append(divider, aboutH, syn);
                if (t.type !== 'Movie') {
                    const nextLine = document.createElement('div');
                    nextLine.className = 'details-next-ep';
                    nextLine.textContent = '◷ Episode ' + nextEp + ' · ' + (watchedEps.length ? 'Continue watching' : 'Start watching');
                    below.append(nextLine);
                }
                if (play) below.append(play);
                const row = document.createElement('div');
                row.className = 'details-btn-row';
                if (libWrap) {
                    // Icon-only library button: the picked status's logo,
                    // or a bookmark when the title is not in the library.
                    // Tapping it still opens the status menu, as before.
                    const libBtn = libWrap.querySelector('button');
                    const libStatus = libEntry && libEntry.status;
                    const bookmarkSVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4-7 4V4a1 1 0 0 1 1-1z"/></svg>';
                    if (libBtn) libBtn.innerHTML = libStatus ? this.statusIconSVG(libStatus) : bookmarkSVG;
                    row.append(libWrap);
                }
                if (mark) {
                    // Icon-only tick: green while all watched, grey else.
                    mark.textContent = '✓';
                    mark.classList.toggle('is-watched', allWatchedLocal);
                    mark.title = allWatchedLocal ? 'All watched — tap to unwatch' : 'Mark watched';
                    row.append(mark);
                }
                if (trailer) { trailer.textContent = '🎬'; row.append(trailer); }
                below.append(row);
                hero.after(below);
                // Only the back button stays in the hero: clean banner.
                content.remove();
                // Full banner, never cut: swap the cropped background for
                // a real image fitted to mobile width. Gradient fallback
                // (no cover URL) keeps the old strip.
                const bg = hero.style.backgroundImage || '';
                const m = bg.match(/url\(['"]?(.*?)['"]?\)/);
                if (m && m[1]) {
                    const bannerImg = document.createElement('img');
                    bannerImg.className = 'details-banner-img';
                    bannerImg.src = m[1];
                    bannerImg.alt = '';
                    hero.style.backgroundImage = 'none';
                    hero.classList.add('has-banner-img');
                    hero.appendChild(bannerImg);
                }
            }
        }
    },

    toggleLibMenu(ev) {
        if (ev) ev.stopPropagation();
        const menu = document.getElementById('libMenu');
        if (!menu) return;
        const opening = menu.classList.contains('hidden');
        if (opening) {
            menu.classList.remove('hidden');
            const off = e => {
                if (!menu.contains(e.target)) { menu.classList.add('hidden'); document.removeEventListener('click', off); }
            };
            setTimeout(() => document.addEventListener('click', off), 0);
        } else {
            menu.classList.add('hidden');
        }
    },

    /* Add to Library writes to the LOCAL library (Fix 4c). */
    setLibraryStatus(status) {
        const t = this.titleById(this.currentTitleId);
        if (!t) return;
        Storage.setLocalStatus(t.id, status, this.titleMeta(t));
        const menu = document.getElementById('libMenu');
        if (menu) menu.classList.add('hidden');
        this.renderDetails();
        if (this.currentScreen === 'screen-library') this.renderLibrary();
    },

    markAllWatched() {
        const t = this.titleById(this.currentTitleId);
        if (!t) return;
        const total = t.type === 'Movie' ? 1 : (t.eps || (this.detailsUi.epData ? this.detailsUi.epData.length : 0));
        if (!total) return;
        const watched = ((Storage.getWatched()[t.id] || {}).eps || []);
        const all = [];
        for (let n = 1; n <= total; n++) all.push(n);
        // Toggle: everything watched -> unwatch it all, else mark all.
        const allWatched = all.every(n => watched.includes(n));
        const next = allWatched ? [] : all;
        const changed = next.length !== watched.length || next.some(n => !watched.includes(n));
        if (changed) Storage.setWatchedEps(t.id, next, this.titleMeta(t));
        // Revert does not sync: unwatching stays local only, tracker
        // progress is left alone. Marking still pushes, as before.
        if (changed && next.length) this.pushAnilistProgress(t);
        this.renderDetails();
    },

    /* Save Episode (bookmark on episode cards) → Local library. */
    toggleSavedEp(titleId, n) {
        const t = this.titleById(titleId);
        Storage.toggleSavedEp(titleId, n, t ? this.titleMeta(t) : null);
        this.renderDetails();
    },

    isEpSaved(titleId, n) {
        const entry = Storage.getLocalEntry(titleId);
        return !!((entry && entry.savedEps) || []).includes(n);
    },

    /* Trailer: in-app YouTube embed modal (Fix 4d — ported from
       the reference build's approach: AniList trailer id →
       youtube-nocookie embed, backdrop/X dismiss). */
    openTrailer() {
        const t = this.titleById(this.currentTitleId);
        if (!t || !t.trailerId) return;
        /* Error 153 hardening: YouTube rejects embeds with a
           missing referrer policy (and file:// origins outright).
           The nocookie embed + an explicit referrerpolicy covers
           http(s); the Watch button is the escape hatch when the
           embed itself is refused, so you're never stuck. */
        const ytWatch = 'https://www.youtube.com/watch?v=' + encodeURIComponent(t.trailerId);
        const isFile = window.location.protocol === 'file:';
        this.openModal(`
            <h3 class="modal-title">${this._escEp(t.title)} — Trailer</h3>
            <div class="trailer-frame">
                <iframe src="https://www.youtube-nocookie.com/embed/${t.trailerId}?autoplay=1&rel=0" title="Trailer"
                    referrerpolicy="strict-origin-when-cross-origin"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
            </div>
            ${isFile ? '<p class="text-secondary" style="font-size:12px">Running from a local file — if YouTube blocks the embed (Error 153), use the button below.</p>' : ''}
            <div style="display:flex; gap:10px">
                <button class="btn-primary" onclick="window.open('${ytWatch}', '_blank', 'noopener')">↗ Watch on YouTube</button>
                <button class="btn-secondary" onclick="App.closeModal()">Close</button>
            </div>
        `);
    },

    /* Movies / single-episode titles get the FULL Details
       treatment (Fix 9): progress card + one real episode card
       ("Complete Movie") — never a blank page. */
    movieSectionHtml(t) {
        const watchedEps = ((Storage.getWatched()[t.id] || {}).eps || []);
        const watched = watchedEps.includes(1);
        const pct = watched ? 100 : 0;
        const wave = this.wavePathD();
        const ep = this.epDataFor(1);
        const saved = this.isEpSaved(t.id, 1);
        const eyeSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
        const saveSvg = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
        const fallbackArt = this._safeImgUrl(t.cover)
            ? `background-image:url('${this._safeImgUrl(t.cover)}'); background-size:cover; background-position:center 30%`
            : `background:linear-gradient(150deg, hsl(${t.hue} 55% 32%), hsl(${t.hue + 40} 60% 14%))`;
        const art = (ep && this._safeImgUrl(ep.img)) ? `background-image:url('${this._safeImgUrl(ep.img)}'); background-size:cover; background-position:center` : fallbackArt;
        return `
            <div class="wp-card">
                <div class="wp-top"><span class="wp-lbl">Watching Progress</span><span class="wp-cnt">${watched ? 1 : 0} / 1</span><button class="btn-mini" onclick="App.openTrackingEditor('${t.id}')">⚙ Tracking</button></div>
                <svg class="wp-wave" viewBox="0 0 600 14" preserveAspectRatio="none" aria-hidden="true">
                    <path d="${wave}" fill="none" stroke="var(--focus-bg)" stroke-width="5" stroke-linecap="round"/>
                    <path d="${wave}" pathLength="100" stroke-dasharray="${pct} 100" fill="none" stroke="var(--accent)" stroke-width="5" stroke-linecap="round"/>
                </svg>
            </div>
            <div class="section-label">EPISODE</div>
            <div class="ep-big-strip">
                <div class="ep-big" onclick="App.playTitle('${t.id}', 1)">
                    <div class="ep-big-still" style="${art}">
                        <div class="ep-big-shade"></div>
                        <button class="ep-save ${saved ? 'on' : ''}" title="${saved ? 'Saved — tap to unsave' : 'Save this episode'}" onclick="event.stopPropagation(); App.toggleSavedEp('${t.id}', 1)">${saveSvg}</button>
                        <button class="ep-eye ${watched ? 'on' : ''}" title="${watched ? 'Viewed — tap to unmark' : 'Mark as viewed'}" onclick="event.stopPropagation(); App.toggleWatchedEp('${t.id}', 1)">${eyeSvg}</button>
                        <div class="ep-big-body">
                            <span class="ep-chip">S1 · E1</span>
                            <div class="ep-big-title">${ep && ep.title ? this._escEp(ep.title) : 'Complete Movie'}</div>
                            <div class="ep-big-syn">${ep && ep.overview ? this._escEp(ep.overview) : 'No episode overview available.'}</div>
                            <div class="ep-big-foot"><span>${ep && ep.runtime ? ep.runtime + 'm' : (t.duration ? t.duration + 'm' : '')}</span><span>${ep ? this.formatEpDate(ep.date) : (t.year || '')}</span></div>
                        </div>
                    </div>
                </div>
            </div>`;
    },

    /* ---------- Tracking editor (Fix 5) ----------
       Design adopted from the reference Tracker Tool popup (his
       ruling: take the design as-is, edits on request), skinned
       to GAnime and wired to REAL pushes only: AniList saves
       progress/status/score/dates/notes via its API; Simkl
       saves watched history; MAL is honestly read-only here.
       Save stays disabled until something is actually dirty,
       and every service reports its own result. */
    _teDraft: null,

    openTrackingEditor(titleId) {
        const t = this.titleById(titleId || this.currentTitleId);
        if (!t) return;
        const total = t.type === 'Movie' ? 1 : (t.eps || 0);
        const localCount = ((Storage.getWatched()[t.id] || {}).eps || []).length;
        let alEntry = null;
        if (this.trackingLists) {
            Object.values(this.trackingLists).forEach(g => (g.entries || []).forEach(e => {
                if (e.media && e.media.id === t.id) alEntry = e;
            }));
        }
        const statusMap = { CURRENT: 'Watching', COMPLETED: 'Completed', PLANNING: 'Plan to Watch', PAUSED: 'On Hold', DROPPED: 'Dropped', REPEATING: 'Rewatching' };
        this._teDraft = {
            titleId: t.id, total,
            anilist: {
                status: alEntry ? (statusMap[alEntry.status] || 'Watching') : 'Watching',
                progress: alEntry ? (alEntry.progress || 0) : localCount,
                score: alEntry && alEntry.score ? alEntry.score : 0,
                start: '', finish: '', notes: '', dirty: false
            },
            simkl: { status: 'Watching', progress: localCount, score: 0, memo: '', priv: false, dirty: false },
            results: {}
        };
        this.renderTrackingEditor();
    },

    _teDirtyCount() {
        const d = this._teDraft;
        if (!d) return 0;
        return (d.anilist.dirty ? 1 : 0) + (d.simkl.dirty ? 1 : 0);
    },

    _teSyncFooter() {
        const n = this._teDirtyCount();
        const label = document.getElementById('teDirtyLabel');
        if (label) label.textContent = n ? n + ' service(s) modified' : 'No changes pending';
        const btn = document.getElementById('teSaveBtn');
        if (btn) btn.disabled = !n;
    },

    _teSet(service, field, value) {
        const d = this._teDraft;
        if (!d) return;
        d[service][field] = value;
        d[service].dirty = true;
        this._teSyncFooter();
    },

    renderTrackingEditor() {
        const d = this._teDraft;
        if (!d) return;
        const t = this.titleById(d.titleId);
        if (!t) return;
        const alConn = Storage.getAnilistConn();
        const skConn = Storage.getSimklConn();
        const malConn = Storage.getMalConn();
        const alOk = !!(alConn && alConn.accessToken);
        const skOk = !!(skConn && skConn.accessToken);
        const statuses = ['Watching', 'Completed', 'Plan to Watch', 'On Hold', 'Dropped', 'Rewatching'];
        const statusOpts = sel => statuses.map(s => `<option value="${s}" ${sel === s ? 'selected' : ''}>${s}</option>`).join('');
        const resLine = key => d.results[key] ? `<div class="te-result ${d.results[key].ok ? 'ok' : 'err'}">${this._escEp(d.results[key].msg)}</div>` : '';
        const epRow = (svc, val) => `
            <div class="te-row">
                <span class="te-label">Watched Episodes</span>
                <span class="te-stepper">
                    <button class="btn-mini" onclick="App._teSet('${svc}','progress', Math.max(0, App._teDraft.${svc}.progress - 1)); App.renderTrackingEditor()">−</button>
                    <b id="te-${svc}-count">${val} / ${d.total || '?'}</b>
                    <button class="btn-mini" onclick="App._teSet('${svc}','progress', Math.min(App._teDraft.total || 9999, App._teDraft.${svc}.progress + 1)); App.renderTrackingEditor()">+</button>
                </span>
            </div>
            <input type="range" class="setting-range te-range" min="0" max="${d.total || 100}" value="${val}"
                oninput="App._teSet('${svc}','progress', parseInt(this.value, 10)); document.getElementById('te-${svc}-count').textContent = this.value + ' / ${d.total || '?'}'">`;
        this.openModal(`
            <div class="te-head">
                ${this._safeImgUrl(t.poster) ? `<img class="te-poster" src="${this._safeImgUrl(t.poster)}" alt="">` : ''}
                <div class="te-head-text">
                    <div class="te-chiprow"><span class="te-tool-chip">Tracker Tool</span><span class="te-score">★ ${t.score}</span></div>
                    <h3 class="modal-title" style="margin:4px 0 0">${this._escEp(t.title)}</h3>
                </div>
            </div>
            <div class="te-card">
                <div class="te-card-head">
                    <span class="te-brand al">AL</span>
                    <span class="te-name">AniList</span>
                    <span class="te-conn">${alOk ? '@' + this.esc(alConn.user ? alConn.user.name : '') : 'Not Connected'}</span>
                    ${t.anilistId ? `<button class="btn-mini" onclick="window.open('https://anilist.co/anime/${t.anilistId}', '_blank')">Open ↗</button>` : ''}
                    ${alOk ? '' : '<button class="btn-mini" onclick="App.closeModal(); App.connectAnilistOneClick()">Connect</button>'}
                </div>
                ${alOk ? `
                <div class="te-grid">
                    <div>
                        <div class="te-label">Status</div>
                        <select class="setting-select" onchange="App._teSet('anilist','status', this.value)">${statusOpts(d.anilist.status)}</select>
                    </div>
                    <div>
                        <div class="te-label">Score (AniList scale 0–10.0) · <b id="te-al-score">${(d.anilist.score ?? '—')}</b></div>
                        <input type="range" class="setting-range te-range" min="0" max="10" step="0.1" value="${d.anilist.score}"
                            oninput="App._teSet('anilist','score', parseFloat(this.value)); document.getElementById('te-al-score').textContent = this.value">
                    </div>
                </div>
                ${epRow('anilist', d.anilist.progress)}
                <details class="te-adv">
                    <summary>Advanced Options</summary>
                    <div class="te-grid">
                        <div><div class="te-label">Start Date</div><input type="date" class="app-input" value="${d.anilist.start}" onchange="App._teSet('anilist','start', this.value)"></div>
                        <div><div class="te-label">Finish Date</div><input type="date" class="app-input" value="${d.anilist.finish}" onchange="App._teSet('anilist','finish', this.value)"></div>
                    </div>
                    <div class="te-label" style="margin-top:10px">Personal Notes</div>
                    <input type="text" class="app-input" placeholder="Add personal notes or impressions…" value="${this._escEp(d.anilist.notes)}" onchange="App._teSet('anilist','notes', this.value)">
                </details>` : ''}
                ${resLine('anilist')}
            </div>
            <div class="te-card">
                <div class="te-card-head">
                    <span class="te-brand mal">MAL</span>
                    <span class="te-name">MyAnimeList</span>
                    <span class="te-readonly">Read-only</span>
                    <span class="te-conn">${malConn && malConn.user ? '@' + this.esc(malConn.user.name) : 'Not Connected'}</span>
                    ${t.malId ? `<button class="btn-mini" onclick="window.open('https://myanimelist.net/anime/${t.malId}', '_blank')">Open ↗</button>` : ''}
                </div>
                <div class="te-note">MAL sync is read-only in this app (OAuth write token required). Track and sync your progress via AniList or Simkl.</div>
            </div>
            <div class="te-card">
                <div class="te-card-head">
                    <span class="te-brand sk">SK</span>
                    <span class="te-name">Simkl</span>
                    <span class="te-conn">${skOk ? 'Connected' : 'Not Connected'}</span>
                    <button class="btn-mini" onclick="window.open('https://simkl.com/', '_blank')">Open ↗</button>
                    ${skOk ? '' : '<button class="btn-mini" onclick="App.closeModal(); App.openSimklConnect()">Connect</button>'}
                </div>
                ${skOk ? `
                <div class="te-grid">
                    <div>
                        <div class="te-label">Status</div>
                        <select class="setting-select" onchange="App._teSet('simkl','status', this.value)">${statusOpts(d.simkl.status)}</select>
                    </div>
                    <div>
                        <div class="te-label">Score (Simkl scale 1–10) · <b id="te-sk-score">${d.simkl.score || '—'}</b></div>
                        <input type="range" class="setting-range te-range" min="0" max="10" step="1" value="${d.simkl.score}"
                            oninput="App._teSet('simkl','score', parseInt(this.value, 10)); document.getElementById('te-sk-score').textContent = this.value">
                    </div>
                </div>
                ${epRow('simkl', d.simkl.progress)}
                <div class="te-label" style="margin-top:10px">Simkl Memo <span class="te-count">${(d.simkl.memo || '').length}/140</span></div>
                <input type="text" class="app-input" maxlength="140" placeholder="Memo note (max 140 chars)…" value="${this._escEp(d.simkl.memo)}" onchange="App._teSet('simkl','memo', this.value)">
                <div class="te-row" style="margin-top:10px">
                    <span class="te-label">🔒 Private Entry on Simkl</span>
                    <label class="switch"><input type="checkbox" ${d.simkl.priv ? 'checked' : ''} onchange="App._teSet('simkl','priv', this.checked)"><span class="switch-track"></span></label>
                </div>
                <div class="te-note">Only watched episodes are pushed to Simkl from this editor — score, memo and privacy are not synced yet.</div>` : ''}
                ${resLine('simkl')}
            </div>
            <div class="te-footer">
                <span class="te-dirty" id="teDirtyLabel">${this._teDirtyCount() ? this._teDirtyCount() + ' service(s) modified' : 'No changes pending'}</span>
                <button class="btn-secondary" onclick="App.closeModal()">Close</button>
                <button class="btn-primary" id="teSaveBtn" ${this._teDirtyCount() ? '' : 'disabled'} onclick="App.teSave()">Save Progress</button>
            </div>
        `);
    },

    async teSave() {
        const d = this._teDraft;
        if (!d) return;
        const t = this.titleById(d.titleId);
        if (!t) return;
        const btn = document.getElementById('teSaveBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        const fuzzy = v => {
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || '');
            return m ? { year: +m[1], month: +m[2], day: +m[3] } : null;
        };
        const apiStatus = { 'Watching': 'CURRENT', 'Completed': 'COMPLETED', 'Plan to Watch': 'PLANNING', 'On Hold': 'PAUSED', 'Dropped': 'DROPPED', 'Rewatching': 'REPEATING' };
        if (d.anilist.dirty) {
            const conn = Storage.getAnilistConn();
            if (conn && conn.accessToken && t.anilistId) {
                try {
                    const token = await this.anilistAccessToken();
                    await AniList.saveProgress(token, t.anilistId, d.anilist.progress, apiStatus[d.anilist.status] || 'CURRENT', {
                        score: (typeof d.anilist.score === 'number' ? d.anilist.score : null),
                        notes: d.anilist.notes || null,
                        startedAt: fuzzy(d.anilist.start),
                        completedAt: fuzzy(d.anilist.finish)
                    });
                    const eps = [];
                    for (let n = 1; n <= d.anilist.progress; n++) eps.push(n);
                    Storage.setWatchedEps(t.id, eps, this.titleMeta(t));
                    d.results.anilist = { ok: true, msg: 'AniList — saved ✓' };
                    d.anilist.dirty = false;
                    this.trackingListsAt = 0;
                } catch (e) {
                    d.results.anilist = { ok: false, msg: 'AniList — ' + ((e && e.message) || 'save failed') };
                }
            } else {
                d.results.anilist = { ok: false, msg: 'AniList — not connected' };
            }
        }
        if (d.simkl.dirty) {
            const sk = Storage.getSimklConn();
            if (sk && sk.accessToken) {
                try {
                    await Trackers.simklSaveProgress(sk.clientId, sk.accessToken, t, d.simkl.progress);
                    d.results.simkl = { ok: true, msg: 'Simkl — history saved ✓' };
                    d.simkl.dirty = false;
                } catch (e) {
                    d.results.simkl = { ok: false, msg: 'Simkl — ' + ((e && e.message) || 'save failed') };
                }
            } else {
                d.results.simkl = { ok: false, msg: 'Simkl — not connected' };
            }
        }
        this.renderTrackingEditor();
        if (this.currentScreen === 'screen-details') this.renderDetails();
        if (this.currentScreen === 'screen-home') this.renderContinueWatching();
    },

    /* ---------- Streams: ID bridge + Select Stream screen ---------- */
    streamsState: null,

    /* Addons speak IMDb / Kitsu / AniList / MAL ids; our catalog
       speaks AniList. Bridge: AniList gives the MAL id; Jikan
       (MAL's public API) exposes the IMDb link; Kitsu's mapping
       API resolves MAL -> Kitsu. Resolved once, then cached. */
    async resolveAddonIds(t) {
        /* 0) Self-heal: titles reached from sample rails / Continue
           Watching may not carry their AniList/MAL ids yet. One
           AniList search attaches the real ids so every bridge
           below can work. */
        if ((!t.anilistId || !t.malId) && t.title) {
            try {
                const found = await AniList.search(t.title, 5);
                const heal = found.find(x => String(x.year) === String(t.year)) || found[0];
                if (heal) {
                    if (!t.anilistId) t.anilistId = heal.anilistId;
                    if (!t.malId) t.malId = heal.malId;
                }
            } catch (e) { /* ignore — return what we have */ }
        }
        const ids = { tt: null, kitsu: null, anilist: t.anilistId || null, mal: t.malId || null, season: null, epOffset: 0 };
        if (!t.anilistId) return ids;
        const cache = Storage.getIdMap();
        const hit = cache[t.anilistId];
        /* Kitsu is the essential id for anime (season-specific;
           sequel seasons often have NO IMDb link anywhere), so a
           cached entry only short-circuits once kitsu resolved.
           A cached miss is retried, never trusted forever. */
        if (hit && hit.kitsu) {
            ids.tt = hit.imdb || null; ids.kitsu = hit.kitsu;
            /* Older cache entries predate season learning — only
               a season-aware entry may short-circuit the lookup. */
            if (hit.season !== undefined) { ids.season = hit.season; ids.epOffset = hit.epOffset || 0; return ids; }
        }
        if (hit && hit.imdb) ids.tt = hit.imdb;

        /* 1) PRIMARY: api.ani.zip — one call from the AniList id
           straight to kitsu + imdb + mal (verified live: Gintama
           S3 -> kitsu 10083, tt0988818). Open CORS, and a PLAIN
           get — no custom headers anywhere in this function, so
           the browser never sends a CORS preflight (which file://
           pages fail against strict APIs). */
        try {
            const rz = await fetch('https://api.ani.zip/mappings?anilist_id=' + t.anilistId);
            if (rz.ok) {
                const jz = await rz.json();
                const m = (jz && jz.mappings) || {};
                if (m.kitsu_id) ids.kitsu = String(m.kitsu_id);
                if (m.imdb_id && /^tt\d+/.test(m.imdb_id)) ids.tt = m.imdb_id;
                if (m.mal_id && !ids.mal) ids.mal = m.mal_id;
                /* ani.zip also knows where this entry's Episode 1
                   sits inside the parent series: its TVDB season
                   number and its absolute episode number. IMDb
                   addons need both (see streamIdsFor). */
                const ep1 = jz && jz.episodes && jz.episodes['1'];
                if (ep1) {
                    if (typeof ep1.seasonNumber === 'number' && ep1.seasonNumber > 0) ids.season = ep1.seasonNumber;
                    if (typeof ep1.absoluteEpisodeNumber === 'number' && ep1.absoluteEpisodeNumber > 1) ids.epOffset = ep1.absoluteEpisodeNumber - 1;
                }
            }
        } catch (e) { /* ani.zip down — fallbacks below */ }
        /* 2) Fallback: Kitsu's own mapping table — queryable by
           MAL id AND by AniList id (different rows exist for
           each; sequel seasons often have only one of them).
           kitsu.app first, legacy kitsu.io second, header-free. */
        if (!ids.kitsu) {
            const mapQueries = [];
            if (t.malId) mapQueries.push('filter[externalSite]=myanimelist/anime&filter[externalId]=' + t.malId);
            if (t.anilistId) mapQueries.push('filter[externalSite]=anilist/anime&filter[externalId]=' + t.anilistId);
            for (const q of mapQueries) {
                if (ids.kitsu) break;
                for (const host of ['https://kitsu.app', 'https://kitsu.io']) {
                    if (ids.kitsu) break;
                    try {
                        const r2 = await fetch(host + '/api/edge/mappings?' + q + '&include=item');
                        const j2 = await r2.json();
                        const item = j2 && j2.data && j2.data[0] && j2.data[0].relationships &&
                            j2.data[0].relationships.item && j2.data[0].relationships.item.data;
                        if (item && item.id) ids.kitsu = String(item.id);
                    } catch (e) { /* next host / query */ }
                }
            }
        }
        /* 3) Fallback: search Kitsu by title — full title first,
           then with any "Season N" suffix stripped (Kitsu calls
           this entry "Gintama°", not "Gintama Season 3").
           Prefer the result whose start year matches. */
        if (!ids.kitsu && t.title) {
            const stripped = t.title.replace(/\s+Season\s+\d+.*$/i, '').trim();
            const tries = stripped && stripped !== t.title ? [t.title, stripped] : [t.title];
            for (const qTitle of tries) {
                if (ids.kitsu) break;
                try {
                    const r3 = await fetch('https://kitsu.app/api/edge/anime?filter[text]=' + encodeURIComponent(qTitle) + '&page[limit]=10');
                    const j3 = await r3.json();
                    const list = (j3 && j3.data) || [];
                    const match = list.find(item => {
                        const start = item.attributes && item.attributes.startDate;
                        return start && t.year && String(start).indexOf(String(t.year)) === 0;
                    }) || list[0];
                    if (match && match.id) ids.kitsu = String(match.id);
                } catch (e) { /* ignore — other ids still apply */ }
            }
        }
        /* 4) IMDb via Jikan (MAL's external links). Reliable for
           first seasons and movies; sequels usually have none,
           which is exactly why kitsu is resolved first. */
        if (t.malId && !ids.tt) {
            for (let attempt = 0; attempt < 2 && !ids.tt; attempt++) {
                try {
                    const r = await fetch('https://api.jikan.moe/v4/anime/' + t.malId + '/external');
                    const j = await r.json();
                    const imdb = ((j && j.data) || []).find(e => /imdb/i.test(e.name || ''));
                    if (imdb) { const m = /tt\d+/.exec(imdb.url || ''); if (m) ids.tt = m[0]; }
                } catch (e) { /* bridge source down — other ids still apply */ }
                if (!ids.tt && attempt === 0) await new Promise(res => setTimeout(res, 700));
            }
        }
        /* Never cache a total miss — an empty entry proves
           nothing and must not shadow a later retry. */
        if (ids.tt || ids.kitsu) {
            cache[t.anilistId] = { imdb: ids.tt, kitsu: ids.kitsu, season: ids.season, epOffset: ids.epOffset };
            Storage.saveIdMap(cache);
        }
        return ids;
    },

    /* All id forms this addon understands, best first. Callers
       query EVERY candidate and merge (the aggregator strategy).
       CRITICAL dialect rule: IMDb ids take :season:episode, but
       Kitsu / AniList / MAL ids take ONLY :episode — each of
       those databases already splits seasons into separate
       entries, so a season segment makes the id unparseable
       and addons like Torrentio return empty lists. */
    streamIdsFor(addon, ids, t, episode) {
        const prefixes = addon.idPrefixes || [];
        const wants = p => !prefixes.length || prefixes.some(x => x.indexOf(p) === 0);
        const ep = episode || 1;
        const isMovie = t.type === 'Movie';
        const out = [];
        /* An IMDb id points at the WHOLE series, so a sequel entry
           ("Season 2", "2nd Season") must ask for its real season —
           hardcoding :1: fetched Season 1 for Black Clover Season 2
           (his live catch, 2026-10-23). Kitsu/AniList/MAL ids are
           per-season entries already and need no season number. */
        const sMatch = /season\s*(\d+)|(\d+)\s*(?:nd|rd|th)\s*season/i.exec(t.title || '');
        const titleSeason = sMatch ? (parseInt(sMatch[1] || sMatch[2], 10) || null) : null;
        /* ani.zip's measured season beats the title guess (a
           "Part 2" cour is still IMDb season 1 — its episodes are
           reached through the absolute candidate below instead). */
        const seasonNum = ids.season || titleSeason || 1;
        /* Kitsu first: it is season-exact for anime. */
        if (ids.kitsu && wants('kitsu')) out.push(isMovie ? 'kitsu:' + ids.kitsu : 'kitsu:' + ids.kitsu + ':' + ep);
        if (ids.tt && wants('tt')) {
            if (isMovie) out.push(ids.tt);
            else {
                out.push(ids.tt + ':' + seasonNum + ':' + ep);
                /* Long-running series are often indexed by absolute
                   episode under season 1 (ani.zip measured the
                   offset — no per-show magic numbers). */
                if (ids.epOffset > 0) out.push(ids.tt + ':1:' + (ids.epOffset + ep));
            }
        }
        if (ids.anilist && wants('anilist')) out.push(isMovie ? 'anilist:' + ids.anilist : 'anilist:' + ids.anilist + ':' + ep);
        if (ids.mal && wants('mal')) out.push(isMovie ? 'mal:' + ids.mal : 'mal:' + ids.mal + ':' + ep);
        return out;
    },

    playTitle(id, episode) {
        this.openStreams(id, episode || null);
    },

    /* Streams back: normal flow just re-shows the already-rendered
       Details (preserves episode list state). Refresh flow: the
       Details section is still empty at boot, so a bare navigate
       would show a blank screen — render it properly instead. */
    backToDetails() {
        const st = this.streamsState;
        const titleId = st ? st.titleId : this.currentTitleId;
        if (!titleId) { this.goBack(); return; }
        const box = document.getElementById('screen-details');
        if (box && box.innerHTML.trim() && this.currentTitleId === titleId) {
            this.navigate('screen-details');
        } else {
            this.openDetails(titleId);
        }
    },

    openStreams(titleId, episode) {
        /* Addon chips from the first frame (2026-10-26, iOS
           report): the chips row used to wait for loadStreams'
           heal + ID-bridge phases, so during the opening seconds
           of a search no installed addon showed at all — just the
           "Fetching…" text. Seeding the list synchronously here
           means every installed addon shows with its spinning
           circle for the WHOLE search, from tap to results. */
        const seedAddons = Storage.getAddons().filter(a => a.enabled && (!a.resources.length || a.resources.includes('stream')));
        this.streamsState = { titleId, episode: episode || null, groups: [], flat: [], loading: true, tab: 'all', supportedOnly: false, addons: seedAddons };
        this.navigate('screen-streams');
        this.renderStreams();
        this.loadStreams();
        const t = this.titleById(titleId);
        if (!t || t.isPlaceholder) {
            this.ensureTitle(titleId).then(full => {
                if (full && !full.isPlaceholder && this.currentScreen === 'screen-streams' && this.streamsState && this.streamsState.titleId === titleId) {
                    this.renderStreams();
                }
            });
        }
    },

    async loadStreams() {
        const st = this.streamsState;
        const t = this.titleById(st.titleId);
        let addons = Storage.getAddons().filter(a => a.enabled && (!a.resources.length || a.resources.includes('stream')));
        /* Auto-heal: addons installed before the manifest parser
           learned resource-level idPrefixes carry an empty list
           ("accepts everything"). Re-read their manifests once so
           each addon is only ever asked in dialects it knows. */
        const stale = addons.filter(a => !(a.idPrefixes || []).length);
        if (stale.length) {
            try {
                const all = Storage.getAddons();
                for (const s of stale) {
                    try {
                        const fresh = await Addons.fetchManifest(s.manifestUrl);
                        fresh.enabled = s.enabled;
                        fresh.addedAt = s.addedAt || 0;
                        const at = all.findIndex(x => x.manifestUrl === s.manifestUrl);
                        if (at >= 0) all[at] = fresh;
                    } catch (e) { /* keep the stale record */ }
                }
                Storage.saveAddons(all);
                addons = Storage.getAddons().filter(a => a.enabled && (!a.resources.length || a.resources.includes('stream')));
            } catch (e) { /* healing is best-effort */ }
        }
        st.addons = addons;
        /* Re-render now that the healed list is known, so the
           chips stay correct through the ID-bridge race that
           follows (before this, the first render after a heal
           only happened when an addon answered). */
        if (this.streamsState === st) this.renderStreams();
        if (!addons.length) { st.loading = false; this.renderStreams(); return; }
        /* The ID bridge must never freeze this screen: a slow or
           failing bridge falls back to the ids we already have. */
        let ids = { tt: null, kitsu: null, anilist: t.anilistId || null, mal: t.malId || null };
        try {
            ids = await Promise.race([
                this.resolveAddonIds(t),
                new Promise(resolve => setTimeout(() => resolve(ids), 6000))
            ]);
        } catch (e) { /* keep the fallback ids */ }
        await Promise.allSettled(addons.map(async (addon, idx) => {
            /* Anime-only addons (manifest types: ['anime']) want
               /stream/anime/…, general ones want /stream/series/… */
            const addonTypes = addon.types || [];
            const type = t.type === 'Movie' ? 'movie'
                : (addonTypes.includes('anime') && !addonTypes.includes('series')) ? 'anime' : 'series';
            const sids = this.streamIdsFor(addon, ids, t, st.episode);
            if (!sids.length) {
                st.groups.push({ addon, idx, streams: [], note: 'No compatible ID for this title — ' + addon.name + ' understands: ' + ((addon.idPrefixes || []).join(', ') || 'imdb ids') });
            } else {
                try {
                    const merged = [];
                    const seen = new Set();
                    for (const sid of sids) {
                        const found = await Addons.getStreams(addon, type, sid);
                        for (const s of found) {
                            const key = s.url || s.infoHash || ((s.name || '') + '|' + (s.title || ''));
                            if (!seen.has(key)) { seen.add(key); merged.push(s); }
                        }
                    }
                    st.groups.push({ addon, idx, streams: merged, sidNote: 'Asked as ' + sids.join(' · ') });
                } catch (e) {
                    st.groups.push({ addon, idx, streams: [], note: 'Could not fetch: ' + e.message });
                }
            }
            if (this.streamsState === st) this.renderStreams();
        }));
        st.loading = false;
        if (this.streamsState === st) this.renderStreams();
    },

    setStreamTab(tab) {
        if (!this.streamsState) return;
        this.streamsState.tab = tab;
        this.renderStreams();
    },

    /* Re-fetch every addon's streams from scratch. The old
       loadStreams' identity guard (streamsState === st) means
       any late reply from the previous fetch is ignored. */
    refreshStreams() {
        if (!this.streamsState) return;
        const { titleId, episode, tab, supportedOnly } = this.streamsState;
        const seedAddons = Storage.getAddons().filter(a => a.enabled && (!a.resources.length || a.resources.includes('stream')));
        this.streamsState = { titleId, episode, groups: [], flat: [], loading: true, tab, supportedOnly: !!supportedOnly, addons: seedAddons };
        this.renderStreams();
        this.loadStreams();
    },

    toggleSupportedFilter() {
        if (!this.streamsState) return;
        this.streamsState.supportedOnly = !this.streamsState.supportedOnly;
        this.renderStreams();
    },

    /* Browser-playable = a direct URL, not flagged notWebReady,
       and no surround codec in the release text (same regex the
       audio badges use — the filter is the badges, enforced). */
    isStreamSupported(s) {
        if (!s || !s.url || !/^https?:\/\//i.test(s.url)) return false;
        if ((s.behaviorHints || {}).notWebReady) return false;
        const fullText = ((s.name || '') + ' ' + (s.title || '') + ' ' + (s.description || '')).toLowerCase();
        return !/\b(eac3|e-ac-3|ac3|ac-3|dts|truehd|atmos|5\.1|7\.1)\b/i.test(fullText);
    },

    renderStreams() {
        const box = document.getElementById('screen-streams');
        const st = this.streamsState;
        if (!box || !st) return;
        const t = this.titleById(st.titleId);
        const groups = st.groups.slice().sort((a, b) => a.idx - b.idx);
        const total = groups.reduce((n, g) => n + g.streams.length, 0);
        const supportedTotal = groups.reduce((n, g) => n + g.streams.filter(s => this.isStreamSupported(s)).length, 0);
        st.flat = [];
        const visible = st.tab === 'all' ? groups : groups.filter(g => g.idx === st.tab);
        /* No streaming addons at all → the compact popup (Fix
           6b), worded DMCA-safe (Fix 6c): no "streaming", no
           brand names — just "No supported addon found". */
        if (!st.loading && !st.addons.length && !st._noAddonPopupShown) {
            st._noAddonPopupShown = true;
            setTimeout(() => {
                if (this.currentScreen === 'screen-streams') {
                    this.openModal(`
                        <h3 class="modal-title">No supported addon found</h3>
                        <p class="text-secondary">You have not installed any addons yet. Install an addon to discover community anime links.</p>
                        <button class="btn-primary" onclick="App.closeModal(); App.openAddonSettings()">Manage Addons</button>
                        <button class="btn-secondary" onclick="App.closeModal()">Close</button>
                    `);
                }
            }, 60);
        }
        const listHTML = (!st.loading && !st.addons.length) ? `
            <div class="settings-group" style="margin-top:16px">
                <div class="setting-label">No supported addon found</div>
                <button class="btn-primary" onclick="App.openAddonSettings()">Manage Addons</button>
            </div>`
            : (st.loading && !groups.length)
            ? '<p class="text-secondary" style="margin-top:14px">Fetching streams from your addons…</p>'
            : visible.map(g => {
                const shownStreams = st.supportedOnly ? g.streams.filter(s => this.isStreamSupported(s)) : g.streams;
                return `
            <div class="stream-group">
                <div class="stream-group-head">
                    ${(g.addon.logo && /^https?:\/\//i.test(g.addon.logo)) ? `<img class="stream-group-logo" src="${this.esc(g.addon.logo)}" alt="">` : ''}
                    <span>${this.esc(g.addon.name)}</span>
                    <span class="version-chip">${shownStreams.length}${st.supportedOnly ? ' / ' + g.streams.length : ''} streams</span>
                </div>
                ${g.note ? `<p class="text-secondary">${this.esc(g.note)}</p>` : ''}
                ${shownStreams.map(s => this.streamCardHTML(g.addon, s, st)).join('')}
                ${!g.note && !shownStreams.length ? `<p class="text-secondary">${st.supportedOnly && g.streams.length ? 'No browser-supported streams here — turn off the Supported filter to see all.' : 'No streams found for this title.'}</p>` : ''}
            </div>`;
            }).join('');
        box.innerHTML = `
            <div class="screen-pad">
                <div class="streams-head">
                    <button class="back-btn" onclick="App.backToDetails()">←</button>
                    ${this._safeImgUrl(t.poster) ? `<img class="streams-poster" src="${this._safeImgUrl(t.poster)}" alt="">` : ''}
                    <div style="flex:1; min-width:0">
                        <div class="streams-title">${this.esc(t.title)}</div>
                        <div class="setting-desc">${t.type === 'Movie' ? 'Movie' : 'Season 1 · Episode ' + (st.episode || 1)} · ${t.year} · ★ ${t.score}</div>
                        <div class="setting-desc">${st.loading ? 'Asking your addons…' : total + ' streams (' + supportedTotal + ' browser-ready) from ' + groups.length + ' addons'}</div>
                    </div>
                    <div class="streams-head-tools">
                        <button class="ftab ${st.supportedOnly ? 'active' : ''}" onclick="App.toggleSupportedFilter()" title="Show only browser-playable links">✓ Supported${!st.loading ? ' · ' + supportedTotal : ''}</button>
                        <button class="ftab" onclick="App.refreshStreams()" ${st.loading ? 'disabled' : ''} title="Refresh all streams">${st.loading ? '<span class="chip-spin"></span>' : '↻'} Refresh</button>
                    </div>
                </div>
                ${st.addons.length ? `<div class="stream-tabs">
                    <button class="ftab ${st.tab === 'all' ? 'active' : ''}" onclick="App.setStreamTab('all')">All · ${st.supportedOnly ? supportedTotal : total}</button>
                    ${st.addons.map((a, i) => {
                        /* Fix 6a: chips list STREAMING addons only
                           (loadStreams already filtered to the
                           stream resource), and a chip spins while
                           its addon is still searching. */
                        const done = groups.some(g => g.idx === i);
                        const gObj = done ? groups.find(g => g.idx === i) : null;
                        const count = gObj ? (st.supportedOnly ? gObj.streams.filter(s => this.isStreamSupported(s)).length : gObj.streams.length) : null;
                        return `<button class="ftab ${st.tab === i ? 'active' : ''}" onclick="App.setStreamTab(${i})">${done ? '' : '<span class="chip-spin"></span>'}${this._escEp(a.name)}${done ? ' · ' + count : ''}</button>`;
                    }).join('')}
                </div>` : ''}
                <div id="streamList">${listHTML}</div>
            </div>`;
    },

    /* Parse an addon stream's free-text description into the
       pieces the card design needs. Torrentio's shape:
         line 1: the release filename
         line 2: "👤 seeders 💾 size ⚙ source"
         rest:   subtitle / language lines
       Anything unrecognized falls back to filename + raw lines,
       so other addons' streams still render cleanly. */
    parseStreamDesc(s) {
        const lines = (s.title || s.description || '').split('\n').map(x => x.trim()).filter(Boolean);
        const out = { file: '', seeders: '', size: '', source: '', info: [] };
        lines.forEach((rawLine, i) => {
            const line = rawLine.replace(/️/g, '');
            if (/👤|💾|⚙/.test(line)) {
                const seed = /👤\s*([\d,]+)/.exec(line);
                const size = /💾\s*([\d.]+\s*[KMGT]B)/i.exec(line);
                const src = /⚙\s*([A-Za-z0-9._-]+)/.exec(line);
                if (seed) out.seeders = seed[1];
                if (size) out.size = size[1].replace(/\s+/g, ' ');
                if (src && !out.source) out.source = src[1];
            } else if (i === 0 && !out.file) {
                out.file = line;
            } else {
                out.info.push(line);
            }
        });
        return out;
    },

    streamCardHTML(addon, s, st) {
        const flatIndex = st.flat.length;
        st.flat.push({ addon, stream: s });
        const playable = !!s.url;
        const nameParts = (s.name || addon.name).split('\n');
        const addonName = nameParts[0] || addon.name;
        const quality = (nameParts[1] || '').trim();
        const qClass = /4k|2160/i.test(quality) ? 'q-gold' : /1080/.test(quality) ? 'q-blue' : /720/.test(quality) ? 'q-grey' : 'q-plain';
        const d = this.parseStreamDesc(s);
        const hints = s.behaviorHints || {};
        /* Browser audio intel: Chromium can't decode AC3/EAC3/
           DTS/TrueHD/Atmos, so surround releases play silent
           in-browser. AAC/Opus releases (SubsPlease, Erai-raws,
           WEB-DL) always have sound. Badges, not gates. */
        const fullText = ((s.name || '') + ' ' + (s.title || '') + ' ' + (s.description || '')).toLowerCase();
        const badAudio = /\b(eac3|e-ac-3|ac3|ac-3|dts|truehd|atmos|5\.1|7\.1)\b/i.test(fullText);
        const goodAudio = /\b(aac|opus|subsplease|erai-raws|horriblesubs)\b/i.test(fullText);
        /* Unsupported = the addon itself flags it not web-ready,
           or there is no direct URL to play (magnet/external only).
           Tapping an unsupported card opens the choice popup
           (Play in player / Redirect) instead of forcing a path. */
        const unsupported = !!hints.notWebReady || !playable;
        const cardAction = unsupported ? `App.openStreamChoice(${flatIndex})` : `App.playStreamAt(${flatIndex})`;
        /* Compact row: the action buttons sit vertically centred
           on the middle-left, the metadata flows on the right —
           the old bottom action row made every card ~35% taller
           for no information gain. All badges and handlers are
           unchanged; only the layout moved. */
        return `
            <div class="stream-card compact-row ${playable ? 'is-direct' : ''}" ${cardAction ? `onclick="${cardAction}"` : ''}>
                <div class="sc-right-body">
                    <div class="sc-top">
                        <span class="sc-kind">${playable ? '⚡' : '🧲'}</span>
                        <span class="sc-addon">${this._escEp(addonName)}</span>
                        ${quality ? `<span class="sc-quality ${qClass}">${this._escEp(quality)}</span>` : ''}
                        ${d.source ? `<span class="sc-source">${this._escEp(d.source)}</span>` : ''}
                        ${d.seeders ? `<span class="sc-stat"><span class="sc-stat-ic">👤</span>${d.seeders}</span>` : ''}
                        ${d.size ? `<span class="sc-stat"><span class="sc-stat-ic">💾</span>${d.size}</span>` : ''}
                    </div>
                    ${d.file ? `<div class="sc-file">${this._escEp(d.file)}</div>` : ''}
                    ${d.info.length ? `<div class="sc-info">${d.info.map(x => this._escEp(x)).join(' · ')}</div>` : ''}
                    <div class="stream-badges">
                        ${hints.notWebReady ? '<span class="stream-badge warn">Video may not work in this browser</span>' : ''}
                        ${badAudio ? '<span class="stream-badge warn">Surround audio (EAC3/5.1) — silent in browser, use MPV/VLC</span>' : ''}
                        ${goodAudio && !badAudio ? '<span class="stream-badge" style="color:#4ade80; border-color:#4ade8044">✓ Browser audio ready (AAC)</span>' : ''}
                        ${hints.bingeGroup ? `<span class="stream-badge">Binge: ${this._escEp(hints.bingeGroup)}</span>` : ''}
                        ${!playable && s.infoHash ? '<span class="stream-badge">Torrent — magnet only</span>' : ''}
                    </div>
                </div>
                <div class="sc-side-actions">
                    ${playable ? `<button class="btn-primary sc-play-btn" onclick="event.stopPropagation(); App.playStreamAt(${flatIndex})" title="Play stream">▶ Play</button>
                    <button class="btn-mini sc-copy-btn" onclick="event.stopPropagation(); App.copyStreamLinkAt(${flatIndex}, event)" title="Copy direct link">Copy</button>` : ''}
                    ${s.infoHash ? `<button class="btn-mini sc-copy-btn" onclick="event.stopPropagation(); App.copyMagnetAt(${flatIndex}, event)">🧲 Magnet</button>` : ''}
                    ${s.externalUrl ? `<button class="btn-mini sc-copy-btn" onclick="event.stopPropagation(); App.openExternalAt(${flatIndex})">↗ Ext</button>` : ''}
                </div>
            </div>`;
    },

    playStreamAt(i) {
        const st = this.streamsState;
        const entry = st && st.flat[i];
        if (!entry || !entry.stream.url || !/^https?:\/\//i.test(entry.stream.url)) return;
        const t = this.titleById(st.titleId);
        const label = t.title + (st.episode ? ' · Episode ' + st.episode : '');
        Player.open(entry.stream.url, label, entry.stream);
    },

    /* Tapping an UNSUPPORTED stream (addon-flagged not web-ready,
       or no direct URL — magnet/external only) pops a small
       choice window, Gemini-style: the user picks how to proceed
       instead of the app forcing a path.
         ▶ Play in player — try it in the built-in player anyway
           (shown whenever the stream carries a playable URL).
         ↗ Redirect — hand the link off outside the app: magnet →
           torrent client, externalUrl → that page, direct URL →
           the raw link in a new tab (external players pick it up).
       Redirect is always offered; Play only when a URL exists —
       a magnet has nothing the browser could play. */
    openStreamChoice(i) {
        const entry = this.streamsState && this.streamsState.flat[i];
        if (!entry) return;
        const s = entry.stream;
        const d = this.parseStreamDesc(s);
        this.openModal(`
            <h3 class="modal-title">${this._escEp(entry.addon.name)} — may not play in the browser</h3>
            ${d.file ? `<p class="text-secondary" style="word-break:break-all">${this._escEp(d.file)}</p>` : ''}
            ${(d.seeders || d.size) ? `<p class="text-secondary">${d.seeders ? '👤 ' + d.seeders + ' seeders' : ''}${d.seeders && d.size ? ' · ' : ''}${d.size ? '💾 ' + d.size : ''}</p>` : ''}
            ${s.url ? `<button class="btn-primary" onclick="App.closeModal(); App.playStreamAt(${i})">▶ Play in player</button>` : ''}
            <button class="btn-secondary" onclick="App.redirectStreamAt(${i})">↗ Redirect</button>
            ${s.infoHash ? `<button class="btn-secondary" onclick="App.copyMagnetAt(${i}, event)">Copy magnet link</button>` : ''}
            <button class="btn-secondary" onclick="App.closeModal()">Close</button>
        `);
    },

    /* The Redirect half of the choice popup: hand the stream's
       link to whatever lives outside the app. */
    redirectStreamAt(i) {
        const entry = this.streamsState && this.streamsState.flat[i];
        if (!entry) return;
        const s = entry.stream;
        this.closeModal();
        if (s.infoHash && !s.url) { this.openMagnetAt(i); return; }
        if (s.externalUrl && /^https?:\/\//i.test(s.externalUrl)) { window.open(s.externalUrl, '_blank', 'noopener,noreferrer'); return; }
        if (s.url && /^https?:\/\//i.test(s.url)) window.open(s.url, '_blank', 'noopener,noreferrer');
    },

    openMagnetAt(i) {
        const entry = this.streamsState && this.streamsState.flat[i];
        if (!entry || !entry.stream.infoHash) return;
        const a = document.createElement('a');
        a.href = 'magnet:?xt=urn:btih:' + entry.stream.infoHash;
        document.body.appendChild(a);
        a.click();
        a.remove();
    },

    openExternalAt(i) {
        const entry = this.streamsState && this.streamsState.flat[i];
        if (entry && entry.stream.externalUrl && /^https?:\/\//i.test(entry.stream.externalUrl)) window.open(entry.stream.externalUrl, '_blank', 'noopener,noreferrer');
    },

    async copyMagnetAt(i, ev) {
        const entry = this.streamsState && this.streamsState.flat[i];
        if (!entry || !entry.stream.infoHash) return;
        const magnet = 'magnet:?xt=urn:btih:' + entry.stream.infoHash;
        const btn = ev && ev.target;
        const done = label => {
            if (!btn) return;
            const old = btn.textContent;
            btn.textContent = label;
            setTimeout(() => { btn.textContent = old; }, 1800);
        };
        let copied = false;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            try { await navigator.clipboard.writeText(magnet); copied = true; } catch (e) { copied = false; }
        }
        if (copied) done('Copied ✓');
        else window.prompt('Copy this magnet link:', magnet);
    },

    /* Copy Link on stream cards (Fix 6d): copies the stream's
       direct URL — the handoff external players want. */
    async copyStreamLinkAt(i, ev) {
        const entry = this.streamsState && this.streamsState.flat[i];
        if (!entry || !entry.stream.url) return;
        const btn = ev && ev.target;
        let copied = false;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            try { await navigator.clipboard.writeText(entry.stream.url); copied = true; } catch (e) { copied = false; }
        }
        if (copied && btn) {
            const old = btn.textContent;
            btn.textContent = 'Copied ✓';
            setTimeout(() => { btn.textContent = old; }, 1800);
        } else if (!copied) {
            window.prompt('Copy this stream link:', entry.stream.url);
        }
    },

    openAddonSettings() {
        this.navigate('screen-profile');
        this.openSettingsPage('addons');
    },

    closePlayer() {
        Player.close();
    },

    /* ---------- Settings: sidebar tabs + sub-pages (demerged 2026-10-24) ----------
       No Account/General groups any more: the six former sub-pages
       ARE the sidebar tabs. Sub-pages (integrations,
       services, layout editors) remember their parent tab, so Back
       returns to the tab you came from. */
    openSettingsPage(page, parent) {
        const tabs = ['account', 'tracking', 'layout', 'addons', 'playback', 'about'];
        if (tabs.includes(page)) {
            this.settingsPage = page;
            this.settingsParent = page;
        } else {
            this.settingsPage = page;
            this.settingsParent = parent || this.settingsParent || 'account';
        }
        /* Mobile: a tapped menu row (or deep link) opens that section. */
        this.mobileSettings = page;
        this.renderSettings();
        window.scrollTo(0, 0);
    },

    backToSettingsTab() {
        this.settingsPage = this.settingsParent || 'account';
        /* Mobile: back from a sub-page lands on its parent section. */
        this.mobileSettings = this.settingsParent || 'account';
        this.renderSettings();
    },

    /* Mobile: back from a section lands on the Settings menu. */
    closeMobileSettings() {
        this.mobileSettings = null;
        this.renderSettings();
    },

    renderSettings() {
        const root = document.getElementById('settingsRoot');
        if (!root) return;
        if (!this.settingsPage) this.settingsPage = 'account';
        /* Mobile menu: Settings opens on a tappable section list.
           Tapping a row calls openSettingsPage, which sets
           mobileSettings and re-renders into the section view below. */
        if (this._isMobileSettings() && this.mobileSettings == null) {
            root.innerHTML = this.settingsMenuHTML();
            return;
        }
        let panel = '';
        switch (this.settingsPage) {
            case 'account':       panel = this.pageAccountTab(); break;
            case 'tracking':      panel = this.pageTracking(); break;
            case 'layout':        panel = this.pageLayout(); break;
            case 'addons':        panel = this.pageAddons(); break;
            case 'playback':      panel = this.pagePlayback(); break;
            case 'aniskip':       panel = this.pageAniskip(); break;
            case 'about':         panel = this.pageAbout(); break;
            default:
                panel = this.pageAccountTab();
        }
        const tab = (page, label) => `
            <button class="side-tab ${this.settingsPage === page ? 'active' : ''}" onclick="App.openSettingsPage('${page}')">${label}</button>`;
        /* Mobile section view: panel only, no sidebar — the section's
           own back arrow (see backHeader) returns to the menu. */
        if (this._isMobileSettings() && this.mobileSettings != null) {
            root.innerHTML = `<div class="settings-panel">${panel}</div>`;
            return;
        }
        root.innerHTML = `
            <div class="settings-layout">
                <aside class="settings-sidebar">
                    <div class="settings-side-title">Settings</div>
                    ${tab('account', 'Account')}
                    ${tab('tracking', 'Tracking')}
                    ${tab('layout', 'Layout')}
                    ${tab('addons', 'Addon')}
                    ${tab('playback', 'Playback')}
                    ${tab('about', 'About & Credits')}
                </aside>
                <div class="settings-panel">${panel}</div>
            </div>`;
    },

    /* Mobile Settings menu (2026-10-27): icon + title + description
       rows, one per section. Tapping a row opens that section. */
    settingsMenuHTML() {
        const ico = (inner) => `<span class="settings-menu-ico"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg></span>`;
        const row = (page, icon, title, desc) => `
            <div class="settings-menu-row" onclick="App.openSettingsPage('${page}')">
                ${ico(icon)}
                <span class="settings-menu-text"><b>${title}</b><span>${desc}</span></span>
            </div>`;
        return `
            <div class="panel-title">Settings</div>
            <div class="settings-menu-card">
                ${row('account', '<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/>', 'Account', 'Profile, sign in, cloud sync')}
                ${row('tracking', '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>', 'Tracking', 'AniList, MyAnimeList, Simkl')}
                ${row('layout', '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>', 'Layout', 'Theme, hero, rails, detail pages')}
                ${row('addons', '<path d="M8 3h8v4h4v8h-4v4H8v-4H4V7h4z"/>', 'Addon', 'Install and manage addons')}
                ${row('playback', '<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/>', 'Playback', 'Player, subtitles, and auto-play')}
                ${row('about', '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', 'About & Credits', 'Version, credits, and links')}
            </div>`;
    },

    /* --- row helpers (read current settings each render) ---
       Fix 10 (copy sweep): rows carry NO description text —
       labels stand on their own. The desc argument is accepted
       for call-site compatibility and intentionally not rendered;
       only live values (sInfo) and statuses print under a label. */
    sToggle(key, label, desc) {
        const s = Storage.getSettings();
        return `
            <div class="setting-row">
                <div class="setting-text"><div class="setting-label">${label}</div></div>
                <label class="switch">
                    <input type="checkbox" ${s[key] ? 'checked' : ''} onchange="App.updateSetting('${key}', this.checked)">
                    <span class="switch-track"></span>
                </label>
            </div>`;
    },

    sSelect(key, label, options, desc) {
        const s = Storage.getSettings();
        const opts = options.map(o => `<option value="${o}" ${String(s[key]) === String(o) ? 'selected' : ''}>${o}</option>`).join('');
        return `
            <div class="setting-row">
                <div class="setting-text"><div class="setting-label">${label}</div></div>
                <select class="setting-select" onchange="App.updateSetting('${key}', this.value)">${opts}</select>
            </div>`;
    },

    sSlider(key, label, min, max, unit) {
        const s = Storage.getSettings();
        return `
            <div class="setting-row">
                <div class="setting-text"><div class="setting-label">${label}</div></div>
                <input type="range" class="setting-range" min="${min}" max="${max}" value="${s[key]}"
                    oninput="App.updateSetting('${key}', parseFloat(this.value)); document.getElementById('sliderVal-${key}').textContent = this.value + '${unit}'">
                <span class="slider-value" id="sliderVal-${key}">${s[key]}${unit}</span>
            </div>`;
    },

    sRow(label, desc, onclick) {
        return `
            <div class="setting-row clickable" onclick="${onclick}">
                <div class="setting-text"><div class="setting-label">${label}</div></div>
                <span class="setting-chevron">›</span>
            </div>`;
    },

    sInfo(label, value) {
        return `
            <div class="setting-row">
                <div class="setting-text"><div class="setting-label">${label}</div></div>
                <span class="setting-value">${value}</span>
            </div>`;
    },

    /* Mobile Settings breakpoint (matches the <=900px sidebar collapse). */
    _isMobileSettings() {
        return typeof window !== 'undefined' && !!window.matchMedia &&
            window.matchMedia('(max-width: 900px)').matches;
    },

    backHeader(title) {
        const topTabs = ['account', 'tracking', 'layout', 'addons', 'playback', 'about'];
        /* Mobile section view: tab pages get a back arrow to the menu
           instead of a bare title (desktop keeps the bare title, since
           its sidebar tabs are the navigation). */
        if (topTabs.includes(this.settingsPage) && this._isMobileSettings() && this.mobileSettings != null) {
            return `
            <div class="subpage-header">
                <button class="back-btn" onclick="App.closeMobileSettings()">←</button>
                <h2 class="subpage-title">${title}</h2>
            </div>`;
        }
        if (topTabs.includes(this.settingsPage)) {
            return `<div class="panel-title">${title}</div>`;
        }
        return `
            <div class="subpage-header">
                <button class="back-btn" onclick="App.backToSettingsTab()">←</button>
                <h2 class="subpage-title">${title}</h2>
            </div>`;
    },

    /* --- Account tab (2026-10-24, context-aware 2026-10-25):
       tapping the tab shows the account options DIRECTLY, no drill row.
       (Switch Profile already lives in the top-bar chip.)
       Guest fix: a Guest user has nothing to sign out of, so showing
       "Sign Out" to them was pure confusion. Guests now see their true
       state ("Guest (Local Only)") and a "Sign In / Create Account"
       button that just returns to the gate (signOut() clears the guest
       auth flag and shows the gate — it never wipes profiles/data).
       Signed-in users still see their email + normal Sign Out.
       Reset is a separate, confirmed, destructive action — never
       bundled into Sign Out, so an accidental tap cannot wipe
       addons, library or watch history. --- */
    pageAccountTab() {
        const auth = Storage.getAuthState();
        const isGuest = !!auth.isGuest;
        const status = isGuest ? 'Guest (Local Only)' : (auth.email || 'Signed in');
        /* Phase 2 cloud sync status (2026-10-26): read from the
           last sync record; guests see a plain note instead. */
        let syncBlock = '';
        if (isGuest) {
            syncBlock = `<div class="settings-group">${this.sInfo('Cloud Sync', 'Off — guest mode does not sync. Sign in to sync.')}</div><div style="height:14px"></div>`;
        } else {
            let syncText = 'Never synced yet';
            try {
                const last = (typeof Sync !== 'undefined' && Sync.getLast()) || null;
                if (last) syncText = (last.status === 'synced' ? 'Last synced ' : 'Last sync: ' + last.status + ' — ')
                    + new Date(last.at).toLocaleString() + (last.detail ? ' · ' + last.detail : '');
                else if (Sync && Sync.lastError) syncText = 'Error: ' + Sync.lastError;
            } catch (e) {}
            syncBlock = `<div class="settings-group">
                ${this.sInfo('Cloud Sync', this.esc(syncText))}
                <div style="height:10px"></div>
                <button class="btn-white" onclick="App.syncNowManual()">Sync Now</button>
                <div style="height:8px"></div>
                <div style="font-size:12px; opacity:0.75; line-height:1.5">Syncs automatically — profiles, watched, library, settings and addons to your account, within seconds of any change and when you leave the app. Tracking logins (AniList / Simkl / MAL) and key-bearing addon URLs do NOT sync — reconnect those once per device. If sync fails, first create the Firestore database and set its rules (one-time console steps — ask Nounou for them).</div>
            </div><div style="height:14px"></div>`;
        }
        return `
            <div class="panel-title">Account</div>
            <div class="settings-group">
                ${this.sInfo('Status', status)}
            </div>
            <div style="height:14px"></div>
            ${syncBlock}
            ${isGuest
                ? `<button class="btn-white" onclick="App.signOut()">Sign In / Create Account</button>`
                : `<button class="btn-white" onclick="App.signOut()">Sign Out</button>`}
            <div style="height:10px"></div>
            ${/* Reset rule (2026-10-26, his ruling): when signed in,
               everything syncs to the cloud by default, so a local
               reset option only confuses — it is hidden entirely.
               Guests have no cloud copy, so for them it stays as
               the only way to clear this device. */
              isGuest
                ? `<button class="btn-secondary" style="color:#f87171; border-color:rgba(248,113,113,0.3)" onclick="App.wipeDeviceData()">Reset All Local Data</button>`
                : ''}
            <div class="settings-footer">Made with ♥ by Isolated<br>${Config.APP_VERSION}<br>Based on NuvioWeb</div>`;
    },

    /* Manual Phase 2 sync from Settings → Account. Merges this
       device with the cloud, then refreshes the settings view so
       the new status shows. A pulled profile list appears in the
       profile picker on the next visit to it. */
    async syncNowManual() {
        if (typeof Sync === 'undefined') { alert('Cloud sync is not loaded in this build.'); return; }
        const r = await Sync.syncNow({ manual: true });
        alert(r.message || ('Sync: ' + r.status));
        try { this.renderSettings(); } catch (e) {}
    },

    /* Reset All Local Data — the ONLY wipe in the app, behind a
       confirm(). Deletes every ganime_* localStorage key (profiles,
       settings, addons, watched, library, tracking, caches, auth)
       plus sessionStorage, then reloads to a clean gate. Sign Out
       deliberately does NOT do this. */
    wipeDeviceData() {
        if (!confirm('Reset all local data on this browser? This will permanently delete your profiles, installed addons, watch history, and local library.')) return;
        Object.keys(localStorage).forEach(k => {
            if (k.startsWith('ganime_')) localStorage.removeItem(k);
        });
        try { sessionStorage.clear(); } catch (e) {}
        window.location.hash = '';
        window.location.reload();
    },

    /* About & Credits (Fix 8a): structure from the reference
       page, content = GAnime's own credits — the APIs and tech
       it runs on, the design inspiration, and the two partners
       he ruled into the credits (Muse + Gemini). */
    pageAbout() {
        const card = (title, body) => `
            <div class="credit-card">
                <div class="credit-title">${title}</div>
                <div class="credit-body">${body}</div>
            </div>`;
        return `
            ${this.backHeader('About & Credits')}
            <p class="text-secondary" style="margin-bottom:16px">A client-side anime web app with zero backend video hosting. All catalogue metadata is retrieved directly via public GraphQL and REST APIs.</p>
            <div class="credit-grid">
                ${card('AniList GraphQL API', 'Provides comprehensive anime metadata, rankings, airing schedules, and cover imagery.')}
                ${card('ani.zip API', 'Cross-database mappings between AniList, MyAnimeList, TVDb, and IMDb IDs.')}
                ${card('AniSkip Service', 'Crowdsourced timestamp intervals for opening (OP) and ending (ED) skip buttons.')}
                ${card('movi-player', 'Modern WebCodecs/WASM playback engine supporting HLS, MPEG-DASH, and direct file playback.')}
                ${card('movi-player by MrUjjwalG', 'Creator of movi-player — the player engine behind GAnime, credited here and in the GitHub About. Without a player, the app would be just a fancy showcase.')} 
                ${card('Built with Muse & Gemini', 'Designed and built by Isolated in a three-way collaboration — Muse (build & verification) and Gemini (analysis & benchmarking).')}
            </div>
            <div class="credit-card wide">
                <div class="credit-title">♥ NuvioWeb Inspiration</div>
                <div class="credit-body">UI and player design inspired by NuvioWeb — modern glass styling, floating control pills, and a sleek dark aesthetic.</div>
            </div>
            <div class="settings-footer">Made with ♥ by Isolated<br>${Config.APP_VERSION}</div>`;
    },

    setCwSource(value) {
        /* BUGFIX (2026-10-24): this used to call saveSettings with
           a PARTIAL object, which replaced the whole settings file
           — wiping accentId (and every other setting) so the theme
           fell back to white on the next load. updateSetting merges
           one key into the saved object instead. */
        Storage.updateSetting('continueWatchingSource', value);
        this.renderSettings();
        this.renderContinueWatching();
    },

    pageTracking() {
        const s = Storage.getSettings();
        const al = Storage.getAnilistConn();
        const mal = Storage.getMalConn();
        const sk = Storage.getSimklConn();
        const statCard = (name, ok, who, onclick) => `
            <div class="tracker-stat-card">
                <div class="tsc-top"><span class="tsc-name">${name}</span><span class="tsc-dot ${ok ? 'on' : ''}"></span></div>
                <div class="tsc-state">${ok ? this.esc(who || 'Connected') : 'Not configured'}</div>
                <button class="btn-mini" onclick="${onclick}">${ok ? 'Manage' : 'Connect'}</button>
            </div>`;
        const cw = s.continueWatchingSource || 'tracked';
        /* The stat cards ARE the account controls now (2026-10-24):
           the old ACCOUNTS provider cards below duplicated them
           with the old design, so they were removed. Connected
           cards open a Manage modal (Disconnect / Reconnect);
           unconnected ones open the connect flow. */
        return `
            ${this.backHeader('Tracking')}
            <div class="tracker-stat-row">
                ${statCard('AniList', !!(al && al.accessToken), al && al.user ? '@' + al.user.name : '', (al && al.accessToken) ? "App.openTrackerManage('anilist')" : 'App.connectAnilistOneClick()')}
                ${statCard('MyAnimeList', !!(mal && (mal.accessToken || mal.listsCache)), mal && mal.user ? '@' + mal.user.name : '', (mal && (mal.accessToken || mal.listsCache)) ? "App.openTrackerManage('mal')" : 'App.openMalConnect()')}
                ${statCard('Simkl', !!(sk && sk.accessToken), sk && sk.user ? '@' + sk.user.name : '', (sk && sk.accessToken) ? "App.openTrackerManage('simkl')" : 'App.openSimklConnect()')}
            </div>
            <div class="section-label">CONTINUE WATCHING DATA SOURCE</div>
            <div class="cw-source-row">
                <button class="cw-source-card ${cw === 'cloud' ? 'active' : ''}" onclick="App.setCwSource('cloud')">
                    <span class="cw-source-name">GAnime Cloud</span>
                    <span class="cw-source-sub">Cross-device sync store</span>
                </button>
                <button class="cw-source-card ${cw === 'tracked' ? 'active' : ''}" onclick="App.setCwSource('tracked')">
                    <span class="cw-source-name">Tracked Sync</span>
                    <span class="cw-source-sub">AniList / MAL / Simkl</span>
                </button>
            </div>`;
    },

    /* Manage modal for a CONNECTED tracker — this is where
       Disconnect lives now that the old provider cards are gone. */
    openTrackerManage(provider) {
        const conns = {
            anilist: { name: 'AniList', conn: Storage.getAnilistConn() || {}, disc: 'App.anilistDisconnect()', recon: 'App.connectAnilistOneClick()' },
            mal: { name: 'MyAnimeList', conn: Storage.getMalConn() || {}, disc: 'App.malDisconnect()', recon: 'App.openMalConnect()' },
            simkl: { name: 'Simkl', conn: Storage.getSimklConn() || {}, disc: 'App.simklDisconnect()', recon: 'App.openSimklConnect()' }
        };
        const p = conns[provider];
        if (!p) return;
        const who = p.conn.user ? this.esc(p.conn.user.name) : 'Connected';
        this.openModal(`
            <h3 class="modal-title">${p.name}</h3>
            <p class="text-secondary">Connected as <b>${who}</b> — sync is live.</p>
            <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:14px">
                ${provider === 'mal' ? `<button class="btn-secondary" onclick="App.closeModal(); App.openMalConnect()">Sync / Update</button>` : ''}
                <button class="btn-secondary" onclick="App.closeModal(); ${p.recon}">Reconnect</button>
                <button class="btn-primary" onclick="App.closeModal(); ${p.disc}">Disconnect</button>
                <button class="btn-secondary" onclick="App.closeModal()">Close</button>
            </div>
        `);
    },

    /* Which tracker currently powers Library / Continue Watching. */
    activeTrackerName() {
        const pref = Storage.getSettings().librarySource;
        const al = Storage.getAnilistConn();
        const mal = Storage.getMalConn();
        const simkl = Storage.getSimklConn();
        const alOk = !!(al && al.accessToken);
        const malOk = !!(mal && (mal.accessToken || mal.listsCache));
        const skOk = !!(simkl && simkl.accessToken);
        if (pref === 'AniList' && alOk) return 'AniList';
        if (pref === 'MyAnimeList' && malOk) return 'MyAnimeList';
        if (pref === 'Simkl' && skOk) return 'Simkl';
        if (alOk) return 'AniList';
        if (skOk) return 'Simkl';
        if (malOk) return 'MyAnimeList';
        return 'Local';
    },

    /* --- AniList connect (Tracking stage): the user's own API
       client + the PIN flow, so this local app needs no server.
       Full steps live in the modal; credentials stay on-device. --- */
    /* If GAnime is served over http(s) and AniList redirected
       back with the token in the URL hash, finish the login
       automatically — true zero-typing. On file:// the PIN-page
       paste flow below is used instead. */
    async handleOAuthCallback() {
        try {
            const hash = (window.location && window.location.hash) || '';
            if (!hash.includes('access_token=')) return;
            const params = new URLSearchParams(hash.slice(1));
            const token = params.get('access_token');
            if (window.history && window.history.replaceState) {
                window.history.replaceState(null, '', window.location.pathname + window.location.search);
            }
            if (!token) return;
            const user = await AniList.viewer(token);
            Storage.saveAnilistConn({
                clientId: (Config.OAUTH && Config.OAUTH.ANILIST_CLIENT_ID) || '',
                accessToken: token,
                expiresAt: Date.now() + 365 * 86400 * 1000,
                user
            });
            this.trackingLists = null; this.trackingListsAt = 0; this.trackingError = '';
            this.settingsPage = 'tracking';
            this._pendingOAuthLanding = true;
            this.fetchTrackingLists(true);
            /* Late landing: if the shell already launched (slow
               viewer fetch), go to Profile → Tracking now. */
            if (this.shellLaunched && this.currentScreen !== 'screen-profile') this.navigate('screen-profile');
            /* Boot race (2026-10-25 final, honest scope): the token is
               already stripped from the hash by replaceState above, so
               it cannot be wiped by syncHash. The only real race is
               the Settings page not re-rendering if boot already
               proceeded — re-render it if it is the current screen.
               Do NOT pre-mark the user signed-in before viewer() resolves. */
            if (this.shellLaunched && this.currentScreen === 'screen-profile' && typeof this.renderSettings === 'function') this.renderSettings();
        } catch (e) { /* a bad hash token just means: use the paste flow */ }
    },

    /* Connect AniList, one click: the client ID is baked into
       Config, so no form ever appears. On http(s) the browser
       goes to AniList and (if the client's redirect URL points
       back here) returns already logged in. On file:// the
       approval tab opens and a small paste box finishes it. */
    connectAnilistOneClick() {
        const cid = (Config.OAUTH && Config.OAUTH.ANILIST_CLIENT_ID) || (Storage.getAnilistConn() || {}).clientId || '';
        if (!cid) { this.openAnilistConnect(); return; }
        if (window.location.protocol !== 'file:') {
            window.location.href = AniList.authorizeUrl(cid);
            return;
        }
        window.open(AniList.authorizeUrl(cid), '_blank');
        this.openModal(`
            <h3 class="modal-title">Approve on AniList</h3>
            <p class="text-secondary">The AniList tab that just opened asks you to <b>Authorize</b> GAnime. It then shows a long <b>token</b> (starts with eyJ) — copy it and paste it here. If you see a web address instead, paste the whole address; GAnime finds the token inside.</p>
            <input id="alCode" class="app-input" placeholder="Paste the token from AniList" style="margin-top:10px">
            <div id="alError" class="form-error"></div>
            <button class="btn-primary" onclick="App.anilistFinishConnect()" style="margin-top:12px">Finish Login</button>
            <button class="btn-secondary" onclick="App.closeModal()">Cancel</button>
            <p class="text-secondary" style="margin-top:12px">The token lasts a year and never leaves this device except to AniList itself.</p>
        `);
    },

    openAnilistConnect() {
        const conn = Storage.getAnilistConn() || {};
        this.openModal(`
            <h3 class="modal-title">Connect AniList</h3>
            <p class="text-secondary">1 · On <b>anilist.co</b>: Settings → Developer → <b>Create Client</b>. Name it anything (e.g. GAnime) and paste this as the <b>Redirect URL</b>, exactly:</p>
            <p class="mono-box">${AniList.OAUTH_PIN_REDIRECT}</p>
            <p class="text-secondary">2 · Copy the <b>Client ID</b> AniList gives you (that's all we need — no Secret):</p>
            <input id="alClientId" class="app-input" placeholder="Client ID" value="${conn.clientId || ''}">
            <p class="text-secondary" style="margin-top:12px">3 · Approve on AniList — the page it lands on shows a long <b>token</b> (starts with eyJ). Copy it and paste it here. If you see a web address instead, paste the whole address — GAnime finds the token inside it:</p>
            <button class="btn-secondary" onclick="App.anilistOpenApproval()">Open AniList approval page</button>
            <input id="alCode" class="app-input" placeholder="Paste the token from AniList" style="margin-top:10px">
            <div id="alError" class="form-error"></div>
            <button class="btn-primary" onclick="App.anilistFinishConnect()" style="margin-top:12px">Connect</button>
            <button class="btn-secondary" onclick="App.closeModal()">Cancel</button>
            <p class="text-secondary" style="margin-top:12px">The token lasts a year and never leaves this device except to AniList itself.</p>
        `);
    },

    _alField(id) {
        const el = document.getElementById(id);
        return el ? el.value.trim() : '';
    },

    _alError(msg) {
        const el = document.getElementById('alError');
        if (el) el.textContent = msg;
    },

    anilistOpenApproval() {
        const clientId = this._alField('alClientId');
        if (!clientId) { this._alError('Enter your Client ID first (step 2).'); return; }
        const conn = Storage.getAnilistConn() || {};
        conn.clientId = clientId;
        Storage.saveAnilistConn(conn);
        this._alError('');
        window.open(AniList.authorizeUrl(clientId), '_blank');
    },

    async anilistFinishConnect() {
        const baked = (Config.OAUTH && Config.OAUTH.ANILIST_CLIENT_ID) || '';
        const field = document.getElementById('alClientId');
        const clientId = baked || (field ? field.value.trim() : '') || (Storage.getAnilistConn() || {}).clientId || '';
        const pasted = this._alField('alCode');
        if (!pasted) { this._alError('Paste the token AniList showed you.'); return; }
        this._alError('Connecting…');
        try {
            const { accessToken, user } = await AniList.verifyToken(pasted);
            Storage.saveAnilistConn({
                clientId,
                accessToken,
                expiresAt: Date.now() + 365 * 86400 * 1000,
                user
            });
            this.trackingLists = null; this.trackingListsAt = 0; this.trackingError = '';
            this.closeModal();
            if (this.settingsPage === 'tracking') this.renderSettings();
            this.fetchTrackingLists(true).then(() => {
                if (this.currentScreen === 'screen-home') this.renderContinueWatching();
                if (this.currentScreen === 'screen-library') this.renderLibrary();
            });
        } catch (e) {
            this._alError(e.message || 'Could not connect — check the token and try again.');
        }
    },

    anilistDisconnect() {
        const conn = Storage.getAnilistConn() || {};
        // Keep only the client ID for an easy reconnect.
        Storage.saveAnilistConn({ clientId: conn.clientId || '' });
        this.trackingLists = null; this.trackingListsAt = 0; this.trackingError = '';
        if (this.settingsPage === 'tracking') this.renderSettings();
    },

    /* ---------- Simkl (PIN flow — fully in-browser) ---------- */
    openSimklConnect() {
        const conn = Storage.getSimklConn() || {};
        this.openModal(`
            <h3 class="modal-title">Connect Simkl</h3>
            <p class="text-secondary">1 · On <b>simkl.com</b>: profile menu → Settings → Developer → <b>New App</b>. Name it GAnime and copy the <b>Client ID</b>:</p>
            <input id="skClientId" class="app-input" placeholder="Simkl Client ID" value="${(Config.OAUTH && Config.OAUTH.SIMKL_CLIENT_ID) || conn.clientId || ''}">
            <p class="text-secondary" style="margin-top:12px">2 · Get a PIN, then type it on the Simkl page that opens:</p>
            <button class="btn-secondary" onclick="App.simklGetPin()">Get Simkl PIN &amp; open approval page</button>
            <div id="skPinBox" style="display:none; margin-top:12px">
                <div class="device-code" id="skUserCode">-----</div>
                <p class="text-secondary" id="skPollStatus">Approve that code on Simkl — GAnime is listening and will finish by itself.</p>
            </div>
            <div id="skError" class="form-error"></div>
            <button class="btn-primary" onclick="App.simklFinishConnect()" style="margin-top:12px">Complete Connection</button>
            <button class="btn-secondary" onclick="App.simklCancelPoll()">Cancel</button>
        `);
    },

    _skError(msg) {
        const el = document.getElementById('skError');
        if (el) el.textContent = msg;
    },

    async simklGetPin() {
        const clientId = this._alField('skClientId');
        if (!clientId) { this._skError('Paste your Simkl Client ID first.'); return; }
        this._skError('Requesting PIN…');
        try {
            const pin = await Trackers.simklStartPin(clientId);
            this._simklPin = { clientId, userCode: pin.user_code };
            Storage.saveSimklConn({ clientId });
            const box = document.getElementById('skPinBox');
            const codeEl = document.getElementById('skUserCode');
            if (box) box.style.display = 'block';
            if (codeEl) codeEl.textContent = pin.user_code;
            this._skError('');
            window.open(pin.verification_url || 'https://simkl.com/pin/', '_blank');
            this.simklStartAutoPoll(clientId, pin.user_code, pin.interval);
        } catch (e) {
            this._skError(e.message || 'Could not get a Simkl PIN.');
        }
    },

    /* After the PIN is shown, poll Simkl until he approves —
       no "Complete Connection" click needed (it stays as a
       manual fallback). Polling stops on success, on Cancel,
       or after ~10 minutes. */
    simklStartAutoPoll(clientId, userCode, intervalSec) {
        this.simklStopAutoPoll();
        let checks = 0;
        const delay = this._skPollMs || Math.max(3, intervalSec || 5) * 1000;
        this._skPollTimer = setInterval(async () => {
            checks++;
            const status = document.getElementById('skPollStatus');
            if (status) status.textContent = 'Waiting for your approval on Simkl… (check ' + checks + ')';
            if (checks > 120) { this.simklStopAutoPoll(); return; }
            try {
                const token = await Trackers.simklCheckPin(clientId, userCode);
                if (!token) return;
                this.simklStopAutoPoll();
                const user = await Trackers.simklViewer(clientId, token);
                Storage.saveSimklConn({ clientId, accessToken: token, user });
                this.trackingLists = null; this.trackingListsAt = 0; this.trackingError = '';
                this.closeModal();
                if (this.settingsPage === 'tracking') this.renderSettings();
                this.fetchTrackingLists(true).then(() => {
                    if (this.currentScreen === 'screen-home') this.renderContinueWatching();
                    if (this.currentScreen === 'screen-library') this.renderLibrary();
                });
            } catch (e) { /* keep listening */ }
        }, delay);
    },

    simklStopAutoPoll() {
        if (this._skPollTimer) { clearInterval(this._skPollTimer); this._skPollTimer = null; }
    },

    simklCancelPoll() {
        this.simklStopAutoPoll();
        this.closeModal();
    },

    async simklFinishConnect() {
        const clientId = this._alField('skClientId') || (this._simklPin && this._simklPin.clientId);
        const userCode = this._simklPin && this._simklPin.userCode;
        if (!clientId || !userCode) { this._skError('Click "Get Simkl PIN" first.'); return; }
        this._skError('Checking approval with Simkl…');
        try {
            const token = await Trackers.simklCheckPin(clientId, userCode);
            if (!token) { this._skError('Not approved yet — approve the PIN on Simkl, then click Complete Connection again.'); return; }
            const user = await Trackers.simklViewer(clientId, token);
            Storage.saveSimklConn({ clientId, accessToken: token, user });
            this.trackingLists = null; this.trackingListsAt = 0; this.trackingError = '';
            this.closeModal();
            if (this.settingsPage === 'tracking') this.renderSettings();
            this.fetchTrackingLists(true).then(() => {
                if (this.currentScreen === 'screen-home') this.renderContinueWatching();
                if (this.currentScreen === 'screen-library') this.renderLibrary();
            });
        } catch (e) {
            this._skError(e.message || 'Simkl connection failed.');
        }
    },

    simklDisconnect() {
        const conn = Storage.getSimklConn() || {};
        Storage.saveSimklConn({ clientId: conn.clientId || '' });
        this.trackingLists = null; this.trackingListsAt = 0;
        if (this.settingsPage === 'tracking') this.renderSettings();
    },

    /* ---------- MyAnimeList (public-list sync via terminal) ---------- */
    openMalConnect() {
        const conn = Storage.getMalConn() || {};
        this.openModal(`
            <h3 class="modal-title">Connect MyAnimeList</h3>
            <p class="text-secondary">MAL's API doesn't answer browsers, so GAnime fetches your <b>public</b> list with one terminal command, then dresses it in AniList artwork. You need a free MAL Client ID: <b>myanimelist.net/apiconfig</b> → Create ID (any name; your list must be public).</p>
            <input id="malUser" class="app-input" placeholder="Your MAL username" value="${conn.user ? this.esc(conn.user.name) : ''}">
            <input id="malClientId" class="app-input" placeholder="MAL Client ID" value="${conn.clientId || ''}" style="margin-top:8px" oninput="App.malUpdateCmd()">
            <div id="malCmdWrap" style="display:none; margin-top:10px">
                <p class="text-secondary">Run this in a terminal:</p>
                <p class="mono-box" id="malCmdText"></p>
                <p class="text-secondary">Paste its output (one JSON line) here:</p>
                <textarea id="malJsonPaste" class="app-input" rows="3" placeholder='{"data":[...]}'></textarea>
            </div>
            <div id="malError" class="form-error"></div>
            <button class="btn-primary" onclick="App.malFinishConnect()" style="margin-top:12px">Connect &amp; Sync MAL</button>
            <button class="btn-secondary" onclick="App.closeModal()">Cancel</button>
        `);
        if (conn.clientId) setTimeout(() => this.malUpdateCmd(), 0);
    },

    malUpdateCmd() {
        const user = this._alField('malUser');
        const cid = String(this._alField('malClientId') || '').replace(/[^a-zA-Z0-9_-]/g, '');
        const wrap = document.getElementById('malCmdWrap');
        const cmd = document.getElementById('malCmdText');
        if (!wrap || !cmd) return;
        if (!cid || !user) { wrap.style.display = 'none'; return; }
        wrap.style.display = 'block';
        cmd.textContent = 'curl -s "https://api.myanimelist.net/v2/users/' + encodeURIComponent(user) + '/animelist?limit=1000&fields=list_status,num_episodes,mean,start_season" -H "X-MAL-CLIENT-ID: ' + cid + '"';
    },

    async malFinishConnect() {
        const err = msg => { const el = document.getElementById('malError'); if (el) el.textContent = msg; };
        const username = this._alField('malUser');
        const clientId = this._alField('malClientId');
        const raw = this._alField('malJsonPaste');
        if (!username || !clientId) { err('Enter your MAL username and Client ID.'); return; }
        if (!raw) { this.malUpdateCmd(); err('Run the terminal command and paste its JSON output first.'); return; }
        err('Dressing your MAL list in AniList artwork…');
        try {
            const start = raw.indexOf('{');
            const end = raw.lastIndexOf('}');
            const parsed = JSON.parse(raw.slice(start, end + 1));
            const items = (parsed && parsed.data) || [];
            if (!Array.isArray(items)) throw new Error('That JSON has no data list — copy the terminal output whole.');
            const listsCache = await Trackers.malParseListJson(items);
            Storage.saveMalConn({ clientId, user: { id: username, name: username, avatar: '' }, listsCache });
            this.trackingLists = null; this.trackingListsAt = 0; this.trackingError = '';
            this.closeModal();
            if (this.settingsPage === 'tracking') this.renderSettings();
            this.fetchTrackingLists(true).then(() => {
                if (this.currentScreen === 'screen-home') this.renderContinueWatching();
                if (this.currentScreen === 'screen-library') this.renderLibrary();
            });
        } catch (e) {
            err(e.message || 'Could not read that MAL JSON.');
        }
    },

    malDisconnect() {
        const conn = Storage.getMalConn() || {};
        Storage.saveMalConn({ clientId: conn.clientId || '' });
        this.trackingLists = null; this.trackingListsAt = 0;
        if (this.settingsPage === 'tracking') this.renderSettings();
    },

    /* The stored implicit-grant token (1-year life; AniList
       has no refresh tokens — expiry means reconnecting). */
    async anilistAccessToken() {
        const conn = Storage.getAnilistConn();
        if (!conn || !conn.accessToken) return null;
        if (conn.expiresAt && Date.now() > conn.expiresAt) return null;
        return conn.accessToken;
    },

    /* The user's AniList lists, cached for a minute. */
    trackingLists: null,
    trackingListsProvider: null,
    trackingListsAt: 0,
    trackingError: '',
    trackingFetch: null,
    libraryFilter: 'ALL',
    librarySort: 'UPDATED_DESC',
    LIBRARY_SORTS: [
        ['UPDATED_DESC', 'Last Updated'],
        ['COMPLETED_DESC', 'Recently Finished'],
        ['ADDED_DESC', 'Last Added'],
        ['PROGRESS_DESC', 'Progress'],
        ['SCORE_DESC', 'Your Score'],
        ['AVG_SCORE_DESC', 'Average Score'],
        ['TITLE_ASC', 'Title (A-Z)'],
        ['YEAR_DESC', 'Release Year']
    ],

    async fetchTrackingLists(force) {
        const active = this.activeTrackerName();
        if (active === 'Local') return null;
        if (!force && this.trackingLists && this.trackingListsProvider === active && Date.now() - this.trackingListsAt < 60000) return this.trackingLists;
        if (this.trackingFetch) return this.trackingFetch;
        this.trackingFetch = (async () => {
            try {
                let lists = null;
                if (active === 'AniList') {
                    const token = await this.anilistAccessToken();
                    const fresh = Storage.getAnilistConn();
                    if (token && fresh && fresh.user) lists = await AniList.myLists(token, fresh.user.id);
                    else if (fresh && fresh.accessToken) this.trackingError = 'AniList session expired — reconnect in Settings → Tracking.';
                } else if (active === 'Simkl') {
                    const sk = Storage.getSimklConn();
                    if (sk && sk.accessToken) lists = await Trackers.simklLists(sk.clientId, sk.accessToken);
                } else if (active === 'MyAnimeList') {
                    const mal = Storage.getMalConn();
                    if (mal && mal.listsCache) lists = mal.listsCache;
                }
                if (lists) {
                    Object.values(lists).forEach(g => (g.entries || []).forEach(e => this.cacheTitles([e.media])));
                    this.trackingLists = lists;
                    this.trackingListsProvider = active;
                    this.trackingListsAt = Date.now();
                    this.trackingError = '';
                }
                return lists;
            } catch (e) {
                this.trackingError = (e && e.message) || ('Could not load your ' + active + ' lists.');
                return null;
            } finally {
                this.trackingFetch = null;
            }
        })();
        return this.trackingFetch;
    },

    /* Push local watched progress up to AniList (fire-and-forget;
       the local save stays the on-device truth). */
    async pushAnilistProgress(t) {
        if (!t) return;
        const eps = (Storage.getWatched()[t.id] || {}).eps || [];
        const progress = eps.length ? Math.max.apply(null, eps) : 0;
        const status = (t.eps && progress >= t.eps) ? 'COMPLETED' : 'CURRENT';
        const al = Storage.getAnilistConn();
        if (al && al.accessToken && t.anilistId) {
            try {
                const token = await this.anilistAccessToken();
                if (token) await AniList.saveProgress(token, t.anilistId, progress, status);
            } catch (e) { /* the local save is the truth; retried next mark */ }
        }
        const sk = Storage.getSimklConn();
        if (sk && sk.accessToken && progress > 0) {
            try { await Trackers.simklSaveProgress(sk.clientId, sk.accessToken, t, progress); } catch (e) { /* same */ }
        }
        this.trackingListsAt = 0;
    },

    /* ---------- Library (Tracking stage) ---------- */
    sortLibraryEntries(entries) {
        const mode = this.librarySort || 'UPDATED_DESC';
        return entries.slice().sort((a, b) => {
            switch (mode) {
                case 'COMPLETED_DESC': return (b.completedAt - a.completedAt) || (b.updatedAt - a.updatedAt);
                case 'ADDED_DESC': return (b.createdAt - a.createdAt) || (b.entryId - a.entryId);
                case 'PROGRESS_DESC': return (b.progress - a.progress) || (b.updatedAt - a.updatedAt);
                case 'SCORE_DESC': return (b.score - a.score) || ((b.media.scorePct || 0) - (a.media.scorePct || 0));
                case 'AVG_SCORE_DESC': return (b.media.scorePct || 0) - (a.media.scorePct || 0);
                case 'YEAR_DESC': return (parseInt(b.media.year, 10) || 0) - (parseInt(a.media.year, 10) || 0);
                case 'TITLE_ASC': return (a.media.title || '').localeCompare(b.media.title || '');
                case 'UPDATED_DESC':
                default: return (b.updatedAt - a.updatedAt) || (b.entryId - a.entryId);
            }
        });
    },

    setLibrarySort(value) {
        this.librarySort = value;
        this.librarySortMenuOpen = false;
        this.renderLibrary();
    },

    toggleLibrarySortMenu() {
        this.librarySortMenuOpen = !this.librarySortMenuOpen;
        this.renderLibrary();
    },

    /* Three-bar sort icon, used only on the sort button in the
       source row (the status button now shows the status icon). */
    sortIconSVG() {
        return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="15" y2="12"/><line x1="4" y1="18" x2="10" y2="18"/><path d="M17 4l3 3-3 3" fill="none"/></svg>`;
    },

    /* Per-status icons, AniList-sheet style (outline, currentColor):
       the floating button shows the CURRENT status's icon, and every
       status row/pill shows its own — so switching shows the
       respective logo. The sort icon stays only on the sort button. */
    statusIconSVG(key) {
        const open = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
        const icons = {
            ALL: `${open}<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>`,
            Watching: `${open}<circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/></svg>`,
            Completed: `${open}<circle cx="12" cy="12" r="10"/><path d="M8 12.5l2.5 2.5L16 9.5"/></svg>`,
            'Plan to Watch': `${open}<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
            'On Hold': `${open}<circle cx="12" cy="12" r="10"/><line x1="10" y1="8" x2="10" y2="16"/><line x1="14" y1="8" x2="14" y2="16"/></svg>`,
            Dropped: `${open}<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>`,
            Rewatching: `${open}<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
        };
        return icons[key] || icons.ALL;
    },

    librarySourceTab: 'Local',
    localLibFilter: 'ALL',
    librarySortMenuOpen: false,
    localLibFabOpen: false,

    setLibrarySource(src) {
        this.librarySourceTab = src;
        if (src !== 'Local') {
            /* Same partial-overwrite bug as setCwSource — fixed
               the same way (merge one key, keep everything else). */
            Storage.updateSetting('librarySource', src);
            if (this.trackingListsProvider !== src) { this.trackingLists = null; this.trackingListsAt = 0; }
        }
        this.renderLibrary();
    },

    setLocalLibFilter(key) {
        this.localLibFilter = key;
        this.localLibFabOpen = false;
        this.renderLibrary();
    },

    toggleLocalLibFab() {
        this.localLibFabOpen = !this.localLibFabOpen;
        this.renderLibrary();
    },

    /* The Local source (Fix 2/4c): statuses from Add to Library
       + the saved-episodes section. Bookmark is gone — saved
       episodes live here, inside Local. */
    libraryLocalHTML() {
        const lib = Storage.getLocalLibrary();
        const statuses = ['Watching', 'Completed', 'Plan to Watch', 'On Hold', 'Dropped', 'Rewatching'];
        const ids = Object.keys(lib);
        const counts = {};
        statuses.forEach(s => { counts[s] = ids.filter(id => lib[id].status === s).length; });
        const filter = this.localLibFilter || 'Watching';
        const chips = ['ALL'].concat(statuses).map(k => {
            const label = k === 'ALL' ? 'All' : k;
            const count = k === 'ALL' ? ids.filter(id => lib[id].status).length : counts[k];
            return `<button class="ftab ${filter === k ? 'active' : ''}" onclick="App.setLocalLibFilter('${k}')">${this.statusIconSVG(k)}${label} · ${count}</button>`;
        }).join('');
        const watchedMap = Storage.getWatched();
        const entryTitle = id => {
            const meta = (lib[id] && lib[id].meta) || {};
            const t = { id, title: meta.title || 'Unknown title', poster: meta.poster || '', cover: meta.cover || '', hue: meta.hue || 210, year: meta.year || '', type: meta.type || 'TV', eps: meta.total || 0, score: '—', anilistId: meta.anilistId || null };
            this.cacheTitles([t]);
            return t;
        };
        const shown = ids.filter(id => lib[id].status && (filter === 'ALL' || lib[id].status === filter));
        /* Local sort (2026-10-27 fix): the sort button used to do
           nothing here — only tracker lists were sorted. Mirror
           sortLibraryEntries with local fields (updatedAt exists on
           every entry; addedAt/completedAt/score do not, so Added
           falls back to updatedAt, Completed puts finished titles
           first, and score sorts keep order when no score exists). */
        const sortMode = this.librarySort || 'UPDATED_DESC';
        const localSort = (a, b) => {
            const ea = lib[a], eb = lib[b];
            const ma = ea.meta || {}, mb = eb.meta || {};
            const seenA = ((watchedMap[a] || {}).eps || []).length, seenB = ((watchedMap[b] || {}).eps || []).length;
            const progA = ma.total ? seenA / ma.total : 0, progB = mb.total ? seenB / mb.total : 0;
            switch (sortMode) {
                case 'COMPLETED_DESC': {
                    const ca = ea.status === 'Completed' ? 1 : 0, cb = eb.status === 'Completed' ? 1 : 0;
                    return (cb - ca) || ((eb.updatedAt || 0) - (ea.updatedAt || 0));
                }
                case 'ADDED_DESC': return (eb.updatedAt || 0) - (ea.updatedAt || 0);
                case 'PROGRESS_DESC': return (progB - progA) || ((eb.updatedAt || 0) - (ea.updatedAt || 0));
                case 'SCORE_DESC':
                case 'AVG_SCORE_DESC': return (parseFloat(mb.scorePct) || parseFloat(mb.score) || 0) - (parseFloat(ma.scorePct) || parseFloat(ma.score) || 0);
                case 'YEAR_DESC': return (parseInt(mb.year, 10) || 0) - (parseInt(ma.year, 10) || 0);
                case 'TITLE_ASC': return (ma.title || '').localeCompare(mb.title || '');
                case 'UPDATED_DESC':
                default: return (eb.updatedAt || 0) - (ea.updatedAt || 0);
            }
        };
        shown.sort(localSort);
        const cards = shown.map(id => {
            const t = entryTitle(id);
            const total = t.eps || 0;
            const seen = ((watchedMap[id] || {}).eps || []).length;
            const pct = total ? Math.min(100, Math.round((seen / total) * 100)) : 0;
            const badge = `<span class="lib-ep-badge">${total ? seen + '/' + total : seen}</span>`;
            return `<div class="lib-item">${this.posterCardHTML(t, badge)}<div class="lib-prog"><div class="wavy-track"><div class="wavy-fill" style="width:${pct}%"></div></div></div></div>`;
        }).join('');
        const savedIds = ids.filter(id => (lib[id].savedEps || []).length);
        const savedHTML = savedIds.length ? `
            <div class="section-head" style="margin-top:22px">SAVED EPISODES</div>
            <div class="search-grid">${savedIds.map(id => {
                const t = entryTitle(id);
                return `<div class="lib-item">${this.posterCardHTML(t)}<div class="lib-prog"><span>${lib[id].savedEps.slice().sort((a, b) => a - b).map(n => 'EP ' + n).join(' · ')}</span></div></div>`;
            }).join('')}</div>` : '';
        const fabMinis = ['ALL'].concat(statuses).map(k => {
            const label = k === 'ALL' ? 'All' : k;
            const count = k === 'ALL' ? ids.filter(id => lib[id].status).length : counts[k];
            return `<button class="lib-fab-mini ${filter === k ? 'on' : ''}" onclick="App.setLocalLibFilter('${k}')">${this.statusIconSVG(k)}${label} · ${count}</button>`;
        }).join('');
        const fabLabel = filter === 'ALL' ? 'All' : filter;
        const fabHTML = `<div class="lib-fab-wrap"><div class="lib-fab-stack ${this.localLibFabOpen ? 'open' : ''}">${fabMinis}</div><button class="lib-fab" onclick="App.toggleLocalLibFab()">${this.statusIconSVG(filter)} ${fabLabel}</button></div>`;
        return `
            <div class="stream-tabs lib-status-row" style="margin-bottom:14px">${chips}</div>
            ${cards ? `<div class="search-grid">${cards}</div>` : `<p class="text-secondary">${filter === 'ALL' ? 'Nothing in your Local library yet — Add to Library on any title puts it here.' : 'No titles with this status yet.'}</p>`}
            ${savedHTML}
            ${fabHTML}`;
    },

    renderLibrary() {
        const controls = document.getElementById('libraryControls');
        const grid = document.getElementById('libraryGrid');
        if (!controls || !grid) return;
        const source = this.librarySourceTab || 'Local';
        const auth = Storage.getAuthState();
        const localLabel = auth && auth.signedIn ? 'Cloud' : 'Local';
        const srcBtn = (key, label) => `<button class="ftab ${source === key ? 'active' : ''}" onclick="App.setLibrarySource('${key}')">${label}</button>`;
        const sortMenu = this.librarySortMenuOpen ? `<div class="lib-sort-menu">${this.LIBRARY_SORTS.map(p => `<button class="lib-sort-row ${this.librarySort === p[0] ? 'on' : ''}" onclick="App.setLibrarySort('${p[0]}')">${p[1]}</button>`).join('')}</div>` : '';
        const headerHTML = `
            <div class="lib-head"><h2 class="screen-title">Library</h2></div>
            <div class="stream-tabs lib-sources">${srcBtn('Local', localLabel)}${srcBtn('AniList', 'AniList')}${srcBtn('MyAnimeList', 'MAL')}${srcBtn('Simkl', 'Simkl')}<button class="lib-sort-icon" onclick="App.toggleLibrarySortMenu()" title="Sort">${this.sortIconSVG()}</button></div>${sortMenu}`;
        if (source === 'Local') {
            controls.innerHTML = headerHTML;
            grid.innerHTML = this.libraryLocalHTML();
            return;
        }
        const active = this.activeTrackerName();
        const conn = active === 'AniList' ? Storage.getAnilistConn()
            : active === 'Simkl' ? Storage.getSimklConn()
            : active === 'MyAnimeList' ? Storage.getMalConn() : null;
        if (active !== source || !conn) {
            const opener = source === 'AniList' ? 'App.connectAnilistOneClick()' : source === 'Simkl' ? 'App.openSimklConnect()' : 'App.openMalConnect()';
            controls.innerHTML = headerHTML;
            grid.innerHTML = `
                <div class="provider-card">
                    <div class="provider-brand">${source === 'MyAnimeList' ? 'MyAnimeList' : source} is not connected</div>
                    <button class="btn-white" onclick="${opener}">Connect ${source === 'MyAnimeList' ? 'MAL' : source}</button>
                </div>`;
            return;
        }
        const chips = [{ key: 'ALL', label: 'All' }].concat(AniList.LIST_STATUSES).map(s => {
            const count = s.key === 'ALL'
                ? Object.values(this.trackingLists || {}).reduce((n, g) => n + (g.entries || []).length, 0)
                : ((this.trackingLists || {})[s.key] || {}).entries?.length || 0;
            return `<button class="ftab ${this.libraryFilter === s.key ? 'active' : ''}" onclick="App.setLibraryFilter('${s.key}')">${s.label}${this.trackingLists ? ' · ' + count : ''}</button>`;
        }).join('');
        controls.innerHTML = headerHTML + `
            <p class="text-secondary" style="margin-bottom:12px">${active} · @${this.esc(conn.user ? conn.user.name : '')}</p>
            <div class="stream-tabs" style="align-items:center">${chips}</div>`;
        if (this.trackingError) {
            grid.innerHTML = `<p class="text-secondary">${this.esc(this.trackingError)}</p><button class="btn-secondary" onclick="App.retryLibrary()">Retry</button>`;
            return;
        }
        if (!this.trackingLists) {
            grid.innerHTML = '<div class="search-grid">' + Array.from({ length: 12 }, () => '<div class="skl-card"></div>').join('') + '</div>';
            this.fetchTrackingLists().then(() => { if (this.currentScreen === 'screen-library') this.renderLibrary(); });
            return;
        }
        const groups = this.libraryFilter === 'ALL'
            ? AniList.LIST_STATUSES.map(s => (this.trackingLists[s.key] || {}).entries || [])
            : [((this.trackingLists[this.libraryFilter] || {}).entries || [])];
        const entries = this.sortLibraryEntries([].concat.apply([], groups));
        if (!entries.length) {
            grid.innerHTML = '<p class="text-secondary">This list is empty on ' + this.esc(active) + '.</p>';
            return;
        }
        grid.innerHTML = `<div class="search-grid">${entries.map(e => this.libraryCardHTML(e)).join('')}</div>`;
    },

    libraryCardHTML(e) {
        const t = e.media;
        const total = t.eps || 0;
        const pct = total ? Math.min(100, Math.round((e.progress / total) * 100)) : 0;
        return `<div class="lib-item">
            ${this.posterCardHTML(t)}
            <div class="lib-prog"><div class="wavy-track"><div class="wavy-fill" style="width:${pct}%"></div></div>
            <span>${e.progress}${total ? ' / ' + total : ''} eps</span></div>
        </div>`;
    },

    setLibraryFilter(key) {
        this.libraryFilter = key;
        if (key === 'COMPLETED' && this.librarySort === 'UPDATED_DESC') this.librarySort = 'COMPLETED_DESC';
        this.renderLibrary();
    },

    retryLibrary() {
        this.trackingLists = null;
        this.trackingError = '';
        this.trackingListsAt = 0;
        this.renderLibrary();
    },

    /* --- General tab --- */
    pageLayout() {
        const s = Storage.getSettings();
        const themes = Config.ACCENT_PRESETS.map(p => `
            <button class="theme-choice ${s.accentId === p.id ? 'active' : ''}" onclick="App.setAccent('${p.id}')">
                <span class="theme-dot" style="background:${p.color}">${s.accentId === p.id ? '✓' : ''}</span>
                <span class="theme-name">${this.esc(p.name)}</span>
                <span class="theme-bar" style="background:${p.color}"></span>
            </button>
        `).join('');
        return `
            ${this.backHeader('Layout')}
            <div class="section-label">THEME</div>
            <div class="settings-group"><div class="theme-grid">${themes}</div></div>
            <div class="section-label">DISPLAY</div>
            <div class="settings-group">
                ${this.sToggle('amoledBlack', 'AMOLED Black', 'Use pure black backgrounds for OLED screens.')}
                ${this.sSelect('navBarPosition', 'Navigation Bar Position', ['bottom', 'top'])}
                ${this.sToggle('liquidGlassTab', 'Liquid Glass Tab Bar', 'Glass effect on the floating navigation bar')}
            </div>
            <div class="section-label">HOME & DETAILS</div>
            <div class="settings-group">
                ${this.sSelect('heroStyle', 'Hero Style', ['full_bleed', 'card'])}
                ${this.sToggle('heroTrailerAutoplay', 'Hero Trailer Autoplay', 'Play trailers automatically in the hero carousel')}
                ${this.sToggle('heroTrailerSound', 'Hero Trailer Sound')}
                ${this.sSelect('heroTrailerDelay', 'Hero Trailer Delay', ['Instant', '3s', '5s', '10s'])}
                ${this.sToggle('dynamicBackgroundColor', 'Dynamic Background Colour', 'Tint the screen from the focused title artwork')}
                ${this.sToggle('catalogAccentUnderline', 'Catalog Accent Underline', 'Accent underline beneath the focused catalog title')}
                ${this.sToggle('detailBudgetRevenue', 'Budget & Revenue on Details')}
                ${this.sToggle('detailIconActionRow', 'Icon Action Row on Details')}
                ${this.sRow('Home Layout', 'Adjust home layout, content visibility, and poster behavior', "App.openComingSoon('Home Layout')")}
                ${this.sRow('Collections', 'Create custom catalog groupings with folders shown on Home.', "App.openComingSoon('Collections')")}
                ${this.sRow('Continue Watching', 'Settings for the Continue Watching section.', "App.openComingSoon('Continue Watching')")}
                ${this.sRow('Poster Card Style', 'Tune card width and corner radius.', "App.openComingSoon('Poster Card Style')")}
            </div>
            <div class="section-label">STREAMS</div>
            <div class="settings-group">
                ${this.sRow('Streams', 'Stream result display and badge URL rules.', "App.openComingSoon('Streams')")}
            </div>
            <div class="section-label">DETAIL PAGE</div>
            <div class="settings-group">
                ${this.sRow('Detail Page', 'Settings for the detail and episode screens.', "App.openComingSoon('Detail Page')")}
            </div>`;
    },

    pagePlayback() {
        const langs = ['Device language', 'English', 'Japanese', 'Hindi'];
        const subLangs = ['None', 'English', 'Japanese', 'Hindi'];
        return `
            ${this.backHeader('Playback')}
            <div class="section-label">PLAYER</div>
            <div class="settings-group">
                ${this.sToggle('autoFullscreen', 'Auto Fullscreen on Play', 'Enter fullscreen the moment a stream starts — tap ⛶ or press F to leave it.')}
                ${this.sToggle('swipeToSeek', 'Swipe to Seek', 'Horizontal swipe scrubs, with haptic ticks')}
                ${this.sToggle('privateViewing', 'Private Viewing', 'Keep this session out of history and tracking')}
                ${this.sSlider('seekInterval', 'Seek Interval', 5, 30, 's')}
            </div>
            <div class="section-label">ANIME SKIPPING</div>
            <div class="settings-group">
                ${this.sRow('AniSkip Service', '', "App.openSettingsPage('aniskip')")}
            </div>
            <div class="section-label">SUBTITLE AND AUDIO</div>
            <div class="settings-group">
                ${this.sSelect('preferredAudioLanguage', 'Preferred Audio Language', langs)}
                ${this.sSelect('secondaryAudioLanguage', 'Secondary Audio Language', subLangs)}
                ${this.sSelect('preferredSubtitleLanguage', 'Preferred Subtitle Language', subLangs)}
                ${this.sToggle('preferredLanguagesOnly', 'Show Only Preferred Languages', 'Only show subtitles matching your preferred subtitle languages.')}
            </div>
            <div class="section-label">SUBTITLE RENDERING</div>
            <div class="settings-group">
                ${this.sSlider('subtitleSize', 'Subtitle Size', 10, 30, 'sp')}
                ${this.sSlider('subtitleBgTransparency', 'Subtitle Background Tint', 0, 100, '%')}
            </div>`;
    },

    /* Integrations (TMDB / MDBList / Connected Services) are a
       FUTURE settings round (his call, 2026-10-24) — the pages
       were removed with the MORE row, not just hidden. */

    /* AniSkip Service page (2026-10-24): every anime-skipping
       option. AniSkip's API returns community-voted intervals
       keyed by MAL ID + episode: op / mixed-op (opening),
       ed / mixed-ed (ending), recap. The player honours these
       toggles — button vs auto-skip per type. */
    pageAniskip() {
        return `
            ${this.backHeader('AniSkip Service')}
            <div class="settings-group">
                ${this.sInfo('Service', 'api.aniskip.com')}
                ${this.sToggle('aniskipEnabled', 'Enable AniSkip', 'Fetch community skip intervals for episodes.')}
                ${this.sToggle('aniskipAutoOp', 'Auto-skip Opening', 'Jump past the opening automatically instead of showing the button.')}
                ${this.sToggle('aniskipAutoEd', 'Auto-skip Ending', 'Jump past the ending automatically instead of showing the button.')}
                ${this.sToggle('aniskipAutoRecap', 'Auto-skip Recap', 'Jump past the previous-episode recap automatically.')}
                ${this.sToggle('aniskipRecap', 'Detect Recaps', 'Include recap intervals at all — off means recaps are never offered.')}
                ${this.sToggle('aniskipShowButton', 'Show Skip Button', 'When auto-skip is off for a type, show its Skip button inside the interval.')}
            </div>`;
    },

    openComingSoon(name) {
        this.openModal(`
            <h3 class="modal-title">${name}</h3>
            <p class="text-secondary">This page is mapped and arrives in a later settings round — the row is exactly where the real app keeps it.</p>
            <button class="btn-secondary" onclick="App.closeModal()">Close</button>
        `);
    },

    connectProvider(name) {
        if (name === 'AniList') { this.connectAnilistOneClick(); return; }
        if (name === 'Simkl') { this.openSimklConnect(); return; }
        if (name === 'MyAnimeList') { this.openMalConnect(); return; }
    },

    /* ---------- Addons manager (real app blueprint) ---------- */
    /* One-time-per-session detection of the Configure flag for
       addons installed before the flag was stored: re-reads the
       manifest in the background and re-renders once it lands.
       Refresh does the same thing manually. */
    detectAddonConfig(addons) {
        if (!this._configDetectTried) this._configDetectTried = new Set();
        addons.forEach(a => {
            if (a.configurable !== undefined || this._configDetectTried.has(a.uid)) return;
            this._configDetectTried.add(a.uid);
            Addons.fetchManifest(a.manifestUrl).then(fresh => {
                const list = Storage.getAddons();
                const idx = list.findIndex(x => x.uid === a.uid);
                if (idx >= 0) {
                    list[idx].configurable = fresh.configurable;
                    Storage.saveAddons(list);
                    if (this.settingsPage === 'addons') this.renderSettings();
                }
            }).catch(() => { /* stays unknown until next visit / Refresh */ });
        });
    },

    openAddonConfigure(index) {
        const a = (Storage.getAddons() || [])[index];
        if (!a) return;
        /* Stremio convention: the configure page lives at the
           addon's base URL + /configure. */
        const url = (a.baseUrl || Addons.baseOf(a.manifestUrl)) + '/configure';
        window.open(url, '_blank', 'noopener');
    },

    pageAddons() {
        const addons = Storage.getAddons();
        this.detectAddonConfig(addons);
        const ownerId = Storage.getAddonOwnerId();
        const sharing = ownerId !== Storage.getActiveProfileId();
        /* Monochrome trash icon (2026-10-27): the dustbin is an
           outline SVG in currentColor — never a coloured emoji. */
        const trashIco = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
        const rows = addons.length ? addons.map((a, i) => `
            <div class="addon-card">
                <div class="addon-top">
                    <div class="addon-logo">${(a.logo && /^https?:\/\//i.test(a.logo)) ? `<img src="${this.esc(a.logo)}" alt="">` : `<span>${this.esc(a.name.charAt(0))}</span>`}</div>
                    <div class="addon-name">${this.esc(a.name)} ${a.version ? `<span class="version-chip">v${this.esc(a.version)}</span>` : ''}</div>
                    <label class="switch" title="${a.enabled ? 'Enabled' : 'Disabled'}">
                        <input type="checkbox" ${a.enabled ? 'checked' : ''} onchange="App.setAddonEnabled(${i}, this.checked, this)">
                        <span class="switch-track"></span>
                    </label>
                </div>
                <div class="addon-acts">
                    <button class="addon-icobtn" title="Move up" ${i === 0 ? 'disabled' : ''} onclick="App.moveAddon(${i},-1)">↑</button>
                    <button class="addon-icobtn" title="Move down" ${i === addons.length - 1 ? 'disabled' : ''} onclick="App.moveAddon(${i},1)">↓</button>
                    <button class="addon-icobtn" title="Refresh" onclick="App.refreshAddon(${i})">↻</button>
                    ${a.configurable ? `<button class="addon-icobtn" title="Configure" onclick="App.openAddonConfigure(${i})">⚙</button>` : ''}
                    <button class="addon-icobtn" title="Remove" onclick="App.removeAddon(${i})">${trashIco}</button>
                </div>
                <div class="addon-pills">
                    <span class="addon-pill">${a.enabled ? 'Active' : 'Disabled'}</span>
                    ${(a.resources || []).map(r => `<span class="addon-pill">${this.esc(r)}</span>`).join('')}
                </div>
                ${a.description ? `<div class="addon-desc">${this.esc(a.description)}</div>` : ''}
                <div class="addon-url">${this.esc(this.maskAddonUrl(a.manifestUrl))}</div>
            </div>`).join('')
            : '';
        return `
            ${this.backHeader('Addons')}
            ${sharing ? '<p class="text-secondary" style="margin-bottom:12px">This profile uses the <b>primary profile\u2019s addons</b> — changes here edit that shared list.</p>' : ''}
            <div class="section-label" style="font-size:16px;font-weight:800">INSTALL ADDON</div>
            <div class="settings-group">
                <div class="addon-add-form">
                    <input type="text" id="addonUrlInput" class="app-input" placeholder="https://example.com/manifest.json">
                    <button class="btn-primary" onclick="App.installAddon()">Add Addon</button>
                </div>
                <div id="addonStatus" class="setting-desc" style="margin-top:8px"></div>
            </div>
            <div class="section-label">INSTALLED ADDONS — ${addons.length}</div>
            <div class="addon-list">${rows}</div>`;
    },

    addonStatus(msg) {
        const el = document.getElementById('addonStatus');
        if (el) el.textContent = msg;
    },

    async installAddon() {
        const input = document.getElementById('addonUrlInput');
        const url = input ? input.value : '';
        if (!url.trim()) { this.addonStatus('Paste an addon manifest URL first.'); return; }
        this.addonStatus('Fetching manifest…');
        try {
            const record = await Addons.fetchManifest(url);
            const addons = Storage.getAddons();
            if (addons.some(a => a.manifestUrl === record.manifestUrl)) {
                this.addonStatus(record.name + ' is already installed.');
                return;
            }
            /* Install timestamp (2026-10-26): the addon tombstone
               rule needs it — a re-install after a delete survives
               only because its addedAt beats the tombstone. */
            record.addedAt = Date.now();
            addons.push(record);
            Storage.saveAddons(addons);
            this.openSettingsPage('addons');
        } catch (e) {
            this.addonStatus('Could not install: ' + e.message);
        }
    },

    setAddonEnabled(index, checked, el) {
        const addons = Storage.getAddons();
        if (addons[index]) {
            addons[index].enabled = checked;
            Storage.saveAddons(addons);
        }
        /* Instant feedback (2026-10-24, card layout 2026-10-27): the
           state pill is rendered text, so before this fix it only
           changed on the next full render (page switch) — the toggle
           flipped natively, the pill lagged behind. Update it in
           place now. No full re-render here on purpose: it would
           wipe a half-typed install URL in the form above. */
        if (el && el.closest) {
            const card = el.closest('.addon-card');
            const pill = card && card.querySelector('.addon-pills .addon-pill');
            if (pill) pill.textContent = checked ? 'Active' : 'Disabled';
            const label = el.closest('.switch');
            if (label) label.title = checked ? 'Enabled' : 'Disabled';
        }
    },

    async refreshAddon(index) {
        const addons = Storage.getAddons();
        const current = addons[index];
        if (!current) return;
        this.addonStatus('Refreshing ' + current.name + '…');
        try {
            const fresh = await Addons.fetchManifest(current.manifestUrl);
            fresh.enabled = current.enabled;
            /* Keep the original install time: a refresh must not
               look like a re-install, or it would beat a delete
               tombstone it should obey. */
            fresh.addedAt = current.addedAt || 0;
            addons[index] = fresh;
            Storage.saveAddons(addons);
            this.openSettingsPage('addons');
        } catch (e) {
            this.addonStatus('Refresh failed: ' + e.message);
        }
    },

    removeAddon(index) {
        const addons = Storage.getAddons();
        const current = addons[index];
        if (!current) return;
        if (!confirm('Remove ' + current.name + '?')) return;
        /* Sync tombstone (2026-10-26): the list being edited
           belongs to the addon OWNER (sharing profiles edit the
           primary's list), so the tombstone is keyed by owner. */
        try {
            if (typeof Sync !== 'undefined' && Sync.recordDeleted) {
                Sync.recordDeleted('addons', Storage.getAddonOwnerId(), current.manifestUrl || current.id);
            }
        } catch (e) {}
        addons.splice(index, 1);
        Storage.saveAddons(addons);
        this.openSettingsPage('addons');
    },

    moveAddon(index, dir) {
        const addons = Storage.getAddons();
        const target = index + dir;
        if (target < 0 || target >= addons.length) return;
        const tmp = addons[index];
        addons[index] = addons[target];
        addons[target] = tmp;
        Storage.saveAddons(addons);
        this.openSettingsPage('addons');
    },

    /* ---------- Theme / settings effects ---------- */
    applyTheme() {
        const settings = Storage.getSettings();
        const preset = Config.ACCENT_PRESETS.find(p => p.id === settings.accentId) || Config.ACCENT_PRESETS[0];
        document.documentElement.style.setProperty('--accent', preset.color);
        document.documentElement.style.setProperty('--accent-secondary', preset.secondary);
        document.documentElement.style.setProperty('--accent-glow', preset.color + '44');
        document.documentElement.style.setProperty('--on-accent', (preset.id === 'white' || preset.id === 'amber') ? '#101418' : '#ffffff');
        document.body.classList.toggle('hero-card-mode', settings.heroStyle === 'card');
        document.body.classList.toggle('amoled-black', !!settings.amoledBlack);
        document.body.classList.toggle('accent-gradient', !!settings.accentGradient);

        const nav = document.getElementById('floatingNav');
        const viewport = document.getElementById('appViewport');
        if (nav && viewport) {
            const isTop = settings.navBarPosition === 'top';
            nav.classList.toggle('pos-top', isTop);
            nav.classList.toggle('glass-off', settings.liquidGlassTab === false);
            document.body.classList.toggle('glass-off', settings.liquidGlassTab === false);
            nav.classList.toggle('pos-bottom', !isTop);
            viewport.classList.toggle('nav-top-pad', isTop);
        }
        const liveTvTab = document.getElementById('navTabLiveTv');
        if (liveTvTab) {
            liveTvTab.classList.toggle('hidden', !(settings.liveTvConfigured && settings.showLiveTvInNav));
        }
    },

    updateSetting(key, value) {
        Storage.updateSetting(key, value);
        this.applyTheme();
    },

    setAccent(accentId) {
        this.updateSetting('accentId', accentId);
        this.renderSettings();
    },

    /* ---------- Modals ---------- */
    openModal(html) {
        const root = document.getElementById('modalRoot');
        root.innerHTML = `
            <div class="modal-backdrop" onclick="if(event.target===this) App.closeModal()">
                <div class="modal-card">${html}</div>
            </div>`;
    },

    closeModal() {
        try { if (typeof this.simklStopAutoPoll === 'function') this.simklStopAutoPoll(); } catch (e) {}
        document.getElementById('modalRoot').innerHTML = '';
    }
};

window.addEventListener('DOMContentLoaded', () => App.init());
