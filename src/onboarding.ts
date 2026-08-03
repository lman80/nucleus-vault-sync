/**
 * onboarding — the first-run wizard.
 *
 * Setting up sync is the moment with the most ways to lose work and the least
 * context for the person doing it. So this does not ask the user to know which
 * direction they want. It looks at what is actually in the vault and what is
 * actually in the layer, works out which of four situations they are in, says
 * in plain words what is about to happen, and does nothing until they agree.
 *
 *                        │ layer is empty        │ layer has files
 *   ─────────────────────┼───────────────────────┼──────────────────────────
 *    vault is empty      │ FRESH  nothing to do  │ RESTORE  download it all
 *    vault has files     │ UPLOAD send it all up │ MERGE    careful, both sides
 *
 * MERGE is the only dangerous one, and it is the one people reach by accident:
 * a second device, or a vault restored from a backup. There, nothing is
 * overwritten — anything that differs is written beside the original as a
 * conflict copy and the user decides. That is enforced in `decide()`, not here.
 */

import { App, Modal, Notice, Setting } from "obsidian";

import type { NucleusClient } from "./client";
import { vaultFiles } from "./engine";

export type Situation = "fresh" | "upload" | "restore" | "merge";

/** How to resolve a first sync where both sides already have files. */
export type MergeChoice = "set-aside" | "side-by-side" | "upload-mine";

/** Where set-aside puts what was already here. */
export const SET_ASIDE_FOLDER = "Before Nucleus";

export interface Survey {
  situation: Situation;
  vaultFileCount: number;
  layerFileCount: number;
}

/** Look at both sides and work out where we are. No side effects. */
export async function survey(app: App, client: NucleusClient): Promise<Survey> {
  const local = vaultFiles(app).length;
  const rows = await client.listDocumentsSlim();
  const remote = rows.filter((r) => !r.deleted_at).length;

  let situation: Situation;
  if (local === 0 && remote === 0) situation = "fresh";
  else if (local > 0 && remote === 0) situation = "upload";
  else if (local === 0 && remote > 0) situation = "restore";
  else situation = "merge";

  return { situation, vaultFileCount: local, layerFileCount: remote };
}

/** What we are about to do, in words the user can check against their intent. */
export function explain(s: Survey): { heading: string; body: string[]; confirm: string } {
  switch (s.situation) {
    case "fresh":
      return {
        heading: "Nothing to move yet",
        body: [
          "This vault is empty and so is your Nucleus.",
          "That is fine — sync is set up. Write a note and it will go up on the next sync.",
        ],
        confirm: "Finish",
      };

    case "upload":
      return {
        heading: `Send ${s.vaultFileCount} files up to your Nucleus`,
        body: [
          `Your Nucleus has nothing in it yet, and this vault has ${s.vaultFileCount} files.`,
          "Everything here will be copied up. Nothing in this vault will be changed, moved or deleted.",
          "Large attachments can take a while the first time. It is safe to stop and run it again — it picks up where it left off.",
        ],
        confirm: "Upload my vault",
      };

    case "restore":
      return {
        heading: `Download ${s.layerFileCount} files into this vault`,
        body: [
          `This vault is empty and your Nucleus holds ${s.layerFileCount} files.`,
          "They will be downloaded here, in their original folders.",
          "This is the normal way to set up a new device, or a fresh vault folder on a Mac you already sync from.",
          "Nothing in your Nucleus is changed by this.",
        ],
        confirm: "Download my vault",
      };

    case "merge":
    default:
      return {
        heading: "Both sides already have files",
        body: [
          `This vault has ${s.vaultFileCount} file${s.vaultFileCount === 1 ? "" : "s"} and your Nucleus has ${s.layerFileCount}.`,
          "Choose what to do with what is already here. Nothing is deleted in any of these.",
        ],
        confirm: "Continue",
      };
  }
}

interface WizardCallbacks {
  onConnect: (url: string, key: string, vaultName: string) => Promise<{ ok: boolean; message: string }>;
  onRun: (
    situation: Situation,
    mergeChoice: MergeChoice,
    report: (line: string) => void,
  ) => Promise<{ summary: string; conflicts: number; failed: number }>;
  makeClient: (url: string, key: string, vaultName: string) => NucleusClient;
  defaults: { url: string; key: string; vaultName: string };
}

/**
 * The wizard itself. Three screens: connect, confirm, run — and it will not
 * advance past connect until the server has actually answered.
 */
export class OnboardingModal extends Modal {
  private url: string;
  private key: string;
  private vaultName: string;
  private surveyed: Survey | null = null;
  private mergeChoice: MergeChoice = "set-aside";
  private vaults: { name: string; files: number }[] = [];
  /** What testConnection said the layer holds — the cross-check on the list. */
  private layerTotal = 0;
  private listError: string | null = null;
  private busy = false;

  constructor(app: App, private cb: WizardCallbacks) {
    super(app);
    this.url = cb.defaults.url;
    this.key = cb.defaults.key;
    this.vaultName = cb.defaults.vaultName || app.vault.getName();
  }

  onOpen(): void {
    this.renderConnect();
  }

  private reset(): HTMLElement {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("nucleus-onboarding");
    return contentEl;
  }

  /** Screen 1 — where your Nucleus is, and the key to get in. */
  private renderConnect(): void {
    const el = this.reset();
    el.createEl("h2", { text: "Connect this vault to your Nucleus" });
    el.createEl("p", {
      text:
        "Your Nucleus is the database you own. This vault will be stored there — " +
        "instead of, or as well as, anywhere else.",
    });

    new Setting(el)
      .setName("Nucleus address")
      .setDesc("Where your Nucleus answers, e.g. https://your-nucleus.example")
      .addText((t) =>
        t
          .setPlaceholder("https://…")
          .setValue(this.url)
          .onChange((v) => (this.url = v.trim().replace(/\/+$/, ""))),
      );

    new Setting(el)
      .setName("Key")
      .setDesc("The credential your Nucleus issued. Stored in this vault's plugin folder in plain text.")
      .addText((t) => {
        t.setPlaceholder("paste your key").setValue(this.key).onChange((v) => (this.key = v.trim()));
        t.inputEl.type = "password";
      });


    const status = el.createEl("p", { cls: "nucleus-status" });

    new Setting(el).addButton((b) =>
      b
        .setButtonText("Connect")
        .setCta()
        .onClick(async () => {
          if (this.busy) return;
          if (!this.url || !this.key) {
            status.setText("Fill in both boxes first.");
            return;
          }
          this.busy = true;
          status.setText("Checking…");
          try {
            const test = await this.cb.onConnect(this.url, this.key, this.vaultName);
            if (!test.ok) {
              status.setText(test.message);
              return;
            }
            status.setText("Connected. Looking at what is already in your Nucleus…");
            // testConnection reports a total; keep it, because an empty vault
            // list next to a non-zero total means the LIST failed — not that
            // the Nucleus is empty. Believing the empty list is how the first
            // version offered to start a new vault on top of 674 real files.
            this.layerTotal = Number(/(\d+)\s+document/.exec(test.message)?.[1] ?? 0);
            this.listError = null;
            try {
              this.vaults = await this.cb.makeClient(this.url, this.key, "").listVaults();
            } catch (error) {
              this.vaults = [];
              this.listError = error instanceof Error ? error.message : String(error);
            }
            this.renderPickVault();
          } catch (error) {
            status.setText(error instanceof Error ? error.message : String(error));
          } finally {
            this.busy = false;
          }
        }),
    );
  }


  /**
   * Screen 2 — which vault, chosen from what is actually there.
   *
   * The first version asked the user to TYPE a vault name and warned that it
   * had to match on every device. That was a bad design: the requirement is
   * invisible, a stray space or capital breaks it, and the symptom is "sync
   * does nothing" rather than anything that points at a typo. Showing the
   * list removes the requirement instead of explaining it.
   */
  private renderPickVault(): void {
    const el = this.reset();
    el.createEl("h2", { text: "Which notes should this vault hold?" });

    const folder = this.app.vault.getName();

    // An empty list when the layer says it holds documents is a fault, and
    // must never be presented as "your Nucleus is empty".
    if (this.vaults.length === 0 && (this.layerTotal > 0 || this.listError)) {
      el.createEl("h2", { text: "Could not read your vault list" });
      el.createEl("p", {
        text:
          this.layerTotal > 0
            ? `Your Nucleus reports ${this.layerTotal} documents, but the list of vaults came back empty. ` +
              `Something is wrong with reading it — do NOT continue, or you would start a second, empty vault ` +
              `alongside your real one.`
            : "The list of vaults could not be read.",
      });
      if (this.listError) el.createEl("pre", { text: this.listError, cls: "nucleus-log" });

      let typed = "";
      new Setting(el)
        .setName("Or type the vault name")
        .setDesc("If you know it, you can enter it directly and carry on.")
        .addText((t) => t.setPlaceholder("exact vault name").onChange((v) => (typed = v.trim())));
      new Setting(el)
        .addButton((b) => b.setButtonText("Back").onClick(() => this.renderConnect()))
        .addButton((b) =>
          b.setButtonText("Use that name").onClick(() => { if (typed) void this.chooseVault(typed); }),
        );
      return;
    }

    if (this.vaults.length === 0) {
      el.createEl("p", {
        text: "Your Nucleus has no vaults in it yet, so this will start a new one.",
      });
      let proposed = folder;
      new Setting(el)
        .setName("Call it")
        .setDesc("You can change this later. It is only a label inside your Nucleus.")
        .addText((t) => t.setValue(proposed).onChange((v) => (proposed = v.trim() || folder)));
      new Setting(el)
        .addButton((b) => b.setButtonText("Back").onClick(() => this.renderConnect()))
        .addButton((b) =>
          b.setButtonText("Continue").setCta().onClick(() => void this.chooseVault(proposed)),
        );
      return;
    }

    el.createEl("p", {
      text:
        this.vaults.length === 1
          ? "Your Nucleus holds one vault. This folder will sync with it."
          : "Pick the one this folder should sync with.",
    });

    for (const v of this.vaults) {
      new Setting(el)
        .setName(v.name)
        .setDesc(`${v.files} file${v.files === 1 ? "" : "s"}`)
        .addButton((b) =>
          b
            .setButtonText("Use this")
            .setCta()
            .onClick(() => void this.chooseVault(v.name)),
        );
    }

    // Deliberately understated and last. In the first version this sat level
    // with the real vaults, pre-filled with the folder name — and got clicked,
    // which started an empty second vault beside 674 real files. A destructive
    // choice should not look like the obvious one.
    const other = el.createEl("details", { cls: "nucleus-secondary" });
    other.createEl("summary", { text: "Not one of these?" });
    other.createEl("p", {
      text:
        `Starting a separate vault means these notes will NOT be downloaded. ` +
        `Only do this if you want a second, unrelated set of notes.`,
    });
    new Setting(other)
      .setName(`Start a new vault called "${folder}"`)
      .addButton((b) => b.setButtonText("Start separate").setWarning().onClick(() => void this.chooseVault(folder)));

    new Setting(el).addButton((b) => b.setButtonText("Back").onClick(() => this.renderConnect()));
  }

  private async chooseVault(name: string): Promise<void> {
    this.vaultName = name;
    const el = this.reset();
    el.createEl("h2", { text: "Checking…" });
    el.createEl("p", { text: `Comparing this folder with "${name}".` });
    try {
      await this.cb.onConnect(this.url, this.key, this.vaultName);
      this.surveyed = await survey(this.app, this.cb.makeClient(this.url, this.key, this.vaultName));
      this.renderConfirm();
    } catch (error) {
      el.createEl("p", { text: error instanceof Error ? error.message : String(error) });
      new Setting(el).addButton((b) => b.setButtonText("Back").onClick(() => this.renderPickVault()));
    }
  }


  /**
   * The merge chooser.
   *
   * The first version had no choice in it: every differing file got a
   * "(conflict)" twin scattered through the tree. Safe, and awful to live with
   * — you are left untangling a vault note by note. The default now is the
   * thing most people actually want: put what was here into one folder, and let
   * the Nucleus copy arrive clean.
   */
  private renderMergeChoice(): void {
    const el = this.reset();
    const s = this.surveyed!;
    el.createEl("h2", { text: "Both sides already have files" });
    el.createEl("p", {
      text: `This vault has ${s.vaultFileCount} file${s.vaultFileCount === 1 ? "" : "s"}. Your Nucleus has ${s.layerFileCount}.`,
    });
    el.createEl("p", { text: "Nothing is deleted in any of these options." });

    new Setting(el)
      .setName(`Put what is here into a "${SET_ASIDE_FOLDER}" folder  ·  recommended`)
      .setDesc(
        `Everything currently in this vault moves into a folder called "${SET_ASIDE_FOLDER}", ` +
          `keeping its structure. Then your ${s.layerFileCount} files download normally. ` +
          `You end up with your Nucleus notes where they belong, and the old contents in one ` +
          `tidy place you can look through or delete.`,
      )
      .addButton((b) =>
        b.setButtonText("Do this").setCta().onClick(() => { this.mergeChoice = "set-aside"; this.renderRun(); }),
      );

    new Setting(el)
      .setName("Keep both, side by side")
      .setDesc(
        "Files that match are left alone. Files that differ keep BOTH versions — yours untouched, " +
          "the Nucleus one saved next to it marked “(conflict …)”. Safest, messiest.",
      )
      .addButton((b) =>
        b.setButtonText("Do this").onClick(() => { this.mergeChoice = "side-by-side"; this.renderRun(); }),
      );

    new Setting(el)
      .setName("Send mine up instead")
      .setDesc(
        `Treat this vault as the true copy and upload it. Files in your Nucleus that are not here ` +
          `are still downloaded — nothing is removed from your Nucleus.`,
      )
      .addButton((b) =>
        b.setButtonText("Do this").onClick(() => { this.mergeChoice = "upload-mine"; this.renderRun(); }),
      );

    new Setting(el).addButton((b) => b.setButtonText("Back").onClick(() => this.renderPickVault()));
  }

  /** Screen 3 — what is about to happen, before it happens. */
  private renderConfirm(): void {
    if (!this.surveyed) return this.renderConnect();
    const plan = explain(this.surveyed);
    const el = this.reset();

    el.createEl("h2", { text: plan.heading });
    el.createEl("p", {
      text: `Vault in your Nucleus: “${this.vaultName}”`,
      cls: "nucleus-chosen",
    });

    // The check that would have caught the wrong pick immediately: about to
    // create a vault that does not exist, while other vaults do.
    const known = this.vaults.some((v) => v.name === this.vaultName);
    if (!known && this.vaults.length > 0) {
      const warn = el.createEl("div", { cls: "nucleus-warning" });
      warn.createEl("p", {
        text: `⚠ “${this.vaultName}” is NOT one of the vaults already in your Nucleus.`,
      });
      warn.createEl("p", {
        text:
          `This will start a brand new, separate vault. Your existing notes will not be ` +
          `downloaded here. Did you mean ${this.vaults.map((v) => `“${v.name}”`).join(" or ")}?`,
      });
      new Setting(warn).addButton((b) =>
        b.setButtonText("Go back and pick").setCta().onClick(() => this.renderPickVault()),
      );
    }
    for (const line of plan.body) el.createEl("p", { text: line });

    if (this.surveyed.situation === "merge") {
      el.createEl("p", {
        text: "Nothing you have written will be replaced by this.",
        cls: "nucleus-reassure",
      });
    }

    new Setting(el)
      .addButton((b) => b.setButtonText("Back").onClick(() => this.renderPickVault()))
      .addButton((b) =>
        b
          .setButtonText(plan.confirm)
          .setCta()
          .onClick(() => {
            if (this.surveyed!.situation === "fresh") {
              new Notice("Nucleus sync is set up.");
              this.close();
              return;
            }
            if (this.surveyed!.situation === "merge") {
              this.renderMergeChoice();
              return;
            }
            this.renderRun();
          }),
      );
  }

  /** Screen 3 — do it, saying what it is doing while it does. */
  private async renderRun(): Promise<void> {
    const el = this.reset();
    el.createEl("h2", { text: "Working…" });
    const line = el.createEl("p", { text: "Starting" });
    const detail = el.createEl("pre", { cls: "nucleus-log" });

    const report = (text: string) => {
      line.setText(text);
      detail.setText((detail.getText() + "\n" + text).split("\n").slice(-8).join("\n"));
    };

    try {
      const outcome = await this.cb.onRun(this.surveyed!.situation, this.mergeChoice, report);
      el.empty();
      el.createEl("h2", { text: "Done" });
      el.createEl("p", { text: outcome.summary });

      if (outcome.conflicts > 0) {
        el.createEl("p", {
          text:
            `${outcome.conflicts} file(s) differed on both sides. Yours were left exactly as they were, ` +
            `and the Nucleus versions are saved beside them with “(conflict …)” in the name.`,
        });
      }
      if (outcome.failed > 0) {
        el.createEl("p", {
          text: `${outcome.failed} file(s) could not be transferred. Run sync again to retry just those.`,
        });
      }

      new Setting(el).addButton((b) => b.setButtonText("Close").setCta().onClick(() => this.close()));
    } catch (error) {
      el.empty();
      el.createEl("h2", { text: "That did not finish" });
      el.createEl("p", { text: error instanceof Error ? error.message : String(error) });
      el.createEl("p", {
        text: "Nothing was lost. Run sync again when you are ready — it continues from where it stopped.",
      });
      new Setting(el).addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
