/**
 * Nucleus Vault Sync — keep an Obsidian vault in a database you own.
 *
 * The plugin's job is small: notice when things change, and run a pass. The
 * pass itself is in `engine.ts`, and the decision about whether a given file
 * may be overwritten is in `core/decide.ts`, shared with the Mac connector so
 * that both agree about what is safe.
 *
 * ## Two lifecycle traps, both handled here
 *
 * 1. `vault.on("create")` fires for **every existing file** while Obsidian
 *    indexes at startup. Registering it directly would make every launch look
 *    like the user had just created their whole vault. Handlers are attached
 *    inside `onLayoutReady`, after indexing.
 *
 * 2. Writing a file during a pull fires those same events, which would schedule
 *    another sync, which would write again. A suppression flag around our own
 *    writes breaks that loop.
 *
 * On iPhone and iPad the app is suspended when backgrounded — timers stop and
 * in-flight requests die. Nothing here assumes it keeps running: every pass is
 * resumable and starts by asking both sides what they have.
 */

import { Notice, Plugin, TFile, debounce } from "obsidian";

import { NucleusClient } from "./client";
import { pull, push, syncBothWays, isExcluded, type PassResult } from "./engine";
import { OnboardingModal, type Situation } from "./onboarding";
import { DEFAULT_SETTINGS, NucleusSettingTab, type NucleusSettings } from "./settings";

export default class NucleusSyncPlugin extends Plugin {
  settings: NucleusSettings = { ...DEFAULT_SETTINGS };
  private client: NucleusClient | null = null;
  private syncing = false;
  /** True while WE are writing, so our own writes do not trigger another pass. */
  private applyingRemote = false;
  private statusEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new NucleusSettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.setStatus(this.configured ? "Nucleus: ready" : "Nucleus: not set up");

    this.addRibbonIcon("refresh-cw", "Sync with Nucleus", () => void this.syncNow());

    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.syncNow() });
    this.addCommand({
      id: "download-from-nucleus",
      name: "Download everything from Nucleus (do not upload)",
      callback: () => void this.runOneWay("pull"),
    });
    this.addCommand({
      id: "upload-to-nucleus",
      name: "Upload everything to Nucleus (do not download)",
      callback: () => void this.runOneWay("push"),
    });
    this.addCommand({ id: "open-setup", name: "Open setup", callback: () => this.openOnboarding() });

    // Everything that depends on the vault being indexed waits for it.
    this.app.workspace.onLayoutReady(() => {
      this.registerChangeHandlers();
      this.rescheduleTimer();

      if (!this.settings.onboarded) {
        this.openOnboarding();
      } else if (this.settings.syncOnStartup && this.configured) {
        void this.syncNow({ quiet: true });
      }
    });
  }

  get configured(): boolean {
    return Boolean(this.settings.url && this.settings.key && this.settings.vaultName);
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(text);
  }

  makeClient(
    url = this.settings.url,
    key = this.settings.key,
    vaultName = this.settings.vaultName,
  ): NucleusClient {
    return new NucleusClient({
      url,
      key,
      vaultName,
      preferFetchForBinary: this.settings.preferFetchForBinary,
      maxRequestUrlBinaryBytes: this.settings.maxRequestUrlBinaryBytes,
    });
  }

  private getClient(): NucleusClient {
    if (!this.client) this.client = this.makeClient();
    return this.client;
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    if (!this.configured) return { ok: false, message: "Fill in the address, key and vault name first." };
    return this.makeClient().testConnection();
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<NucleusSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
    if (!this.settings.vaultName) this.settings.vaultName = this.app.vault.getName();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.client = null; // rebuilt on next use, so a changed key takes effect at once
  }

  /** Persist just the per-file sync record, without disturbing anything else. */
  private saveState = async (state: NucleusSettings["state"]): Promise<void> => {
    this.settings.state = state;
    await this.saveData(this.settings);
  };

  private engineOptions(report?: (line: string) => void) {
    return {
      app: this.app,
      client: this.getClient(),
      vaultName: this.settings.vaultName,
      state: this.settings.state,
      saveState: this.saveState,
      log: (line: string) => {
        console.warn("[nucleus]", line);
        report?.(line);
      },
      onProgress: (done: number, total: number, what: string) => {
        this.setStatus(`Nucleus: ${done}/${total}`);
        report?.(`${done}/${total} — ${what}`);
      },
    };
  }

  openOnboarding(): void {
    new OnboardingModal(this.app, {
      defaults: {
        url: this.settings.url,
        key: this.settings.key,
        vaultName: this.settings.vaultName || this.app.vault.getName(),
      },
      makeClient: (url, key, vaultName) => this.makeClient(url, key, vaultName),
      onConnect: async (url, key, vaultName) => {
        const result = await this.makeClient(url, key, vaultName).testConnection();
        if (result.ok) {
          this.settings.url = url;
          this.settings.key = key;
          this.settings.vaultName = vaultName;
          await this.saveSettings();
        }
        return result;
      },
      onRun: async (situation: Situation, report) => {
        const options = this.engineOptions(report);
        this.applyingRemote = true;
        try {
          let pulled: PassResult | null = null;
          let pushed: PassResult | null = null;

          if (situation === "restore") pulled = await pull(options);
          else if (situation === "upload") pushed = await push(options);
          else {
            const both = await syncBothWays(options);
            pulled = both.pulled;
            pushed = both.pushed;
          }

          this.settings.onboarded = true;
          await this.saveSettings();

          const parts: string[] = [];
          if (pulled?.downloaded) parts.push(`${pulled.downloaded} downloaded`);
          if (pushed?.uploaded) parts.push(`${pushed.uploaded} uploaded`);
          if (pulled?.deletedLocally) parts.push(`${pulled.deletedLocally} removed here`);
          if (pushed?.tombstoned) parts.push(`${pushed.tombstoned} marked deleted`);
          if (!parts.length) parts.push("everything already matched");

          this.setStatus("Nucleus: ready");
          return {
            summary: parts.join(", ") + ".",
            conflicts: (pulled?.conflicts.length ?? 0) + (pushed?.conflicts.length ?? 0),
            failed: (pulled?.failed.length ?? 0) + (pushed?.failed.length ?? 0),
          };
        } finally {
          this.applyingRemote = false;
        }
      },
    }).open();
  }

  /** One command, one direction — for when the automatic choice is not what you want. */
  private async runOneWay(direction: "pull" | "push"): Promise<void> {
    if (!this.guard()) return;
    this.syncing = true;
    this.applyingRemote = true;
    try {
      const options = this.engineOptions();
      const result = direction === "pull" ? await pull(options) : await push(options);
      this.announce(direction === "pull" ? result : null, direction === "push" ? result : null);
    } catch (error) {
      new Notice(`Nucleus: ${error instanceof Error ? error.message : String(error)}`);
      this.setStatus("Nucleus: last sync failed");
    } finally {
      this.syncing = false;
      this.applyingRemote = false;
    }
  }

  async syncNow({ quiet = false } = {}): Promise<void> {
    if (!this.guard(quiet)) return;
    this.syncing = true;
    this.applyingRemote = true;
    this.setStatus("Nucleus: syncing…");
    try {
      const { pulled, pushed } = await syncBothWays(this.engineOptions());
      this.announce(pulled, pushed, quiet);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!quiet) new Notice(`Nucleus: ${message}`);
      console.error("[nucleus] sync failed", error);
      this.setStatus("Nucleus: last sync failed");
    } finally {
      this.syncing = false;
      this.applyingRemote = false;
    }
  }

  private guard(quiet = false): boolean {
    if (this.syncing) return false;
    if (!this.configured) {
      if (!quiet) new Notice("Nucleus is not set up yet — open Settings → Nucleus Vault Sync.");
      return false;
    }
    return true;
  }

  private announce(pulled: PassResult | null, pushed: PassResult | null, quiet = false): void {
    const conflicts = (pulled?.conflicts.length ?? 0) + (pushed?.conflicts.length ?? 0);
    const failed = (pulled?.failed.length ?? 0) + (pushed?.failed.length ?? 0);

    const bits: string[] = [];
    if (pulled?.downloaded) bits.push(`${pulled.downloaded} down`);
    if (pushed?.uploaded) bits.push(`${pushed.uploaded} up`);
    if (pulled?.deletedLocally) bits.push(`${pulled.deletedLocally} removed here`);
    if (pushed?.tombstoned) bits.push(`${pushed.tombstoned} deleted`);

    this.setStatus(bits.length ? `Nucleus: ${bits.join(", ")}` : "Nucleus: up to date");

    // Conflicts and failures are announced even on a quiet background pass: a
    // silently duplicated note is exactly the thing a person needs told.
    if (conflicts) {
      new Notice(
        `Nucleus kept both versions of ${conflicts} file(s). Yours were not changed — look for “(conflict …)”.`,
        8000,
      );
    }
    if (failed) {
      new Notice(`Nucleus could not transfer ${failed} file(s). Syncing again will retry them.`, 8000);
    }
    if (!quiet && !conflicts && !failed) {
      new Notice(bits.length ? `Nucleus: ${bits.join(", ")}` : "Nucleus: up to date");
    }
  }

  /**
   * Attached only after layout is ready — see the note at the top of the file
   * about `create` firing for the whole vault during indexing.
   */
  private registerChangeHandlers(): void {
    const schedule = debounce(
      () => {
        if (this.settings.syncOnChange && !this.applyingRemote) void this.syncNow({ quiet: true });
      },
      8000,
      true,
    );

    const onChange = (file: unknown) => {
      if (this.applyingRemote) return;
      if (file instanceof TFile && isExcluded(file.path)) return;
      schedule();
    };

    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("modify", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));
    this.registerEvent(this.app.vault.on("rename", onChange));
  }

  /**
   * `registerInterval` hands the timer to Obsidian, which clears it on unload —
   * so there is no manual teardown here, and no risk of a stale timer surviving
   * a plugin reload.
   */
  rescheduleTimer(): void {
    const minutes = this.settings.syncEveryMinutes;
    if (!minutes || minutes <= 0) return;
    this.registerInterval(
      window.setInterval(() => {
        if (this.configured && !this.syncing) void this.syncNow({ quiet: true });
      }, minutes * 60_000),
    );
  }
}
