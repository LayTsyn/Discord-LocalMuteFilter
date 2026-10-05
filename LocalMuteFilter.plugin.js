/**
 * @name LocalMuteFilter
 * @author LayTsyn
 * @version 1.0.0
 * @description Locally mutes everyone in a voice channel except whitelisted users
 */

const ID_RE = /^\d{17,20}$/;
const STYLE_ID = "lmf-style";
const DATA_KEY = "whitelist";

module.exports = class LocalMuteFilter {
    constructor() {
        this.api = new BdApi("LocalMuteFilter");

        let raw = [];
        try { raw = this.api.Data.load(DATA_KEY) || []; } catch (e) {}
        this.wl = Array.isArray(raw) ? raw.filter(x => typeof x === "string" && ID_RE.test(x)) : [];
        this.wlSet = new Set(this.wl);

        this.listening = false;
        this.syncTimer = null;
        this.rafId = null;
        this.settingsTimer = null;
        this.commitFn = null;
        this.chan = null;
        this.muted = new Set();

        this.media = null;
        this.actions = null;
        this.voice = null;
        this.users = null;

        this.onUpdate = this.handleUpdate.bind(this);
    }

    start() {
        this.api.Logger.info("Starting...");

        this.chan = null;
        this.muted.clear();

        let wp = this.api.Webpack || BdApi.Webpack;
        let get = (n) => wp.getModule(m => m?.getName?.() === n);
        this.media = get("MediaEngineStore");
        this.voice = get("VoiceStateStore");
        this.users = get("UserStore");

        let am = wp.getByKeys(["toggleLocalMute"]);
        this.actions = am && typeof am.toggleLocalMute === "function" ? am : null;

        if (!this.media || !this.actions || !this.voice || !this.users) {
            this.api.UI.showToast("Required Discord modules not found. Plugin not started.", { type: "error", timeout: 10000 });
            this.api.Logger.error("Modules not found", {
                media: !!this.media,
                actions: !!this.actions,
                voice: !!this.voice,
                users: !!this.users
            });
            return;
        }

        if (!this.listening) {
            this.voice.addChangeListener(this.onUpdate);
            this.listening = true;
        }

        this.injectStyles();
        this.chan = this.getChannelId();
        this.sync();

        this.api.Logger.info("Active");
    }

    stop() {
        this.api.Logger.info("Stopping...");

        if (this.commitFn) {
            try { this.commitFn(); } catch (e) { this.api.Logger.error("Flush failed", e); }
            this.commitFn = null;
        }

        let n = this.clearMutes();
        this.api.Logger.info("Cleared mutes: " + n);

        if (this.listening && this.voice) {
            this.voice.removeChangeListener(this.onUpdate);
            this.listening = false;
        }

        if (this.syncTimer) { clearTimeout(this.syncTimer); this.syncTimer = null; }
        if (this.settingsTimer) { clearTimeout(this.settingsTimer); this.settingsTimer = null; }
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }

        let style = document.getElementById(STYLE_ID);
        if (style) style.remove();

        this.chan = null;
        this.api.Logger.info("Stopped");
    }

    getSettingsPanel() {
        if (this.settingsTimer) { clearTimeout(this.settingsTimer); this.settingsTimer = null; }
        if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = null; }

        let panel = document.createElement("div");
        panel.style.cssText = "display:flex;flex-direction:column;gap:8px";

        let label = document.createElement("div");
        label.style.fontWeight = "bold";
        label.textContent = "User IDs (comma or newline separated)";

        let hint = document.createElement("div");
        hint.style.cssText = "font-size:11px;opacity:0.7";
        hint.textContent = "Digits only, 17-20 characters. Invalid values are ignored.";

        let input = document.createElement("textarea");
        input.style.cssText = "width:100%;height:120px;padding:8px;border-radius:4px;background:var(--background-secondary);color:var(--text-normal);border:1px solid var(--background-tertiary);font-family:monospace;font-size:12px;resize:vertical";
        input.value = this.wl.join("\n");
        input.placeholder = "123456789012345678\n987654321098765432";

        let status = document.createElement("div");
        status.style.cssText = "font-size:11px;opacity:0.8";
        status.textContent = "Saved: " + this.wl.length;

        let commit = () => {
            let raw = input.value;
            let all = raw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
            let valid = [...new Set(all.filter(s => ID_RE.test(s)))];
            let dropped = all.length - valid.length;

            this.wl = valid;
            this.wlSet = new Set(valid);
            this.api.Data.save(DATA_KEY, valid);

            status.textContent = dropped > 0 ? "Saved: " + valid.length + " (discarded: " + dropped + ")" : "Saved: " + valid.length;

            this.sync();
        };

        this.commitFn = commit;

        input.addEventListener("input", () => {
            if (this.settingsTimer) clearTimeout(this.settingsTimer);
            this.settingsTimer = setTimeout(() => { this.settingsTimer = null; commit(); }, 400);
        });

        // flush on panel close
        let checkAlive = () => {
            if (!panel.isConnected) {
                if (this.settingsTimer) { clearTimeout(this.settingsTimer); this.settingsTimer = null; commit(); }
                this.rafId = null;
                this.commitFn = null;
                return;
            }
            this.rafId = requestAnimationFrame(checkAlive);
        };
        this.rafId = requestAnimationFrame(checkAlive);

        panel.append(label, hint, input, status);
        return panel;
    }

    injectStyles() {
        let existing = document.getElementById(STYLE_ID);
        if (existing) existing.remove();
        let style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = ".lmf-panel{display:flex;flex-direction:column;gap:8px}";
        document.head.appendChild(style);
    }

    clearMutes() {
        if (!this.media || !this.actions) {
            let n = this.muted.size;
            this.muted.clear();
            return n;
        }
        let removed = 0;
        for (let id of Array.from(this.muted)) {
            try {
                if (this.media.isLocalMute(id)) {
                    this.actions.toggleLocalMute(id);
                    removed++;
                }
            } catch (e) { this.api.Logger.error("Failed to unmute " + id, e); }
        }
        this.muted.clear();
        return removed;
    }

    sync() {
        if (!this.voice || !this.users || !this.media || !this.actions) return;

        let chanId = this.getChannelId();
        if (!chanId) return;

        let states = this.voice.getVoiceStatesForChannel(chanId);
        if (!states) return;

        let me = this.users.getCurrentUser()?.id;

        for (let s of Object.values(states)) {
            let id = s?.userId;
            if (!id || id === me) continue;
            if (s.channelId && s.channelId !== chanId) continue;

            let inWl = this.wlSet.has(id);

            if (inWl) {
                if (this.muted.has(id)) {
                    this.setMute(id, false);
                    this.muted.delete(id);
                }
            } else {
                if (!this.muted.has(id)) {
                    this.setMute(id, true);
                    if (this.media.isLocalMute(id)) this.muted.add(id);
                }
            }
        }
    }

    handleUpdate() {
        if (this.syncTimer) return;
        this.syncTimer = setTimeout(() => {
            this.syncTimer = null;
            try {
                let newChan = this.getChannelId();
                if (newChan !== this.chan) {
                    this.api.Logger.info("Channel changed: " + this.chan + " -> " + newChan);
                    this.clearMutes();
                    this.chan = newChan;
                }
                if (newChan) this.sync();
            } catch (e) { this.api.Logger.error("handleUpdate error", e); }
        }, 100);
    }

    setMute(id, mute) {
        try {
            let now = this.media.isLocalMute(id);
            if (now !== mute) this.actions.toggleLocalMute(id);
        } catch (e) { this.api.Logger.error("setMute failed for " + id, e); }
    }

    getChannelId() {
        let me = this.users?.getCurrentUser?.()?.id;
        if (!me) return null;
        let vs = this.voice?.getVoiceStateForUser?.(me);
        return vs ? vs.channelId : null;
    }
};