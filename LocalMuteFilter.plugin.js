/**
 * @name LocalMuteFilter
 * @author LayTsyn
 * @description Locally mutes everyone in a voice channel except users in the whitelist
 * @version 2.0.0
 */

const USER_ID_REGEX = /^\d{17,20}$/; // Discord snowflake: 17–20 digits
const STYLE_ID = "lmf-styles-v1";
const DEBOUNCE_SETTINGS_MS = 400;
const DEBOUNCE_SYNC_MS = 100;
const DATA_KEY = "whitelist";

const CSS = `
    .lmf-panel { display: flex; flex-direction: column; gap: 8px; }
    .lmf-label { font-weight: bold; }
    .lmf-hint { font-size: 11px; opacity: 0.7; }
    .lmf-input {
        width: 100%; height: 120px; padding: 8px;
        border-radius: 4px;
        background: var(--background-secondary);
        color: var(--text-normal);
        border: 1px solid var(--background-tertiary);
        font-family: monospace; font-size: 12px;
        resize: vertical;
    }
    .lmf-status { font-size: 11px; opacity: 0.8; }
`;

module.exports = class LocalMuteFilter {
    constructor() {
        this.api = new BdApi("LocalMuteFilter");

        try {
            const raw = this.api.Data.load(DATA_KEY) ?? [];
            this.whitelist = Array.isArray(raw)
                ? raw.filter(x => typeof x === "string" && USER_ID_REGEX.test(x))
                : [];
        } catch {
            this.whitelist = [];
        }
        this.whitelistSet = new Set(this.whitelist);

        this._listening = false;
        this._syncTimer = null;
        this._settingsRaf = null;
        this._settingsTimer = null;
        this._commitWhitelistFn = null;

        this._currentChannelId = null;
        this._mutedInChannel = new Set();

        this.mediaStore = null;
        this.actions = null;
        this.VoiceStateStore = null;
        this.UserStore = null;

        this.boundHandler = this.handleVoiceUpdate.bind(this);
    }

    // === LIFECYCLE ===

    /**
     * Plugin startup: cache modules, subscribe, initial sync.
     */
    start() {
        this.api.Logger.info("Starting...");

        // Reset possible stale state from a previous session
        this._currentChannelId = null;
        this._mutedInChannel.clear();

        const Webpack = this.api.Webpack ?? BdApi.Webpack;
        const findStore = (name) => Webpack.getModule(m => m?.getName?.() === name);
        this.mediaStore = findStore("MediaEngineStore");
        this.VoiceStateStore = findStore("VoiceStateStore");
        this.UserStore = findStore("UserStore");

        const actionsModule = Webpack.getByKeys(["toggleLocalMute"]);
        this.actions = actionsModule && typeof actionsModule.toggleLocalMute === "function"
            ? actionsModule
            : null;

        if (!this.mediaStore || !this.actions || !this.VoiceStateStore || !this.UserStore) {
            this.api.UI.showToast(
                "Required Discord modules were not found. Plugin not started.",
                { type: "error", timeout: 10000 }
            );
            this.api.Logger.error("Modules not found", {
                mediaStore: !!this.mediaStore,
                actions: !!this.actions,
                VoiceStateStore: !!this.VoiceStateStore,
                UserStore: !!this.UserStore,
            });
            return;
        }

        if (!this._listening) {
            this.VoiceStateStore.addChangeListener(this.boundHandler);
            this._listening = true;
        }

        this.injectStyles();

        this._currentChannelId = this.getCurrentChannelId();
        this.syncChannelMutes();

        this.api.Logger.info("Active");
    }

    /**
     * Plugin shutdown: flush unsaved settings, clear mutes, unsubscribe.
     */
    stop() {
        this.api.Logger.info("Stopping...");

        // Flush unsaved settings
        if (this._commitWhitelistFn) {
            try { this._commitWhitelistFn(); } catch (e) {
                this.api.Logger.error("Failed to flush settings", e);
            }
            this._commitWhitelistFn = null;
        }

        const removed = this.clearChannelMutes();
        this.api.Logger.info(`Cleared mutes: ${removed}`);

        if (this._listening && this.VoiceStateStore) {
            this.VoiceStateStore.removeChangeListener(this.boundHandler);
            this._listening = false;
        }

        if (this._syncTimer) {
            clearTimeout(this._syncTimer);
            this._syncTimer = null;
        }

        if (this._settingsTimer) {
            clearTimeout(this._settingsTimer);
            this._settingsTimer = null;
        }

        if (this._settingsRaf) {
            cancelAnimationFrame(this._settingsRaf);
            this._settingsRaf = null;
        }

        const style = document.getElementById(STYLE_ID);
        if (style) style.remove();

        this._currentChannelId = null;

        this.api.Logger.info("Stopped");
    }

    // === SETTINGS PANEL ===

    /**
     * Returns an HTMLElement with plugin settings.
     * Saving and applying is debounced.
     * Unsaved changes are flushed immediately when the panel is closed.
     * @returns {HTMLElement}
     */
    getSettingsPanel() {
        // Clean up previous resources if the panel is opened again
        if (this._settingsTimer) {
            clearTimeout(this._settingsTimer);
            this._settingsTimer = null;
        }
        if (this._settingsRaf) {
            cancelAnimationFrame(this._settingsRaf);
            this._settingsRaf = null;
        }

        const panel = document.createElement("div");
        panel.className = "lmf-panel";

        const label = document.createElement("div");
        label.className = "lmf-label";
        label.textContent = "User IDs (comma or newline separated)";

        const hint = document.createElement("div");
        hint.className = "lmf-hint";
        hint.textContent = "Digits only, 17–20 characters. Invalid values are ignored.";

        const input = document.createElement("textarea");
        input.className = "lmf-input";
        input.value = this.whitelist.join("\n");
        input.placeholder = "123456789012345678\n987654321098765432";

        const status = document.createElement("div");
        status.className = "lmf-status";
        status.textContent = `Saved: ${this.whitelist.length}`;

        /**
         * Applies the input value to the whitelist and persists it.
         */
        const commitWhitelist = () => {
            const raw = input.value;
            const all = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
            const valid = [...new Set(all.filter(s => USER_ID_REGEX.test(s)))];
            const dropped = all.length - valid.length;

            this.whitelist = valid;
            this.whitelistSet = new Set(valid);
            this.api.Data.save(DATA_KEY, valid);

            status.textContent = dropped > 0
                ? `Saved: ${valid.length} (discarded: ${dropped})`
                : `Saved: ${valid.length}`;

            this.syncChannelMutes();
        };

        // Store a reference for flushing on stop()
        this._commitWhitelistFn = commitWhitelist;

        input.addEventListener("input", () => {
            if (this._settingsTimer) clearTimeout(this._settingsTimer);
            this._settingsTimer = setTimeout(() => {
                this._settingsTimer = null;
                commitWhitelist();
            }, DEBOUNCE_SETTINGS_MS);
        });

        // Check once per frame whether the panel is still alive; flush on detach.
        // requestAnimationFrame is cheaper than a MutationObserver on document.body.
        const checkAlive = () => {
            if (!panel.isConnected) {
                if (this._settingsTimer) {
                    clearTimeout(this._settingsTimer);
                    this._settingsTimer = null;
                    commitWhitelist();
                }
                this._settingsRaf = null;
                this._commitWhitelistFn = null;
                return;
            }
            this._settingsRaf = requestAnimationFrame(checkAlive);
        };
        this._settingsRaf = requestAnimationFrame(checkAlive);

        panel.append(label, hint, input, status);
        return panel;
    }

    /**
     * Injects the plugin CSS into head. Idempotent.
     */
    injectStyles() {
        const existing = document.getElementById(STYLE_ID);
        if (existing) existing.remove();

        const style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    // === CORE LOGIC ===

    /**
     * Removes local mutes from every user the plugin muted in the current
     * channel, and clears the internal set.
     * @returns {number} number of mutes actually removed
     */
    clearChannelMutes() {
        if (!this.mediaStore || !this.actions) {
            const had = this._mutedInChannel.size;
            this._mutedInChannel.clear();
            return had;
        }

        let removed = 0;
        for (const userId of Array.from(this._mutedInChannel)) {
            try {
                if (this.mediaStore.isLocalMute(userId)) {
                    this.actions.toggleLocalMute(userId);
                    removed++;
                }
            } catch (e) {
                this.api.Logger.error(`Failed to unmute ${userId}`, e);
            }
        }
        this._mutedInChannel.clear();
        return removed;
    }

    /**
     * Brings the mute state of the current channel in line with the whitelist.
     * Works both for guild voice channels and DM calls.
     */
    syncChannelMutes() {
        if (!this.VoiceStateStore || !this.UserStore || !this.mediaStore || !this.actions) return;

        const channelId = this.getCurrentChannelId();
        if (!channelId) return;

        const voiceStates = this.VoiceStateStore.getVoiceStatesForChannel(channelId);
        if (!voiceStates) return;

        const myId = this.UserStore.getCurrentUser()?.id;

        for (const state of Object.values(voiceStates)) {
            const userId = state?.userId;
            if (!userId || userId === myId) continue;
            if (state.channelId && state.channelId !== channelId) continue;

            const inWhitelist = this.whitelistSet.has(userId);

            if (inWhitelist) {
                if (this._mutedInChannel.has(userId)) {
                    this.setMute(userId, false);
                    this._mutedInChannel.delete(userId);
                }
            } else {
                if (!this._mutedInChannel.has(userId)) {
                    this.setMute(userId, true);
                    // "Adopt" the mute even if it wasn't ours — the plugin owns the channel
                    if (this.mediaStore.isLocalMute(userId)) {
                        this._mutedInChannel.add(userId);
                    }
                }
            }
        }
    }

    /**
     * Reacts to voice state store changes with a debounce.
     * Tracks channel switches: on leave — clears mutes,
     * on join — applies the rule to the new channel.
     */
    handleVoiceUpdate() {
        if (this._syncTimer) return;
        this._syncTimer = setTimeout(() => {
            this._syncTimer = null;
            try {
                const newChannelId = this.getCurrentChannelId();

                if (newChannelId !== this._currentChannelId) {
                    this.api.Logger.info(`Channel changed: ${this._currentChannelId} → ${newChannelId}`);
                    this.clearChannelMutes();
                    this._currentChannelId = newChannelId;
                }

                if (newChannelId) {
                    this.syncChannelMutes();
                }
            } catch (e) {
                this.api.Logger.error("Error in handleVoiceUpdate", e);
            }
        }, DEBOUNCE_SYNC_MS);
    }

    /**
     * Sets or clears a local mute. The single point of state checking.
     * @param {string} userId
     * @param {boolean} shouldMute
     */
    setMute(userId, shouldMute) {
        try {
            const currentlyMuted = this.mediaStore.isLocalMute(userId);
            if (currentlyMuted !== shouldMute) {
                this.actions.toggleLocalMute(userId);
            }
        } catch (e) {
            this.api.Logger.error(`setMute failed for ${userId}`, e);
        }
    }

    /**
     * ID of the voice channel the current user is in.
     * @returns {string|null}
     */
    getCurrentChannelId() {
        const myId = this.UserStore?.getCurrentUser?.()?.id;
        if (!myId) return null;

        const voiceState = this.VoiceStateStore?.getVoiceStateForUser?.(myId);
        return voiceState ? voiceState.channelId : null;
    }
};