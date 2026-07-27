import { App, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import type { MergeNotesSettings, MergePreference } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import { PreferenceModal, TwoFilePickerModal } from "./ui";
import {
  normalizeBaseName, read, write, splitFrontmatter, findCodeFences,
  dedupeDataviewBlocks, reinsertBlocks, splitIntoSections, mergeSections, sectionsToMarkdown,
  buildFrontmatter
} from "./utils";

export default class MergeNotesPlugin extends Plugin {
  settings: MergeNotesSettings;

  async onload() {
    await this.loadSettings();

    this.addCommand({
      id: "merge-notes-pick-two",
      name: "Merge two notes…",
      callback: () => this.openManualMerge(),
    });

    this.registerEvent(this.app.vault.on("create", async (file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      if (!this.settings.autoMergeSameName) return;
      try {
        await this.tryAutoMergeOnCreate(file);
      } catch (e) {
        console.error("[Merge Notes] auto-merge failed", e);
      }
    }));

    this.addSettingTab(new MergeNotesSettingTab(this.app, this));
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private openManualMerge() {
    new TwoFilePickerModal(this.app, async (a, b) => {
      const pref = await this.askPreference();
      await this.mergePair(a, b, pref);
    }).open();
  }

  private askPreference(): Promise<MergePreference> {
    return new Promise((resolve) => {
      new PreferenceModal(this.app, this.settings.defaultPreference, resolve).open();
    });
  }

  private async tryAutoMergeOnCreate(file: TFile) {
    const folder = this.app.vault.getAbstractFileByPath(file.parent?.path || "");
    if (!folder) return;
    const siblings = this.app.vault.getMarkdownFiles().filter((f) => f.parent?.path === file.parent?.path);
    const targetKey = normalizeBaseName(file.basename);
    const dupes = siblings.filter((f) => normalizeBaseName(f.basename) === targetKey);
    if (dupes.length < 2) return; // no duplicates

    // Choose two: newest and oldest or just two first? We'll merge all pairwise into the newest (or depending on default)
    // Strategy: sort by mtime, determine preferred order per default setting, then fold-merge
    dupes.sort((a, b) => a.stat.mtime - b.stat.mtime); // oldest→newest

    let pref: MergePreference = this.settings.defaultPreference;

    // Reduce the list into one by merging sequentially
    let base = dupes[dupes.length - 1]; // newest as anchor
    for (let i = dupes.length - 2; i >= 0; i--) {
      const other = dupes[i];
      await this.mergePair(base, other, pref);
      // After merge, base remains; other is trashed
    }
  }

  private async mergePair(a: TFile, b: TFile, pref: MergePreference) {
    // Determine which is "old" vs "new"
    const oldFirst = a.stat.mtime <= b.stat.mtime ? { old: a, newer: b } : { old: b, newer: a };
    const old = oldFirst.old;
    const newer = oldFirst.newer;

    const preferred = (pref === "OLD_INTO_NEW") ? newer : old; // destination to keep
    const secondary = (pref === "OLD_INTO_NEW") ? old : newer; // source to merge from

    const preferredRaw = await read(this.app, preferred);
    const secondaryRaw = await read(this.app, secondary);

    // Frontmatter handling
    const prefCache = this.app.metadataCache.getFileCache(preferred) || {} as any;
    const secCache = this.app.metadataCache.getFileCache(secondary) || {} as any;
    const prefFront = (prefCache as any).frontmatter || {};
    const secFront = (secCache as any).frontmatter || {};

    const { front: prefFrontRaw, body: prefBody0 } = splitFrontmatter(preferredRaw);
    const { front: secFrontRaw, body: secBody0 } = splitFrontmatter(secondaryRaw);

    // Dataview blocks handling (before heading merge):
    const prefBlocks = findCodeFences(prefBody0);
    const secBlocks = findCodeFences(secBody0);

    const chooseSecondary = (viewKey: string): boolean => {
      // Keep the dv.view block from the most recently updated note
      return secondary.stat.mtime > preferred.stat.mtime;
    };

    const { keptPrimary, keptSecondary } = dedupeDataviewBlocks(prefBlocks.blocks, secBlocks.blocks, chooseSecondary);

    // Rebuild bodies WITHOUT code fences first
    const prefBodyNoBlocks = prefBlocks.stripped;
    const secBodyNoBlocks = secBlocks.stripped;

    // Merge sections / headings
    const prefSections = splitIntoSections(prefBodyNoBlocks);
    const secSections = splitIntoSections(secBodyNoBlocks);
    const mergedSections = mergeSections(prefSections, secSections);
    let mergedBody = sectionsToMarkdown(mergedSections).trim();

    // Re-insert blocks: tokens were from preferred only; secondary kept blocks append at end
    mergedBody = reinsertBlocks(mergedBody, keptPrimary, keptSecondary).trim() + "\n";

    // Rebuild frontmatter: keep title/date from preferred; merge aliases/tags (dedup)
    const rebuiltFront = buildFrontmatter(prefFrontRaw ?? "---\n---\n", prefFront, secFront);

    const final = `${rebuiltFront}${mergedBody}`;

    await write(this.app, preferred, final);

    if (this.settings.trashSecondaryAfterMerge) {
      await this.app.vault.trash(secondary, true);
    }

    new Notice(`Merged into: ${preferred.path}`);
  }
}

class MergeNotesSettingTab extends import("obsidian").PluginSettingTab {
  plugin: MergeNotesPlugin;
  constructor(app: App, plugin: MergeNotesPlugin) { super(app, plugin); this.plugin = plugin; }
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Merge Notes — Settings" });

    new import("obsidian").Setting(containerEl)
      .setName("Auto-merge same-name duplicates")
      .setDesc("When a note is created that duplicates an existing name (normalized) in the same folder, merge automatically.")
      .addToggle((t) => t.setValue(this.plugin.settings.autoMergeSameName).onChange(async (v) => {
        this.plugin.settings.autoMergeSameName = v; await this.plugin.saveSettings();
      }));

    new import("obsidian").Setting(containerEl)
      .setName("Default preference")
      .setDesc("Default merge order when not explicitly chosen.")
      .addDropdown((dd) => dd
        .addOptions({ "OLD_INTO_NEW": "Old Into New", "NEW_INTO_OLD": "New Into Old" })
        .setValue(this.plugin.settings.defaultPreference)
        .onChange(async (v) => { this.plugin.settings.defaultPreference = v as MergePreference; await this.plugin.saveSettings(); }));

    new import("obsidian").Setting(containerEl)
      .setName("Trash secondary after merge")
      .setDesc("Move the non-preferred note to system trash after a successful merge.")
      .addToggle((t) => t.setValue(this.plugin.settings.trashSecondaryAfterMerge).onChange(async (v) => {
        this.plugin.settings.trashSecondaryAfterMerge = v; await this.plugin.saveSettings();
      }));

    new import("obsidian").Setting(containerEl)
      .setName("Verbose console logs")
      .setDesc("Print extra details to developer console for troubleshooting.")
      .addToggle((t) => t.setValue(this.plugin.settings.logToConsole).onChange(async (v) => {
        this.plugin.settings.logToConsole = v; await this.plugin.saveSettings();
      }));
  }
}
