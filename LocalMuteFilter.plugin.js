/**
 * @name LocalMuteFilter
 * @author LayTsyn
 * @description Locally mutes everyone in a voice channel except whitelisted users
 * @version 1.0.2
 */

const STORAGE_KEY = "whitelist";
const ID_RE = /^\d{17,20}$/;

module.exports = class LocalMuteFilter {
    constructor() {
        this.api = new BdApi("LocalMuteFilter");

        const saved = this.api.Data.load(STORAGE_KEY);
        this.whitelist = new Set(Array.isArray(saved) ? saved : []);

        this.muted = new Set(); // users muted by the plugin, only these are ever unmuted by it
        this.running = false;
    }

    start() {
        const { Webpack } = this.api;
        this.media = Webpack.getStore("MediaEngineStore");
        this.voice = Webpack.getStore("VoiceStateStore");
        this.users = Webpack.getStore("UserStore");
        this.actions = Webpack.getByKeys("toggleLocalMute");

        if (!this.media || !this.voice || !this.users || !this.actions) {
            throw new Error("Required Discord modules were not found");
        }

        this.voice.addChangeListener(this.sync);
        this.running = true;
        this.sync();
    }

    stop() {
        this.running = false;
        this.voice?.removeChangeListener(this.sync);

        for (const id of this.muted) this.unmute(id);
        this.muted.clear();
    }

    getSettingsPanel() {
        const panel = document.createElement("div");
        panel.style.cssText = "display:flex;flex-direction:column;gap:8px";

        const label = document.createElement("div");
        label.textContent = "Allowed user IDs (one per line or comma-separated)";
        label.style.fontWeight = "bold";

        const input = document.createElement("textarea");
        input.value = [...this.whitelist].join("\n");
        input.placeholder = "123456789012345678";
        input.style.cssText = "height:120px;padding:8px;resize:vertical;font-family:monospace;" +
            "color:var(--text-normal);background:var(--background-secondary);" +
            "border:1px solid var(--background-tertiary);border-radius:4px";

        const status = document.createElement("div");
        const showStatus = (ignored = 0) => {
            status.textContent = `Saved: ${this.whitelist.size}` + (ignored ? `, ignored: ${ignored}` : "");
        };
        showStatus();

        input.addEventListener("input", () => {
            const ids = input.value.split(/[\s,]+/).filter(Boolean);
            const valid = ids.filter(id => ID_RE.test(id));

            this.whitelist = new Set(valid);
            this.api.Data.save(STORAGE_KEY, [...this.whitelist]);
            showStatus(ids.length - valid.length);

            if (this.running) this.sync();
        });

        panel.append(label, input, status);

        // Prevent Discord's focus-layers from stealing focus away from our textarea.
        // Discord listens for focus/focusin on `document` in the capture phase.
        // We listen on `window` (which is above `document`) also in capture,
        // so our handler fires first and can stop propagation.
        const captureFocus = (e) => {
            if (panel.contains(e.target)) e.stopPropagation();
        };
        window.addEventListener("focus", captureFocus, true);
        window.addEventListener("focusin", captureFocus, true);

        setTimeout(() => {
            input.focus();
            input.selectionStart = input.value.length;
            input.selectionEnd = input.value.length;
        }, 50);

        return panel;
    }

    // Brings local mutes in line with the whitelist for the channel we are in right now.
    // Idempotent, so it is safe to call on every store change.
    sync() {
        const me = this.users.getCurrentUser()?.id;
        const channelId = this.voice.getVoiceStateForUser(me)?.channelId;
        const states = channelId ? Object.values(this.voice.getVoiceStatesForChannel(channelId)) : [];

        const present = new Set(states.map(state => state.userId));
        present.delete(me);

        // we left the channel or they did: give back what we took
        for (const id of this.muted) {
            if (!present.has(id)) {
                this.muted.delete(id);
                this.unmute(id);
            }
        }

        for (const id of present) {
            if (this.whitelist.has(id)) {
                if (this.muted.delete(id)) this.unmute(id);
            } else if (!this.media.isLocalMute(id)) {
                this.muted.add(id);
                this.actions.toggleLocalMute(id);
            }
        }
    }

    unmute(userId) {
        if (this.media.isLocalMute(userId)) this.actions.toggleLocalMute(userId);
    }
};
