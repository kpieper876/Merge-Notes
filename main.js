
'use strict';
const { Plugin, TFile, Notice, Setting } = require('obsidian');

/** ---------- Helpers ---------- */
function normalizeBaseName(name){
  return name.replace(/\s*\(\d+\)$/i,'')
             .replace(/\s*-\s*copy$/i,'')
             .replace(/\s*\(conflict[^)]*\)$/i,'')
             .replace(/\s+\d+$/i,'')
             .trim()
             .toLowerCase();
}
async function read(app, file){ return app.vault.read(file); }
async function write(app, file, data){ return app.vault.modify(file, data); }

/** Robust frontmatter extract using Obsidian cache when possible */
function splitFrontmatterWithCache(app, file, raw){
  const cache = app.metadataCache.getFileCache(file);
  if(cache?.frontmatterPosition){
    const { start, end } = cache.frontmatterPosition; // {line,col,offset}
    const fm = raw.slice(start.offset, end.offset);
    const body = raw.slice(end.offset);
    return { front: fm, body };
  }
  // Fallback tolerant regex: allow BOM/leading spaces, CRLF, optional trailing newline
  const re = /^(?:\uFEFF)?\s*---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)?/;
  const m = raw.match(re);
  if(m){
    return { front: m[0], body: raw.slice(m[0].length) };
  }
  return { front: null, body: raw };
}

/** Some files may accidentally contain a YAML fence again at the very top of body; strip it. */
function stripAnyTopYaml(raw){
  const re = /^(?:\uFEFF)?\s*---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n)?/;
  return raw.replace(re, '');
}

function parseYamlArrays(front){
  const aliases = Array.isArray(front?.aliases) ? front.aliases.map(String)
    : (typeof front?.aliases === 'string' ? [front.aliases] : []);
  let tags = [];
  if(Array.isArray(front?.tags)) tags = front.tags.map(String);
  else if(typeof front?.tags === 'string') tags = front.tags.split(/\s+/).filter(Boolean);
  return { aliases, tags };
}

/** Build a fresh YAML block (do not reuse old raw to avoid leaks into body) */
function buildFreshFrontmatter(preferredFront, otherFront){
  const pref = preferredFront || {};
  const oth = otherFront || {};
  const { aliases: a1, tags: t1 } = parseYamlArrays(pref);
  const { aliases: a2, tags: t2 } = parseYamlArrays(oth);
  const aliases = Array.from(new Set([...a1, ...a2])).filter(Boolean);
  const tags = Array.from(new Set([...t1, ...t2])).filter(Boolean);

  const yaml = ['---'];
  if(pref?.title != null) yaml.push(`title: ${String(pref.title)}`);
  if(pref?.date != null)  yaml.push(`date: ${String(pref.date)}`);
  if(aliases.length){
    yaml.push('aliases:');
    for(const a of aliases) yaml.push(`  - ${a}`);
  }
  if(tags.length){
    yaml.push('tags:');
    for(const t of tags) yaml.push(`  - ${t}`);
  }
  yaml.push('---','');
  return yaml.join('\n');
}

function findCodeFences(body){ const blocks=[]; const re=/```(dataviewjs|dataview)([\s\S]*?)```/g; let m,last=0,stripped=''; while((m=re.exec(body))!==null){ const lang=m[1],code=m[2]; stripped+=body.slice(last,m.index)+`@@BLOCK_${blocks.length}@@`; blocks.push({lang,code,raw:m[0]}); last=re.lastIndex; } stripped+=body.slice(last); return {blocks,stripped}; }
function dvjsViewKey(block){ if(block.lang!=='dataviewjs') return null; const m=block.code.match(/dv\.view\((['"])(.*?)\1/); return m?m[2]:null; }
function dedupeDataviewBlocks(primary, secondary, chooseSecondary){ const seenDv=new Set(); const seenJs=new Map(); const keepP=[], keepS=[];
  for(const b of primary){ if(b.lang==='dataview'){ if(seenDv.has(b.raw)) continue; seenDv.add(b.raw); keepP.push(b); } else { const key=dvjsViewKey(b); if(!key){ keepP.push(b); continue; } if(seenJs.has(key)) continue; seenJs.set(key,'primary'); keepP.push(b);} }
  for(const b of secondary){ if(b.lang==='dataview'){ if(seenDv.has(b.raw)) continue; seenDv.add(b.raw); keepS.push(b);} else { const key=dvjsViewKey(b); if(!key){ keepS.push(b); continue; } const existing=seenJs.get(key); if(!existing){ seenJs.set(key,'secondary'); keepS.push(b);} else if(existing==='primary' && chooseSecondary(key)){ seenJs.set(key,'secondary'); keepS.push(b);} } }
  return { keptPrimary: keepP, keptSecondary: keepS };
}
function reinsertBlocks(template, keptPrimary, keptSecondary){ let out=template; keptPrimary.forEach((b,i)=>{ out=out.replace(`@@BLOCK_${i}@@`, `\n\n\`\`\`${b.lang}\n${b.code}\n\`\`\`\n\n`); }); out=out.replace(/@@BLOCK_\d+@@/g,''); for(const b of keptSecondary){ out+=`\n\n\`\`\`${b.lang}\n${b.code}\n\`\`\`\n`; } return out; }
function splitIntoSections(body){ const lines=body.split(/\r?\n/), sections=[]; let cur=null; for(const line of lines){ const m=line.match(/^(#{1,6})\s+(.*)$/); if(m){ if(cur) sections.push(cur); cur={heading:m[2].trim(), level:m[1].length, content:''}; } else { if(!cur) cur={heading:'', level:0, content:''}; cur.content+=(cur.content?'\n':'')+line; } } if(cur) sections.push(cur); return sections; }
function dedupeLines(a,b){ const set=new Set(a.split(/\r?\n/)); const out=a? a.split(/\r?\n/):[]; for(const line of b.split(/\r?\n/)){ if(!set.has(line)){ out.push(line); set.add(line); } } return out.join('\n'); }
function mergeSections(pref, other){ const map=new Map(); pref.forEach((s,i)=>{ if(s.heading) map.set(s.heading,{idx:i,level:s.level}); }); const res=pref.map(s=>({...s})); for(const sec of other){ if(!sec.heading){ if(sec.content.trim()){ const first=res[0]; const d=dedupeLines((first?.content||''), sec.content); if(first) first.content=d; else res.unshift({heading:'',level:0,content:sec.content}); } continue; } const entry=map.get(sec.heading); if(entry){ const tgt=res[entry.idx]; tgt.content=dedupeLines(tgt.content, sec.content); } else res.push({...sec}); } return res; }
function sectionsToMarkdown(secs){ const out=[]; for(const s of secs){ if(s.heading) out.push('#'.repeat(s.level)+' '+s.heading); if(s.content) out.push(s.content); } return out.join('\n'); }
function pruneEmptyOrDuplicateHeadings(md){ const lines=md.split(/\r?\n/), res=[]; let i=0; while(i<lines.length){ const m=lines[i].match(/^(#{1,6})\s+(.*)$/); if(!m){ res.push(lines[i]); i++; continue; } const lvl=m[1].length, head=m[2].trim(); let j=i+1, content=[]; while(j<lines.length){ const mm=lines[j].match(/^(#{1,6})\s+(.*)$/); if(mm && mm[1].length<=lvl) break; content.push(lines[j]); j++; } const has = content.some(ln=>ln.trim().length>0); if(!has){ i=j; continue; } const next = lines[j] && lines[j].match(/^(#{1,6})\s+(.*)$/); if(next && next[1].length===lvl && next[2].trim()===head){ let k=j+1, content2=[]; while(k<lines.length){ const mm2=lines[k].match(/^(#{1,6})\s+(.*)$/); if(mm2 && mm2[1].length<=lvl) break; content2.push(lines[k]); k++; } const merged=dedupeLines(content.join('\n'), content2.join('\n')); res.push(lines[i]); res.push(merged); i=k; continue; } res.push(lines[i]); res.push(...content); i=j; } return res.join('\n'); }
function debounce(fn,wait){ let t=null; return (...args)=>{ window.clearTimeout(t); t=window.setTimeout(()=>fn(...args), wait); }; }

/** ---------- Plugin ---------- */
const DEFAULT_SETTINGS={ autoMergeSameName:true, defaultPreference:'OLD_INTO_NEW', trashSecondaryAfterMerge:true, logToConsole:false, autoMergeDelayMs:250 };

module.exports = class MergeNotesPlugin extends Plugin{
  async onload(){
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // Commands
    this.addCommand({
      id:'merge-notes-merge-selected',
      name:'Merge selected files',
      callback: async () => {
        const sel = getExplorerSelectedMarkdownFiles(this.app, null);
        if(sel.length < 2) return new Notice('Select 2+ markdown notes in the File Explorer first.');
        const pref = await this.askPreference();
        await this.mergeMultiple(sel, pref);
        new Notice(`Merged ${sel.length} notes`);
      }
    });
    this.addCommand({ id:'merge-notes-scan-active-folder', name:'Merge duplicates in active file’s folder', callback:()=>this.scanAndMergeActiveFolder() });
    this.addCommand({ id:'merge-notes-rename-merge', name:'Rename (merge if exists)…', callback:()=>this.renameWithMergeCommand() });

    // Context menu
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      const selected = getExplorerSelectedMarkdownFiles(this.app, file);
      if(selected.length >= 2){
        menu.addItem((item)=>item.setTitle(`Merge Notes: Merge ${selected.length} selected…`).setIcon('merge').onClick(async()=>{
          const pref = await this.askPreference();
          await this.mergeMultiple(selected, pref);
          new Notice(`Merged ${selected.length} notes`);
        }));
      } else if(selected.length === 1){
        menu.addItem((item)=>item.setTitle('Rename (merge if exists)…').setIcon('pencil').onClick(async()=>{
          await this.renameWithMerge(selected[0]);
        }));
      }
    }));

    // Auto-merge on create/rename
    const handle = debounce((file)=>this.handlePossibleDuplicate(file), this.settings.autoMergeDelayMs);
    this.registerEvent(this.app.vault.on('create', (file)=>{ if(file instanceof TFile && file.extension==='md' && this.settings.autoMergeSameName) handle(file); }));
    this.registerEvent(this.app.vault.on('rename', (file)=>{ if(file instanceof TFile && file.extension==='md' && this.settings.autoMergeSameName) handle(file); }));

    // Settings
    this.addSettingTab(new (class extends require('obsidian').PluginSettingTab{
      constructor(app, plugin){ super(app, plugin); this.plugin=plugin; }
      display(){
        const { containerEl } = this; containerEl.empty(); containerEl.createEl('h2', { text:'Merge Notes — Settings' });
        new Setting(containerEl).setName('Auto-merge same-name duplicates').addToggle(t=>t.setValue(this.plugin.settings.autoMergeSameName).onChange(async v=>{ this.plugin.settings.autoMergeSameName=v; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Default preference').addDropdown(dd=>dd.addOptions({OLD_INTO_NEW:'Old Into New', NEW_INTO_OLD:'New Into Old'}).setValue(this.plugin.settings.defaultPreference).onChange(async v=>{ this.plugin.settings.defaultPreference=v; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Trash secondary after merge').addToggle(t=>t.setValue(this.plugin.settings.trashSecondaryAfterMerge).onChange(async v=>{ this.plugin.settings.trashSecondaryAfterMerge=v; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Verbose console logs').addToggle(t=>t.setValue(this.plugin.settings.logToConsole).onChange(async v=>{ this.plugin.settings.logToConsole=v; await this.plugin.saveSettings(); }));
        new Setting(containerEl).setName('Auto-merge debounce (ms)').addText(tb=>tb.setValue(String(this.plugin.settings.autoMergeDelayMs)).onChange(async val=>{ const n=Number(val); if(Number.isFinite(n) && n>=0){ this.plugin.settings.autoMergeDelayMs=n; await this.plugin.saveSettings(); } }));
      }
    })(this.app, this));
  }

  async saveSettings(){ await this.saveData(this.settings); }

  async askPreference(){
    const choice = await new Promise(resolve => {
      const modal = new (class extends require('obsidian').Modal{
        onOpen(){ const { contentEl } = this; contentEl.createEl('h2',{text:'Merge Preference'});
          const row = contentEl.createDiv(); const a=row.createEl('button',{text:'Old Into New (default)'}); const b=row.createEl('button',{text:'New Into Old'});
          a.onclick=()=>{ resolve('OLD_INTO_NEW'); this.close(); }; b.onclick=()=>{ resolve('NEW_INTO_OLD'); this.close(); };
        }
      })(this.app); modal.open();
    });
    return choice || 'OLD_INTO_NEW';
  }

  async renameWithMergeCommand(){
    const active = this.app.workspace.getActiveFile();
    if(!active) return new Notice('No active file.');
    await this.renameWithMerge(active);
  }

  async promptForNewBaseName(defaultName){
    return await new Promise(resolve => {
      const modal = new (class extends require('obsidian').Modal{
        onOpen(){
          const { contentEl } = this;
          contentEl.createEl('h2', { text: 'Rename (merge if exists)' });
          const input = contentEl.createEl('input', { type: 'text', value: defaultName.replace(/\.md$/i,'') });
          input.style.width = '100%';
          const row = contentEl.createDiv({ cls: 'mn-row' });
          const ok = row.createEl('button', { text: 'OK' });
          const cancel = row.createEl('button', { text: 'Cancel' });
          ok.onclick = () => { resolve(input.value.trim()); this.close(); };
          cancel.onclick = () => { resolve(null); this.close(); };
          input.focus(); input.select();
        }
      })(this.app);
      modal.open();
    });
  }

  async renameWithMerge(file){
    const folder = file.parent?.path ?? '';
    const currentBase = file.basename;
    const desiredBase = await this.promptForNewBaseName(currentBase);
    if(!desiredBase) return;

    const desiredPath = `${folder}/${desiredBase}.md`.replace(/\/\//g,'/');
    const existing = this.app.vault.getAbstractFileByPath(desiredPath);

    if(!existing){
      try{ await this.app.vault.rename(file, desiredPath); new Notice(`Renamed to ${desiredBase}.md`); }
      catch(e){ new Notice('Rename failed. Check console.'); console.error(e); }
      return;
    }

    const pref = await this.askPreference();
    const target = existing;
    if(!(target instanceof TFile)){ new Notice('Target exists but is not a markdown file.'); return; }
    let anchor = (pref === 'OLD_INTO_NEW') ? target : file;
    let other  = (pref === 'OLD_INTO_OLD') ? target : file; // not used further but kept for clarity

    await this.mergePair(anchor, (pref === 'OLD_INTO_NEW') ? file : target, pref);
    if(anchor.path !== desiredPath){
      try{ await this.app.vault.rename(anchor, desiredPath); }catch(_){}
    }
    new Notice(`Merged via rename into "${desiredBase}.md"`);
  }

  /** Merge N files according to preference: OLD_INTO_NEW -> keep newest; NEW_INTO_OLD -> keep oldest */
  async mergeMultiple(files, pref){
    const sorted = files.slice().sort((a,b)=>a.stat.mtime - b.stat.mtime); // oldest→newest
    let anchor = (pref==='OLD_INTO_NEW') ? sorted[sorted.length-1] : sorted[0];
    const others = (pref==='OLD_INTO_NEW') ? sorted.slice(0, -1).reverse() : sorted.slice(1);
    for(const f of others){ if(f.path !== anchor.path) await this.mergePair(anchor, f, pref); }
    const baseKey = normalizeBaseName(anchor.basename);
    if(files.every(f => normalizeBaseName(f.basename) === baseKey)){
      const desired = `${anchor.parent?.path ?? ''}/${anchor.basename.replace(/\s+\d+$/i,'')}.md`.replace(/\/\//g,'/');
      if(anchor.path !== desired && !this.app.vault.getAbstractFileByPath(desired)){
        try{ await this.app.vault.rename(anchor, desired); }catch(_){}
      }
    }
  }

  async handlePossibleDuplicate(file){
    if(!(file instanceof TFile) || file.extension!=='md') return;
    const folder = file.parent?.path ?? '';
    const siblings = this.app.vault.getMarkdownFiles().filter(f => f.parent?.path === folder);
    const groups = new Map();
    for(const f of siblings){ const key=normalizeBaseName(f.basename); if(!groups.has(key)) groups.set(key, []); groups.get(key).push(f); }
    for(const arr of groups.values()){
      if(arr.length < 2) continue;
      await this.mergeMultiple(arr, this.settings.defaultPreference);
    }
  }

  async scanAndMergeActiveFolder(){
    const active = this.app.workspace.getActiveFile();
    if(!active) return new Notice('No active file.');
    await this.handlePossibleDuplicate(active);
  }

  async mergePair(dest, src, pref){
    const preferred = dest, secondary = src;
    const preferredRaw = await read(this.app, preferred);
    const secondaryRaw = await read(this.app, secondary);

    // Extract frontmatter & bodies robustly (no YAML leaked into body)
    const prefSplit = splitFrontmatterWithCache(this.app, preferred, preferredRaw);
    const secSplit  = splitFrontmatterWithCache(this.app, secondary, secondaryRaw);

    const prefCache = this.app.metadataCache.getFileCache(preferred) || {};
    const secCache = this.app.metadataCache.getFileCache(secondary) || {};
    const prefFront = prefCache.frontmatter || {};
    const secFront  = secCache.frontmatter || {};

    const prefBody0 = stripAnyTopYaml(prefSplit.body);
    const secBody0  = stripAnyTopYaml(secSplit.body);

    // Handle Dataview blocks
    const prefBlocks = findCodeFences(prefBody0);
    const secBlocks  = findCodeFences(secBody0);
    const chooseSecondary = () => secondary.stat.mtime > preferred.stat.mtime;
    const { keptPrimary, keptSecondary } = dedupeDataviewBlocks(prefBlocks.blocks, secBlocks.blocks, chooseSecondary);

    const prefBodyNoBlocks = prefBlocks.stripped;
    const secBodyNoBlocks  = secBlocks.stripped;

    // Merge content sections
    const prefSections = splitIntoSections(prefBodyNoBlocks);
    const secSections  = splitIntoSections(secBodyNoBlocks);
    const mergedSections = mergeSections(prefSections, secSections);
    let mergedBody = sectionsToMarkdown(mergedSections).trim();
    mergedBody = reinsertBlocks(mergedBody, keptPrimary, keptSecondary).trim() + '\n';
    mergedBody = pruneEmptyOrDuplicateHeadings(mergedBody);

    // Fresh frontmatter (title/date from preferred; aliases/tags merged & deduped)
    const rebuiltFront = buildFreshFrontmatter(prefFront, secFront);

    const final = `${rebuiltFront}${mergedBody}`;
    await write(this.app, preferred, final);

    if(this.settings.trashSecondaryAfterMerge) await this.app.vault.trash(secondary, true);
  }
};

/** ---------- File Explorer selection helpers (moved to bottom to avoid hoist surprises) ---------- */
function getExplorerSelectedMarkdownFiles(app, contextFile){
  const leaf = app.workspace.getLeavesOfType('file-explorer')[0];
  const view = leaf?.view;
  let selected = [];
  if(view?.getSelectedFiles) selected = view.getSelectedFiles();
  else if(view?.fileExplorer?.getSelectedFiles) selected = view.fileExplorer.getSelectedFiles();
  else if(view?.getSelection) selected = view.getSelection();
  const files = (Array.isArray(selected) ? selected : [selected]).filter(Boolean).filter(f => f instanceof TFile && f.extension==='md');
  if(contextFile && contextFile instanceof TFile && contextFile.extension==='md' && !files.some(f => f.path===contextFile.path)) files.push(contextFile);
  const byPath = new Map(); for(const f of files) byPath.set(f.path, f);
  return Array.from(byPath.values());
}

