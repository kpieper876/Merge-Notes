# Merge Notes (Obsidian Plugin)

Combine two notes into one with smart merging rules:

- **Automatic:** If two notes with the same normalized name exist in the same folder, merges automatically.
- **Manual:** Command palette → "Merge two notes…" to pick any two files.
- **Preference Prompt:** choose **Old Into New** (default) or **New Into Old** to decide destination/source.
- **Dataview blocks:**
  - `dataview` fences duplicated across the notes ⇒ keep only one (prefer destination note)
  - `dataviewjs` fences using `dv.view("path")` ⇒ keep the block from the **most recently updated** note
- **Headings:** if both notes share a heading with the same text, lines and blocks from the source are appended under the destination’s heading (deduping identical lines).
- **Frontmatter:** keep `title` and `date` from the destination (preferred). Append/merge `aliases` and `tags`, deduplicated.
- **Titles & date not merged** per request.

## Install (development)
1. Put these files in a folder like: `.obsidian/plugins/merge-notes`
2. `npm i`
3. `npm run build` (or `npm run dev` to watch)
4. Enable **Merge Notes** in Obsidian → Settings → Community plugins

## Notes
- "Same name" detection normalizes common duplicate suffixes like `" (1)"`, `" - Copy"`, and Obsidian Sync conflict titles.
- After merge, the non-preferred file is moved to system trash (configurable).
- This plugin avoids heavy parsers for speed; heading matches are exact (case-sensitive). Adjust as needed.
