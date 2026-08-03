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
}

export const DEFAULT_SETTINGS: NucleusSettings = {
  url: "",
  key: "",
  vaultName: "",
  syncOnChange: true,
  syncEveryMinutes: 15,
  syncOnStartup: true,
  preferFetchForBinary: true,
  maxRequestUrlBinaryBytes: 8 * 1024 * 1024,
  state: {},
  onboarded: false,
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
