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

import { Notice, Platform, Plugin, TFile, debounce } from "obsidian";

import { NucleusClient } from "./client";
import { pull, push, syncBothWays, setAside, replaceLocal, verifyAndRepair, repairDates, isExcluded, type PassResult } from "./engine";
import { OnboardingModal, SET_ASIDE_FOLDER, type MergeChoice, type Situation } from "./onboarding";
import { DEFAULT_SETTINGS, NucleusSettingTab, type NucleusSettings } from "./settings";
import { listConfigFiles, statConfigFile } from "./config-sync";

export default class NucleusSyncPlugin extends Plugin {
  settings: NucleusSettings = { ...DEFAULT_SETTINGS };
  private client: NucleusClient | null = null;
  private syncing = false;
  /** True while WE are writing, so our own writes do not trigger another pass. */
  private applyingRemote = false;
  private statusEl: HTMLElement | null = null;
  /**
   * A live notice, for phones.
   *
   * `addStatusBarItem` does nothing on mobile — there is no status bar — so
   * every progress line built so far was written somewhere the owner could not
   * see it. On a phone the same text goes into a notice that stays up and is
   * rewritten as the sync moves, then closes when it finishes.
   */
  private liveNotice: Notice | null = null;
  /** Newest change we have already reacted to, so a poll only acts on news. */
  private lastSeenChange: string | null = null;
  /** What went wrong last, kept so it can be shown rather than only logged. */
  lastError: string | null = null;
  /** A plain-English account of the last pass. */
  lastReport: string | null = null;
  private lastSyncAt: Date | null = null;
  private outstanding = 0;
  private outstandingBytes = 0;
  private liveTimer: number | null = null;
  private periodicTimer: number | null = null;
  private configTimer: number | null = null;
  private configSnapshot: string | null = null;
  /** Server + vault that the in-memory reconciliation record belongs to. */
  private stateContext = "";
  /** A vault event arrived while a pass was suppressing its own writes. */
  private pendingLocalChange = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new NucleusSettingTab(this.app, this));

    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mod-clickable");
    // "Last sync failed" with no way to see the reason is not a message, it is
    // a shrug. Clicking now says what happened.
    this.statusEl.onClickEvent(() => new Notice(this.summary(), 15000));
    this.setStatus(this.configured ? "Nucleus: ready" : "Nucleus: not set up");

    this.addRibbonIcon("refresh-cw", "Sync with Nucleus", () => {
      // On a phone this is the only handle there is, so tapping it while a sync
      // is running should say how it is going rather than do nothing.
      if (this.syncing) new Notice(this.summary(), 10000);
      else void this.syncNow();
    });

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
    this.addCommand({
      id: "verify-and-repair",
      name: "Check for damaged files and repair (use after a sync was interrupted)",
      callback: () => void this.repair(),
    });
    this.addCommand({
      id: "repair-dates",
      name: "Restore original created and modified dates",
      callback: () => void this.fixDates(),
    });
    this.addCommand({
      id: "sync-status",
      name: "How is sync doing?",
      callback: () => new Notice(this.summary(), 15000),
    });
    this.addCommand({ id: "open-setup", name: "Open setup", callback: () => this.openOnboarding() });

    // Everything that depends on the vault being indexed waits for it.
    this.app.workspace.onLayoutReady(() => {
      this.registerChangeHandlers();
      this.rescheduleTimer();
      void this.captureConfigSnapshot();

      if (!this.settings.onboarded) {
        this.openOnboarding();
      } else if (this.settings.syncOnStartup && this.configured) {
        void this.syncNow({ quiet: true });
      }
    });
  }

  onunload(): void {
    this.clearTimers();
  }

  get configured(): boolean {
    return Boolean(this.settings.url && this.settings.key && this.settings.vaultName);
  }

  /**
   * What a person actually wants to know, in sentences.
   *
   * This used to report "120 down, 3 up", which is my bookkeeping, not an
   * answer — it says nothing about whether the vault is finished, when it last
   * worked, or what to do next.
   */
  /** What is happening this second, or null when idle. For the settings screen. */
  currentStatus(): string | null {
    return this.syncing ? (this.statusEl?.getText() || "Syncing…") : null;
  }

  summary(): string {
    if (!this.configured) return "Nucleus is not set up yet. Open Settings → Nucleus Vault Sync.";

    const when = this.lastSyncAt ? `Last synced ${this.ago(this.lastSyncAt)}.` : "Has not synced yet.";

    if (this.lastError) {
      return `Something went wrong.\n\n${this.lastError}\n\n${when} Syncing again will retry — nothing has been lost.`;
    }
    if (this.syncing) {
      return `Syncing now.\n\n${this.outstanding > 0 ? `${this.outstanding} files still to download (${this.mb(this.outstandingBytes)}).` : ""}`.trim();
    }
    if (this.outstanding > 0) {
      return (
        `Your notes are here. ${this.outstanding} attachment${this.outstanding === 1 ? "" : "s"} ` +
        `still to download — ${this.mb(this.outstandingBytes)}.\n\n` +
        `Leave Obsidian open and it will keep going. On iPhone and iPad it pauses when you ` +
        `switch away, and picks up when you come back.\n\n${when}`
      );
    }
    return `Everything is up to date.\n\n${when}${this.lastReport ? `\n\n${this.lastReport}` : ""}`;
  }

  private ago(then: Date): string {
    const secs = Math.round((Date.now() - then.getTime()) / 1000);
    if (secs < 60) return "just now";
    if (secs < 3600) return `${Math.round(secs / 60)} minute${Math.round(secs / 60) === 1 ? "" : "s"} ago`;
    return `${Math.round(secs / 3600)} hour${Math.round(secs / 3600) === 1 ? "" : "s"} ago`;
  }

  private mb(bytes: number): string {
    if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
    if (bytes >= 1_048_576) return `${Math.round(bytes / 1_048_576)} MB`;
    return `${Math.round(bytes / 1024)} KB`;
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(text);

    if (!Platform.isMobileApp) return;

    // Only hold a notice open while something is actually happening; an idle
    // "up to date" banner that never goes away is its own annoyance.
    const busy = this.syncing;
    if (!busy) {
      this.liveNotice?.hide();
      this.liveNotice = null;
      return;
    }
    if (!this.liveNotice) {
      // 0 = stays until hidden.
      this.liveNotice = new Notice(text, 0);
    } else {
      this.liveNotice.setMessage(text);
    }
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
    if (
      !this.settings.state ||
      typeof this.settings.state !== "object" ||
      Array.isArray(this.settings.state)
    ) {
      this.settings.state = {};
    }
    this.stateContext = this.connectionContext();
  }

  async saveSettings(): Promise<void> {
    const nextContext = this.connectionContext();
    if (this.stateContext && nextContext !== this.stateContext) {
      // A sync record is meaningful only for the exact server/vault pair that
      // produced it. Reusing it after switching vaults can turn unrelated
      // hashes into false agreement and make conflict decisions unsafe.
      this.settings.state = {};
    }
    this.stateContext = nextContext;
    await this.saveData(this.settings);
    this.client = null; // rebuilt on next use, so a changed key takes effect at once
  }

  private connectionContext(): string {
    return `${this.settings.url.trim().replace(/\/+$/, "")}\n${this.settings.vaultName.trim()}`;
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
      attachments: this.settings.attachments,
      attachmentLimitBytes: this.settings.attachmentLimitBytes,
      config: {
        enabled: this.settings.syncConfig,
        includeCaches: this.settings.syncPluginCaches,
      },
      log: (line: string) => {
        console.warn("[nucleus]", line);
        report?.(line);
      },
      onProgress: (done: number, total: number, what: string) => {
        // Percentage first: it is the number people actually read. The file
        // name follows because when one file takes minutes, the count alone
        // looks stalled.
        if (total <= 1) {
          // A phase announcement, not a file count — "0% · 0/1" would be worse
          // than useless here.
          this.setStatus(`Nucleus: ${what}`);
        } else {
          const pct = Math.floor((done / total) * 100);
          this.setStatus(`Nucleus ${pct}% · ${done}/${total} · ${what.split("/").pop() ?? what}`);
        }
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
      config: {
        enabled: this.settings.syncConfig,
        includeCaches: this.settings.syncPluginCaches,
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
      onRun: async (situation: Situation, mergeChoice: MergeChoice, report) => {
        const options = this.engineOptions(report);
        this.syncing = true;
        this.applyingRemote = true;
        try {
          let pulled: PassResult | null = null;
          let pushed: PassResult | null = null;

          let movedAside = 0;

          if (situation === "fresh") {
            // There may truly be nothing to transfer, but running a harmless
            // push also establishes state for any config file created between
            // the survey and this click.
            pushed = await push(options);
          } else if (situation === "restore") {
            // Only the part that makes the vault usable. The attachments —
            // which for this vault are 1.4 GB of video and none of the urgency —
            // continue after the dialog closes. Blocking setup on them meant
            // waiting twenty minutes before opening a single note, which is not
            // what "notes first" was supposed to mean.
            pulled = await pull({ ...options, only: "text" });
            this.finishAttachmentsInBackground();
          } else if (situation === "upload") {
            pushed = await push(options);
          } else if (mergeChoice === "replace") {
            report("Clearing this vault…");
            const cleared = await replaceLocal(this.app, report);
            movedAside = 0;
            this.settings.state = {};
            await this.saveSettings();
            report(`Removed ${cleared.removed}. Downloading your notes…`);
            pulled = await pull({ ...this.engineOptions(report), only: "text" });
            this.finishAttachmentsInBackground();
          } else if (mergeChoice === "set-aside") {
            // Move what is here out of the way FIRST, so the layer's copy lands
            // on an empty tree and no file ever has to be reconciled.
            report(`Moving ${SET_ASIDE_FOLDER}…`);
            const aside = await setAside(this.app, SET_ASIDE_FOLDER, report);
            movedAside = aside.moved;
            pulled = await pull({ ...options, only: "text" });
            // Attachments are intentionally still remote-only at this point;
            // absence during a notes-first restore must not delete them.
            pushed = await push({ ...options, deleteRemoteMissing: false });
            this.finishAttachmentsInBackground();
          } else if (mergeChoice === "upload-mine") {
            // Local wins: send everything up first, so anything that differs is
            // resolved in the vault's favour, then bring down what is missing.
            pushed = await push({ ...options, deleteRemoteMissing: false });
            pulled = await pull(options);
          } else {
            const both = await syncBothWays(options);
            pulled = both.pulled;
            pushed = both.pushed;
          }

          this.settings.onboarded = true;
          await this.saveSettings();
          await this.captureConfigSnapshot(true);

          const parts: string[] = [];
          if (movedAside) parts.push(`${movedAside} moved into "${SET_ASIDE_FOLDER}"`);
          if (pulled?.downloaded) parts.push(`${pulled.downloaded} downloaded`);
          if (pushed?.uploaded) parts.push(`${pushed.uploaded} uploaded`);
          if (pulled?.deletedLocally) parts.push(`${pulled.deletedLocally} removed here`);
          if (pushed?.tombstoned) parts.push(`${pushed.tombstoned} marked deleted`);
          if (!parts.length) parts.push("everything already matched");
          // Do not claim completeness while the heavy half is still queued.
          if (
            situation === "restore" ||
            (situation === "merge" &&
              (mergeChoice === "replace" || mergeChoice === "set-aside"))
          ) {
            parts.push("attachments continue in the background");
          }

          this.setStatus("Nucleus: ready");
          return {
            summary: parts.join(", ") + ".",
            conflicts: (pulled?.conflicts.length ?? 0) + (pushed?.conflicts.length ?? 0),
            failed: (pulled?.failed.length ?? 0) + (pushed?.failed.length ?? 0),
          };
        } finally {
          this.syncing = false;
          this.applyingRemote = false;
          this.flushPendingLocalChange();
        }
      },
    }).open();
  }

  /**
   * Carry on with the attachments once setup has handed the vault over.
   *
   * Deliberately not awaited: the point is that the dialog closes and the vault
   * opens. Failures are reported the same way a background sync's are, and
   * anything unfinished is simply picked up next time.
   */
  private finishAttachmentsInBackground(): void {
    window.setTimeout(() => {
      void (async () => {
        if (this.syncing) {
          // Setup may still be checkpointing its notes-first pass. Try again
          // instead of silently dropping the promised attachment continuation.
          this.finishAttachmentsInBackground();
          return;
        }
        this.syncing = true;
        this.applyingRemote = true;
        try {
          const result = await pull({ ...this.engineOptions(), only: "attachments" });
          this.announce(result, null, true);
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.setStatus("Nucleus: attachments unfinished — click for why");
        } finally {
          this.syncing = false;
          this.applyingRemote = false;
          await this.captureConfigSnapshot(true);
          this.liveNotice?.hide();
          this.liveNotice = null;
          this.flushPendingLocalChange();
        }
      })();
    }, 1500);
  }

  /** One command, one direction — for when the automatic choice is not what you want. */
  private async runOneWay(direction: "pull" | "push"): Promise<void> {
    if (!this.guard()) return;
    this.syncing = true;
    this.applyingRemote = true;
    try {
      const options = this.engineOptions();
      const result = direction === "pull" ? await pull(options) : await push(options);
      await this.captureConfigSnapshot(true);
      this.announce(direction === "pull" ? result : null, direction === "push" ? result : null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      new Notice(`Nucleus: ${message}`);
      this.setStatus("Nucleus: last sync failed — click for why");
    } finally {
      this.syncing = false;
      this.applyingRemote = false;
      this.flushPendingLocalChange();
    }
  }

  /** Put the original file dates back, for vaults downloaded before 0.12. */
  private async fixDates(): Promise<void> {
    if (!this.guard()) return;
    this.syncing = true;
    this.applyingRemote = true;
    this.setStatus("Nucleus: restoring dates…");
    try {
      const result = await repairDates(this.engineOptions());
      new Notice(
        result.fixed
          ? `Restored the original dates on ${result.fixed} file(s), out of ${result.checked} checked.`
          : `Checked ${result.checked} files — dates were already correct.`,
        10000,
      );
    } catch (error) {
      new Notice(`Nucleus: ${error instanceof Error ? error.message : String(error)}`, 12000);
    } finally {
      this.syncing = false;
      this.applyingRemote = false;
      this.setStatus("Nucleus: ready");
      this.flushPendingLocalChange();
    }
  }

  /** Find and remove half-written files, then sync so they come back whole. */
  private async repair(): Promise<void> {
    if (!this.guard()) return;
    this.syncing = true;
    this.applyingRemote = true;
    this.setStatus("Nucleus: checking…");
    try {
      const result = await verifyAndRepair(this.engineOptions());
      const damaged = result.corrupt.length;
      new Notice(
        damaged
          ? `Checked ${result.checked} files. Removed ${damaged} incomplete one(s); syncing now to fetch them again.`
          : `Checked ${result.checked} files — all complete. ${result.missing.length} still to download.`,
        8000,
      );
    } catch (error) {
      new Notice(`Nucleus: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.syncing = false;
      this.applyingRemote = false;
      this.flushPendingLocalChange();
    }
    await this.syncNow();
  }

  async syncNow({ quiet = false } = {}): Promise<void> {
    if (!this.guard(quiet)) return;
    this.syncing = true;
    this.applyingRemote = true;
    this.setStatus("Nucleus: syncing…");
    try {
      this.lastError = null;
      const { pulled, pushed } = await syncBothWays(this.engineOptions());
      // Our own writes moved the watermark; record it so the watcher does not
      // immediately see them as somebody else's news.
      this.lastSeenChange = await this.getClient().latestChange().catch(() => this.lastSeenChange);
      await this.captureConfigSnapshot(true);
      this.announce(pulled, pushed, quiet);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      // Always tell them, even on a quiet background pass — a silent failure
      // that only shows as three words in the status bar is how someone ends
      // up believing their notes are synced when they are not.
      new Notice(`Nucleus sync failed: ${message}`, 15000);
      console.error("[nucleus] sync failed", error);
      this.setStatus("Nucleus: failed — click to see why");
    } finally {
      this.syncing = false;
      this.applyingRemote = false;
      this.liveNotice?.hide();
      this.liveNotice = null;
      this.flushPendingLocalChange();
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
    if (pulled?.skipped) bits.push(`${pulled.skipped} files skipped by this device's settings`);

    this.lastSyncAt = new Date();
    this.outstanding = pulled?.outstanding ?? 0;
    this.outstandingBytes = pulled?.outstandingBytes ?? 0;

    // The status bar answers "am I done?", not "what did you just do?".
    this.setStatus(
      this.outstanding > 0
        ? `Nucleus: ${this.mb(this.outstandingBytes)} to go`
        : "Nucleus: up to date",
    );

    this.lastReport = bits.length
      ? `This sync: ${bits.join(", ")}.`
      : "Nothing had changed since last time.";

    // Conflicts and failures are announced even on a quiet background pass: a
    // silently duplicated note is exactly the thing a person needs told.
    if (conflicts) {
      new Notice(
        `Nucleus kept both versions of ${conflicts} file(s). Note conflicts are beside the original; settings/plugin conflicts are in “Nucleus Config Conflicts”.`,
        8000,
      );
    }
    if (failed) {
      const names = [...(pulled?.failed ?? []), ...(pushed?.failed ?? [])]
        .slice(0, 3)
        .map((f) => `${f.path}: ${f.reason}`)
        .join("\n");
      new Notice(
        `Nucleus could not transfer ${failed} file(s). Syncing again retries them.\n${names}`,
        15000,
      );
      this.lastError = names;
      this.setStatus("Nucleus: incomplete — click for details");
    }
    if (!quiet && !conflicts && !failed) {
      new Notice(
        this.outstanding > 0
          ? `Nucleus: notes are up to date. ${this.mb(this.outstandingBytes)} of attachments still downloading.`
          : bits.length
            ? `Nucleus: ${bits.join(", ")} — everything is up to date.`
            : "Nucleus: everything is already up to date.",
        6000,
      );
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
      // Two seconds, not eight: this is the delay before YOUR edit starts
      // travelling. Long enough that a burst of typing is one sync, short
      // enough that switching to your phone finds the change already there.
      2000,
      true,
    );

    const onChange = (file: unknown) => {
      if (this.applyingRemote) {
        // Most of these are our own pull writes, but one may be the user editing
        // during a long attachment transfer. A single cheap follow-up pass is
        // preferable to silently losing that event.
        this.pendingLocalChange = true;
        return;
      }
      if (file instanceof TFile && isExcluded(file.path)) return;
      schedule();
    };

    this.registerEvent(this.app.vault.on("create", onChange));
    this.registerEvent(this.app.vault.on("modify", onChange));
    this.registerEvent(this.app.vault.on("delete", onChange));
    this.registerEvent(this.app.vault.on("rename", onChange));
  }

  private flushPendingLocalChange(): void {
    if (!this.pendingLocalChange) return;
    this.pendingLocalChange = false;
    window.setTimeout(() => {
      if (this.syncing || this.applyingRemote) {
        this.pendingLocalChange = true;
        return;
      }
      if (this.configured) void this.syncNow({ quiet: true });
    }, 250);
  }

  /**
   * `registerInterval` hands the timer to Obsidian, which clears it on unload —
   * so there is no manual teardown here, and no risk of a stale timer surviving
   * a plugin reload.
   */
  /**
   * Watch for changes made elsewhere.
   *
   * A full sync every few seconds would be wasteful and slow; asking for the
   * newest `updated_at` is one small request (measured at under a second) and
   * almost always answers "nothing new". A real pass runs only when that value
   * moves, which is what makes this feel live without behaving like a poll.
   *
   * On iPhone and iPad the timer stops when Obsidian is backgrounded — iOS
   * suspends the app — so this catches up on return rather than running there.
   */
  rescheduleTimer(): void {
    this.clearTimers();

    if (this.settings.liveSync) {
      const seconds = Math.max(2, this.settings.liveIntervalSeconds || 5);
      this.liveTimer = window.setInterval(
        () => void this.checkForRemoteChanges(),
        seconds * 1000,
      );
    }

    // Hidden config files do not emit Vault create/modify events. A cheap
    // path/size/mtime snapshot supplies the missing watcher so plugin settings,
    // themes, hotkeys, and add-ons travel soon after they change too.
    if (this.settings.syncConfig) {
      this.configTimer = window.setInterval(
        () => void this.checkForLocalConfigChanges(),
        10_000,
      );
    }

    const minutes = this.settings.syncEveryMinutes;
    if (!minutes || minutes <= 0) return;
    this.periodicTimer = window.setInterval(() => {
        if (this.configured && !this.syncing) void this.syncNow({ quiet: true });
      }, minutes * 60_000);
  }

  private clearTimers(): void {
    if (this.liveTimer !== null) window.clearInterval(this.liveTimer);
    if (this.periodicTimer !== null) window.clearInterval(this.periodicTimer);
    if (this.configTimer !== null) window.clearInterval(this.configTimer);
    this.liveTimer = null;
    this.periodicTimer = null;
    this.configTimer = null;
  }

  private async configFingerprint(): Promise<string> {
    if (!this.settings.syncConfig) return "off";
    const options = {
      enabled: true,
      includeCaches: this.settings.syncPluginCaches,
    };
    const paths = await listConfigFiles(this.app, options);
    const parts: string[] = [];
    for (const path of paths) {
      const info = await statConfigFile(this.app, path);
      if (info) parts.push(`${path}\u0000${info.size}\u0000${info.mtime}`);
    }
    return parts.join("\n");
  }

  private async captureConfigSnapshot(scheduleIfChanged = false): Promise<void> {
    try {
      const previous = this.configSnapshot;
      const next = await this.configFingerprint();
      this.configSnapshot = next;
      if (scheduleIfChanged && previous !== null && previous !== next) {
        this.pendingLocalChange = true;
      }
    } catch {
      // A transient unreadable plugin folder will be retried by the timer.
    }
  }

  private async checkForLocalConfigChanges(): Promise<void> {
    if (!this.configured || this.syncing || this.applyingRemote || !this.settings.syncConfig) return;
    try {
      const next = await this.configFingerprint();
      if (this.configSnapshot === null) {
        this.configSnapshot = next;
        return;
      }
      if (next === this.configSnapshot) return;
      this.configSnapshot = next;
      await this.syncNow({ quiet: true });
    } catch {
      // The next poll retries. A config watcher should not spam notices merely
      // because one plugin was replacing a file at the instant we listed it.
    }
  }

  /** One cheap question: has anything in this vault changed since we last looked? */
  private async checkForRemoteChanges(): Promise<void> {
    if (!this.configured || this.syncing || this.applyingRemote) return;
    try {
      const latest = await this.getClient().latestChange();
      if (latest === this.lastSeenChange) return;
      this.lastSeenChange = latest;
      // Do not discard the first observation. Startup sync is optional, and if
      // it is disabled this may be the only chance to fetch edits made while
      // Obsidian was closed.
      if (latest !== null) await this.syncNow({ quiet: true });
    } catch {
      // A failed check is not worth telling anyone about — the next one is a
      // few seconds away, and a notice every five seconds on a flaky
      // connection would be its own bug.
    }
  }
}
