import { App, FuzzySuggestModal, Modal, Setting, TFile, moment, Notice } from "obsidian";
import type { MergePreference } from "./types";

export class TwoFilePickerModal extends Modal {
  private onChoose: (a: TFile, b: TFile) => void;
  private fileA: TFile | null = null;
  private fileB: TFile | null = null;

  constructor(app: App, onChoose: (a: TFile, b: TFile) => void) {
    super(app);
    this.onChoose = onChoose;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Merge two notes" });

    const pick = async (slot: "A" | "B") => {
      const self = this;
      const files = this.app.vault.getMarkdownFiles().sort((x, y) => (x.basename.localeCompare(y.basename)));
      class Picker extends FuzzySuggestModal<TFile> {
        getItems(): TFile[] { return files; }
        getItemText(item: TFile): string {
          const m = moment(item.stat.mtime).format("YYYY-MM-DD HH:mm");
          return `${item.basename} — ${item.path} — m:${m}`;
        }
        onChooseItem(item: TFile): void {
          if (slot === "A") self.fileA = item; else self.fileB = item;
          new Notice(`Selected ${slot}: ${item.path}`);
          self.renderConfirm();
        }
      }
      new Picker(this.app).open();
    };

    new Setting(contentEl)
      .setName("First note")
      .addButton((b) => b.setButtonText("Pick A").onClick(() => pick("A")));

    new Setting(contentEl)
      .setName("Second note")
      .addButton((b) => b.setButtonText("Pick B").onClick(() => pick("B")));

    this.renderConfirm();
  }

  private renderConfirm() {
    const { contentEl } = this;
    const existing = contentEl.querySelector(".mn-confirm");
    if (existing) existing.detach();

    const box = contentEl.createDiv({ cls: "mn-confirm" });
    new Setting(box)
      .setDesc("When both are chosen, click Merge")
      .addButton((b) => b.setCta().setButtonText("Merge").setDisabled(!(this.fileA && this.fileB)).onClick(() => {
        if (this.fileA && this.fileB) {
          this.onChoose(this.fileA, this.fileB);
          this.close();
        }
      }));
  }
}

export class PreferenceModal extends Modal {
  private onChoose: (pref: MergePreference) => void;
  private pref: MergePreference;

  constructor(app: App, initial: MergePreference, onChoose: (pref: MergePreference) => void) {
    super(app);
    this.onChoose = onChoose;
    this.pref = initial;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Merge Preference" });
    contentEl.createEl("p", { text: "Choose merge order: Old Into New (default) or New Into Old." });

    new Setting(contentEl)
      .setName("Preference")
      .addDropdown((dd) => dd
        .addOptions({ "OLD_INTO_NEW": "Old Into New (default)", "NEW_INTO_OLD": "New Into Old" })
        .setValue(this.pref)
        .onChange((v) => (this.pref = v as MergePreference))
      );

    new Setting(contentEl)
      .addButton((b) => b.setCta().setButtonText("OK").onClick(() => { this.onChoose(this.pref); this.close(); }));
  }
}
