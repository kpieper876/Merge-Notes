import { App, TFile } from "obsidian";

export function normalizeBaseName(name: string): string {
  // Remove common conflict/duplicate suffixes e.g., " (1)", " - Copy", " (conflict YYYY-MM-DD)"
  return name
    .replace(/\s*\(\d+\)$/i, "")
    .replace(/\s*-\s*copy$/i, "")
    .replace(/\s*\(conflict[^)]*\)$/i, "")
    .trim()
    .toLowerCase();
}

export async function read(app: App, file: TFile): Promise<string> {
  return app.vault.read(file);
}

export async function write(app: App, file: TFile, data: string): Promise<void> {
  return app.vault.modify(file, data);
}

export function splitFrontmatter(raw: string): { front: string | null; body: string } {
  const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
  if (m) {
    return { front: m[0], body: raw.slice(m[0].length) };
  }
  return { front: null, body: raw };
}

export function parseYamlArrays(front: any): { aliases: string[]; tags: string[] } {
  const aliases = Array.isArray(front?.aliases)
    ? front.aliases.map((s: any) => String(s))
    : typeof front?.aliases === "string"
      ? [front.aliases]
      : [];
  // tags may be an array or a space-tag string like '#a #b'
  let tags: string[] = [];
  if (Array.isArray(front?.tags)) tags = front.tags.map((t: any) => String(t));
  else if (typeof front?.tags === "string") tags = front.tags.split(/\s+/).filter(Boolean);
  return { aliases, tags };
}

export function buildFrontmatter(fromPreferredRaw: string, preferredFront: any, otherFront: any): string {
  // Keep title & date from preferred. Merge aliases/tags.
  const pref = preferredFront || {};
  const oth = otherFront || {};

  const { aliases: a1, tags: t1 } = parseYamlArrays(pref);
  const { aliases: a2, tags: t2 } = parseYamlArrays(oth);

  const aliases = Array.from(new Set([...a1, ...a2])).filter(Boolean);
  const tags = Array.from(new Set([...t1, ...t2])).filter(Boolean);

  // Rebuild YAML by replacing aliases/tags lines while preserving other keys from preferred
  // Simple approach: parse existing YAML block lines, keep existing except aliases/tags/title/date
  const lines = fromPreferredRaw.split(/\r?\n/);
  const body: string[] = [];
  let inYaml = false;
  for (const line of lines) {
    if (!inYaml && line.trim() === "---") { inYaml = true; body.push(line); continue; }
    if (inYaml && line.trim() === "---") { body.push(line); inYaml = false; continue; }
    if (inYaml) {
      if (/^\s*(aliases|alias):/i.test(line)) continue;
      if (/^\s*tags:/i.test(line)) continue;
      if (/^\s*title:/i.test(line)) continue; // do not touch, but we'll keep the preferred one as-is by skipping here
      if (/^\s*date:/i.test(line)) continue;  // same for date
      body.push(line);
    } else {
      body.push(line);
    }
  }
  // Insert our fields just before the closing '---' of YAML (or recreate if none)
  const start = body.indexOf("---");
  const end = body.lastIndexOf("---");
  if (start !== -1 && end !== -1 && end > start) {
    const head = body.slice(0, start + 1);
    const yamlBetween = body.slice(start + 1, end);
    const tail = body.slice(end);

    // Pull original title/date from preferredFront if present
    const titleLine = pref?.title != null ? `title: ${String(pref.title)}` : null;
    const dateLine = pref?.date != null ? `date: ${String(pref.date)}` : null;
    const aliasLines = aliases.length ? ["aliases:", ...aliases.map((a) => `  - ${a}`)] : [];
    const tagLines = tags.length ? ["tags:", ...tags.map((t) => `  - ${t}`)] : [];

    const rebuilt = [
      ...head,
      ...(titleLine ? [titleLine] : []),
      ...(dateLine ? [dateLine] : []),
      ...yamlBetween,
      ...aliasLines,
      ...tagLines,
      ...tail,
    ];
    return rebuilt.join("\n");
  }
  // No YAML originally → create one
  const yaml: string[] = ["---"];
  if (preferredFront?.title) yaml.push(`title: ${String(preferredFront.title)}`);
  if (preferredFront?.date) yaml.push(`date: ${String(preferredFront.date)}`);
  if (aliases.length) {
    yaml.push("aliases:");
    for (const a of aliases) yaml.push(`  - ${a}`);
  }
  if (tags.length) {
    yaml.push("tags:");
    for (const t of tags) yaml.push(`  - ${t}`);
  }
  yaml.push("---", "");
  return yaml.join("\n");
}

export function findCodeFences(body: string): { blocks: CodeBlock[]; stripped: string } {
  const blocks: CodeBlock[] = [];
  const regex = /```(dataviewjs|dataview)([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  let stripped = "";
  while ((m = regex.exec(body)) !== null) {
    const lang = m[1];
    const code = m[2];
    const start = m.index;
    const end = regex.lastIndex;
    const before = body.slice(lastIndex, start);
    stripped += before + `@@BLOCK_${blocks.length}@@`;
    blocks.push({ lang, code: code, raw: m[0] });
    lastIndex = end;
  }
  stripped += body.slice(lastIndex);
  return { blocks, stripped };
}

export interface CodeBlock { lang: "dataview" | "dataviewjs"; code: string; raw: string; }

export function dvjsViewKey(block: CodeBlock): string | null {
  if (block.lang !== "dataviewjs") return null;
  const m = block.code.match(/dv\.view\((['"])(.*?)\1/);
  return m ? m[2] : null; // e.g., Dataview-Scripts/bulleted-referring-notes-concise
}

export function dedupeDataviewBlocks(
  primaryBlocks: CodeBlock[],
  secondaryBlocks: CodeBlock[],
  chooseSecondaryBlock: (viewKey: string) => boolean
): { keptPrimary: CodeBlock[]; keptSecondary: CodeBlock[] } {
  // dataview (non-JS): if duplicate (exact raw) across both, keep only one (prefer primary)
  // dataviewjs with dv.view("path"): keep only one per view path, choose from secondary iff chooseSecondaryBlock(viewKey) returns true
  const seenDv = new Set<string>();
  const seenDvJs = new Map<string, "primary" | "secondary">();

  const keptPrimary: CodeBlock[] = [];
  const keptSecondary: CodeBlock[] = [];

  // pass 1: decide primary keeps
  for (const b of primaryBlocks) {
    if (b.lang === "dataview") {
      if (seenDv.has(b.raw)) continue; // duplicate in primary (rare)
      seenDv.add(b.raw);
      keptPrimary.push(b);
    } else {
      const key = dvjsViewKey(b);
      if (!key) { keptPrimary.push(b); continue; }
      if (seenDvJs.has(key)) continue;
      // tentatively keep primary; may be overridden if chooseSecondaryBlock says so and secondary has same key
      seenDvJs.set(key, "primary");
      keptPrimary.push(b);
    }
  }

  // pass 2: decide secondary keeps, possibly overriding dvjs choice
  for (const b of secondaryBlocks) {
    if (b.lang === "dataview") {
      if (seenDv.has(b.raw)) continue; // duplicate across notes → drop secondary
      seenDv.add(b.raw);
      keptSecondary.push(b);
    } else {
      const key = dvjsViewKey(b);
      if (!key) { keptSecondary.push(b); continue; }
      const existing = seenDvJs.get(key);
      if (!existing) {
        seenDvJs.set(key, "secondary");
        keptSecondary.push(b);
      } else if (existing === "primary") {
        if (chooseSecondaryBlock(key)) {
          // replace: drop primary version of this key
          // mark map as secondary; actual replacement of primary will be handled by caller when stitching text
          seenDvJs.set(key, "secondary");
          keptSecondary.push(b);
        } // else: keep primary, drop this secondary
      }
    }
  }

  return { keptPrimary, keptSecondary };
}

export function reinsertBlocks(template: string, keptPrimary: CodeBlock[], keptSecondary: CodeBlock[]): string {
  // Replace tokens @@BLOCK_i@@ in order with kept blocks from primary first, then append secondary blocks at their tokens
  // Our tokenization used indices local to each body; we need a strategy:
  // Simpler: Just stitch: template already contains tokens from the primary body only.
  // We'll replace tokens with the corresponding keptPrimary blocks; then append any keptSecondary blocks at the end in the order they appeared.
  let out = template;
  keptPrimary.forEach((b, i) => {
    out = out.replace(`@@BLOCK_${i}@@`, `\n\n\`${"```"}${b.lang}\n${b.code}\n\`${"```"}\n\n`);
  });
  // If any unmatched tokens remain (because some primary blocks were dropped), remove them
  out = out.replace(/@@BLOCK_\d+@@/g, "");
  // Append secondary kept blocks at the end
  for (const b of keptSecondary) {
    out += `\n\n\`${"```"}${b.lang}\n${b.code}\n\`${"```"}\n`;
  }
  return out;
}

export interface Section { heading: string; level: number; content: string; }

export function splitIntoSections(body: string): Section[] {
  const lines = body.split(/\r?\n/);
  const sections: Section[] = [];
  let current: Section | null = null;
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      if (current) sections.push(current);
      current = { heading: m[2].trim(), level: m[1].length, content: "" };
    } else {
      if (!current) current = { heading: "", level: 0, content: "" }; // preface section
      current.content += (current.content ? "\n" : "") + line;
    }
  }
  if (current) sections.push(current);
  return sections;
}

export function mergeSections(preferred: Section[], other: Section[]): Section[] {
  // For headings that match exactly (case-sensitive) → append unique lines from other under the preferred heading.
  // Heading collisions only merge children (do not duplicate the heading line itself).
  const map = new Map<string, { idx: number; level: number }>();
  preferred.forEach((s, i) => { if (s.heading) map.set(s.heading, { idx: i, level: s.level }); });

  const result = preferred.map((s) => ({ ...s }));

  for (const sec of other) {
    if (!sec.heading) {
      // preface content: append if not duplicate
      if (sec.content.trim()) {
        const first = result[0];
        const dedup = dedupeLines((first?.content || ""), sec.content);
        if (first) first.content = dedup; else result.unshift({ heading: "", level: 0, content: sec.content });
      }
      continue;
    }
    const entry = map.get(sec.heading);
    if (entry) {
      const target = result[entry.idx];
      target.content = dedupeLines(target.content, sec.content);
    } else {
      // heading only exists in other → append it (retain its level)
      result.push({ ...sec });
    }
  }
  return result;
}

function dedupeLines(a: string, b: string): string {
  const set = new Set(a.split(/\r?\n/));
  const out: string[] = a ? a.split(/\r?\n/) : [];
  for (const line of b.split(/\r?\n/)) {
    if (!set.has(line)) { out.push(line); set.add(line); }
  }
  return out.join("\n");
}

export function sectionsToMarkdown(sections: Section[]): string {
  const out: string[] = [];
  for (const s of sections) {
    if (s.heading) out.push("#".repeat(s.level) + " " + s.heading);
    if (s.content) out.push(s.content);
  }
  return out.join("\n");
}
