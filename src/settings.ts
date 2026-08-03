/**
 * settings — what the plugin remembers, and the screen for changing it.
 *
 * A note on the key: it is stored in this plugin's `data.json`, inside the
 * vault's `.obsidian` folder, in plain text. Obsidian offers no keychain, and
 * every other plugin installed in this vault can read it. That is stated in the
 * settings screen rather than hidden, because the honest mitigation is to use a
 * credential you can revoke — not to pretend the file is secret.
 */

import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type NucleusSyncPlugin from "./main";
import type { SyncState } from "./core/types";

export interface NucleusSettings {
  url: string;
  key: string;
  vaultName: string;
  /** Sync automatically after edits settle. */
  syncOnChange: boolean;
  /** Minutes between background passes; 0 turns it off. */
  syncEveryMinutes: number;
  /** Watch for changes made on other devices and pull them in quickly. */
  liveSync: boolean;
  /** Seconds between "has anything changed?" checks. */
  liveIntervalSeconds: number;
  /** Sync when the vault opens. */
  syncOnStartup: boolean;
  /** Use native fetch for big binaries (needs CORS on your Nucleus). */
  preferFetchForBinary: boolean;
  /** Refuse rather than crash when falling back to Obsidian's own HTTP. */
  maxRequestUrlBinaryBytes: number;
  /**
   * Per-device record of when each file last agreed with the layer.
   *
   * Imported from `core/types` rather than re-declared: the two drifted the
   * first time round (`at` optional there, required here) and the mismatch
   * only surfaced at the call site in main.ts. One definition, one source.
   */
  state: SyncState;
  /** Set once the wizard has run, so it does not reappear every launch. */
  onboarded: boolean;
  /**
   * Which attachments this device wants.
   *
   * Notes are ~2 MB and arrive in seconds; attachments are the other 1.4 GB and
   * are limited by the home upload at the far end (measured: ~1.2 MB/s, so about
   * twenty minutes). Most devices — phones especially — do not want all of that,
   * and waiting for it makes the notes feel slow when they were never the
   * problem.
   */
  attachments: "all" | "under-limit" | "none";
  /** Size ceiling for "under-limit", in bytes. */
  attachmentLimitBytes: number;
  /** Carry `.obsidian` too — plugins, themes, snippets, hotkeys. */
  syncConfig: boolean;
  /** Include plugin caches that rewrite themselves constantly. */
  syncPluginCaches: boolean;
}

export const DEFAULT_SETTINGS: NucleusSettings = {
  url: "",
  key: "",
  vaultName: "",
  syncOnChange: true,
  syncEveryMinutes: 15,
  syncOnStartup: true,
  liveSync: true,
  liveIntervalSeconds: 5,
  preferFetchForBinary: true,
  maxRequestUrlBinaryBytes: 8 * 1024 * 1024,
  state: {},
  onboarded: false,
  // Everything, by default. The whole point of the layer is that it holds all
  // of it; a device that quietly leaves the video behind is not a copy.
  attachments: "all",
  attachmentLimitBytes: 25 * 1024 * 1024,
  syncConfig: true,
  syncPluginCaches: false,
};

export class NucleusSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: NucleusSyncPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Nucleus Vault Sync" });
    containerEl.createEl("p", {
      text: "This vault is stored in a database you own. Nothing here is sent anywhere else.",
    });

    new Setting(containerEl)
      .setName("Set up")
      .setDesc("Run the setup wizard again — it works out what needs moving and asks before doing it.")
      .addButton((b) => b.setButtonText("Open setup").onClick(() => this.plugin.openOnboarding()));

    // What happened last, in full. The status bar has room for a few words;
    // this is where the actual reason lives.
    const last = this.plugin.lastError ?? this.plugin.lastReport;
    if (last) {
      const box = containerEl.createEl("div", {
        cls: this.plugin.lastError ? "nucleus-warning" : "nucleus-secondary",
      });
      box.createEl("p", { text: this.plugin.lastError ? "Last sync failed" : "How sync is doing" });
      box.createEl("pre", { text: last, cls: "nucleus-log" });
      if (this.plugin.lastError) {
        new Setting(box).addButton((b) =>
          b.setButtonText("Try again").setCta().onClick(() => void this.plugin.syncNow()),
        );
      }
    }

    containerEl.createEl("h3", { text: "Connection" });

    new Setting(containerEl)
      .setName("Nucleus address")
      .addText((t) =>
        t
          .setPlaceholder("https://…")
          .setValue(this.plugin.settings.url)
          .onChange(async (v) => {
            this.plugin.settings.url = v.trim().replace(/\/+$/, "");
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Key")
      .setDesc(
        "Stored in plain text in this vault's plugin folder, where other plugins can read it. " +
          "Use a credential you can revoke.",
      )
      .addText((t) => {
        t.setPlaceholder("paste your key")
          .setValue(this.plugin.settings.key)
          .onChange(async (v) => {
            this.plugin.settings.key = v.trim();
            await this.plugin.saveSettings();
          });
        t.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Vault name")
      .setDesc("Must match on every device syncing these notes.")
      .addText((t) =>
        t.setValue(this.plugin.settings.vaultName).onChange(async (v) => {
          this.plugin.settings.vaultName = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).addButton((b) =>
      b.setButtonText("Test connection").onClick(async () => {
        const result = await this.plugin.testConnection();
        new Notice(result.message);
      }),
    );

    containerEl.createEl("h3", { text: "When to sync" });

    new Setting(containerEl)
      .setName("On startup")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnStartup).onChange(async (v) => {
          this.plugin.settings.syncOnStartup = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("After you stop typing")
      .setDesc("Waits a few seconds after the last edit, so a burst of changes is one sync.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncOnChange).onChange(async (v) => {
          this.plugin.settings.syncOnChange = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Keep up with other devices")
      .setDesc(
        "Checks every few seconds whether anything changed elsewhere, and pulls it in when it " +
          "has. The check itself is one small request — a full sync only runs when something " +
          "actually moved.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.liveSync).onChange(async (v) => {
          this.plugin.settings.liveSync = v;
          await this.plugin.saveSettings();
          this.plugin.rescheduleTimer();
          this.display();
        }),
      );

    if (this.plugin.settings.liveSync) {
      new Setting(containerEl)
        .setName("Check every (seconds)")
        .setDesc("Lower feels more live and uses a little more data. 5 is a good default.")
        .addText((t) =>
          t.setValue(String(this.plugin.settings.liveIntervalSeconds)).onChange(async (v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 2) {
              this.plugin.settings.liveIntervalSeconds = n;
              await this.plugin.saveSettings();
              this.plugin.rescheduleTimer();
            }
          }),
        );
    }

    new Setting(containerEl)
      .setName("Every so often")
      .setDesc("Minutes between background syncs. 0 turns it off. Ignored while the app is in the background on iPhone and iPad, which do not let plugins run.")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.syncEveryMinutes)).onChange(async (v) => {
          const n = Number(v);
          this.plugin.settings.syncEveryMinutes = Number.isFinite(n) && n >= 0 ? n : 0;
          await this.plugin.saveSettings();
          this.plugin.rescheduleTimer();
        }),
      );

    containerEl.createEl("h3", { text: "App settings and plugins" });

    new Setting(containerEl)
      .setName("Sync everything else in the vault")
      .setDesc(
        "Which plugins are enabled, every plugin's own settings, themes, snippets, hotkeys, " +
          "appearance, graph settings, workspace layout — the whole .obsidian folder. The only " +
          "thing never sent is this plugin's own settings file, because it holds your key and " +
          "this device's sync record, which has to differ per device.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.syncConfig).onChange(async (v) => {
          this.plugin.settings.syncConfig = v;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (this.plugin.settings.syncConfig) {
      new Setting(containerEl)
        .setName("Also sync plugin caches")
        .setDesc(
          "Off by default. Some plugins keep a cache they rewrite constantly, which would keep " +
            "sync permanently busy. They rebuild themselves on each device anyway.",
        )
        .addToggle((t) =>
          t.setValue(this.plugin.settings.syncPluginCaches).onChange(async (v) => {
            this.plugin.settings.syncPluginCaches = v;
            await this.plugin.saveSettings();
          }),
        );
    }

    containerEl.createEl("h3", { text: "Attachments" });

    new Setting(containerEl)
      .setName("Which attachments to keep on this device")
      .setDesc(
        "Your notes always sync, and they are small — they arrive in seconds. Attachments are " +
          "the bulk of a vault and are limited by your home connection, so a phone rarely wants " +
          "all of them. Notes that reference a missing attachment still open fine.",
      )
      .addDropdown((d) =>
        d
          .addOption("all", "Everything, including video")
          .addOption("under-limit", "Only smaller files (recommended)")
          .addOption("none", "Notes only")
          .setValue(this.plugin.settings.attachments)
          .onChange(async (v) => {
            this.plugin.settings.attachments = v as "all" | "under-limit" | "none";
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.attachments === "under-limit") {
      new Setting(containerEl)
        .setName("Skip attachments larger than (MB)")
        .addText((t) =>
          t
            .setValue(String(Math.round(this.plugin.settings.attachmentLimitBytes / 1048576)))
            .onChange(async (v) => {
              const mb = Number(v);
              if (Number.isFinite(mb) && mb > 0) {
                this.plugin.settings.attachmentLimitBytes = Math.round(mb * 1048576);
                await this.plugin.saveSettings();
              }
            }),
        );
    }

    containerEl.createEl("h3", { text: "Large files" });

    new Setting(containerEl)
      .setName("Use direct transfers for big attachments")
      .setDesc(
        "Obsidian's own network calls run out of memory on mobile somewhere above 20 MB, because " +
          "of how they pass data to the phone. This uses a direct connection instead, which handles " +
          "large videos fine — your Nucleus must allow it (yours already does). Turn off only if " +
          "large files fail to transfer.",
      )
      .addToggle((t) =>
        t.setValue(this.plugin.settings.preferFetchForBinary).onChange(async (v) => {
          this.plugin.settings.preferFetchForBinary = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Skip files larger than (MB)")
      .setDesc("Only applies when direct transfers are off. Prevents a big file from crashing the app.")
      .addText((t) =>
        t.setValue(String(Math.round(this.plugin.settings.maxRequestUrlBinaryBytes / 1048576))).onChange(async (v) => {
          const mb = Number(v);
          if (Number.isFinite(mb) && mb > 0) {
            this.plugin.settings.maxRequestUrlBinaryBytes = Math.round(mb * 1048576);
            await this.plugin.saveSettings();
          }
        }),
      );

    containerEl.createEl("h3", { text: "Trouble" });

    new Setting(containerEl)
      .setName("Forget what this device has synced")
      .setDesc(
        "Clears this device's record of when each file last agreed with your Nucleus. Nothing is " +
          "deleted anywhere. The next sync becomes cautious again: anything that differs is kept " +
          "both ways rather than overwritten.",
      )
      .addButton((b) =>
        b.setButtonText("Forget").setWarning().onClick(async () => {
          this.plugin.settings.state = {};
          await this.plugin.saveSettings();
          new Notice("Sync record cleared. Nothing was deleted.");
        }),
      );
  }
}
