export type MergePreference = "OLD_INTO_NEW" | "NEW_INTO_OLD";

export interface MergeNotesSettings {
  autoMergeSameName: boolean; // auto-merge files of same (normalized) name in same folder
  defaultPreference: MergePreference; // default = OLD_INTO_NEW
  trashSecondaryAfterMerge: boolean; // move the secondary file to trash after merge
  logToConsole: boolean; // verbose logging for troubleshooting
}

export const DEFAULT_SETTINGS: MergeNotesSettings = {
  autoMergeSameName: true,
  defaultPreference: "OLD_INTO_NEW",
  trashSecondaryAfterMerge: true,
  logToConsole: false,
};
