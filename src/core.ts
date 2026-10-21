import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENTS } from './agents.js';

export type Scope = 'global' | 'project';

export interface Ctx {
  home: string;
  cwd: string;
  trashDir: string;
  env: Record<string, string | undefined>;
}

export interface Location {
  scope: Scope;
  root: string; // home or project root
  dir: string; // absolute skills dir
  agents: string[]; // agent ids reading this dir
}

export interface Skill {
  name: string; // directory name
  title: string; // frontmatter name
  description: string;
  path: string;
  location: Location;
  link?: string; // raw readlink value when this entry is a symlink
  real?: string; // realpath, undefined when the link is broken
  linkedFrom: string[]; // symlink entries that resolve to this skill
}

export interface TrashEntry {
  scope: Scope;
  root: string;
  dir: string;
  name: string;
  agents: string[];
  link?: string;
  target?: string; // absolute link target
  payload?: string; // folder name inside the trash item
}

export interface TrashItem {
  id: string;
  name: string;
  deletedAt: string;
  entries: TrashEntry[];
}

export type RestoreTarget = { kind: 'original' } | { kind: 'global' } | { kind: 'project'; root: string };

export function defaultCtx(): Ctx {
  const home = os.homedir();
  return {
    home,
    cwd: process.cwd(),
    trashDir: process.env.S_KILL_TRASH ?? path.join(home, '.s-kill', 'trash'),
    env: process.env,
  };
}

const exists = (p: string) => {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

// Nearest ancestor with .git, else cwd. null when that is home (project == global).
export function findProjectRoot(ctx: Ctx): string | null {
  let dir = path.resolve(ctx.cwd);
  for (;;) {
    if (dir === ctx.home) break;
    if (exists(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.resolve(ctx.cwd) === ctx.home ? null : path.resolve(ctx.cwd);
}

export function agentDir(id: string, scope: Scope, ctx: Ctx, projectRoot: string): string {
  const a = AGENTS.find((x) => x[0] === id)!;
  if (scope === 'project') return path.join(projectRoot, a[2]);
  const envDir = { 'claude-code': ctx.env.CLAUDE_CONFIG_DIR, pi: ctx.env.PI_CODING_AGENT_DIR, 'codex-home': ctx.env.CODEX_HOME }[id];
  return envDir ? path.join(envDir, 'skills') : path.join(ctx.home, a[3]);
}

export function locations(ctx: Ctx, projectRoot: string | null): Location[] {
  const byDir = new Map<string, Location>();
  const scopes: [Scope, string][] = [['global', ctx.home]];
  if (projectRoot) scopes.push(['project', projectRoot]);
  for (const [scope, root] of scopes) {
    for (const [id] of AGENTS) {
      const dir = agentDir(id, scope, ctx, root);
      const key = realpath(dir) ?? dir; // e.g. ~/.gemini/antigravity/skills -> ~/.gemini/config/skills
      const loc = byDir.get(key) ?? { scope, root, dir, agents: [] };
      loc.agents.push(id);
      byDir.set(key, loc);
    }
  }
  return [...byDir.values()];
}

// ponytail: line-based frontmatter reader (key: value, folded/indented continuation), not full YAML.
export function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  let key: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      out[key] = /^[|>][-+]?$/.test(kv[2]) ? '' : kv[2].replace(/^(['"])(.*)\1$/, '$2');
    } else if (key && /^\s/.test(line)) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    }
  }
  return out;
}

const realpath = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
};

export function scan(ctx: Ctx): { projectRoot: string | null; skills: Skill[] } {
  const projectRoot = findProjectRoot(ctx);
  const skills: Skill[] = [];
  for (const location of locations(ctx, projectRoot)) {
    let names: string[];
    try {
      names = fs.readdirSync(location.dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (name.startsWith('.')) continue;
      const p = path.join(location.dir, name);
      const st = fs.lstatSync(p);
      const link = st.isSymbolicLink() ? fs.readlinkSync(p) : undefined;
      const real = realpath(p);
      const md = real ? path.join(real, 'SKILL.md') : undefined;
      if (real && !(md && fs.existsSync(md))) continue; // not a skill folder
      const fm = md ? parseFrontmatter(fs.readFileSync(md, 'utf8')) : {};
      skills.push({ name, title: fm.name ?? name, description: fm.description ?? '', path: p, location, link, real, linkedFrom: [] });
    }
  }
  for (const s of skills) {
    if (s.link) continue;
    s.linkedFrom = skills.filter((l) => l.link && l.real === s.real).map((l) => l.path);
  }
  return { projectRoot, skills };
}

export interface FileEntry {
  rel: string;
  depth: number;
  isDir: boolean;
}

export function listFiles(dir: string, max = 500): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (d: string, depth: number) => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    ents.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= max || e.name === 'node_modules' || e.name === '.git') continue;
      const full = path.join(d, e.name);
      out.push({ rel: path.relative(dir, full), depth, isDir: e.isDirectory() });
      if (e.isDirectory()) walk(full, depth + 1);
    }
  };
  walk(dir, 0);
  return out;
}

function move(src: string, dst: string) {
  try {
    fs.renameSync(src, dst);
  } catch (e: any) {
    if (e.code !== 'EXDEV') throw e;
    fs.cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function removeLink(p: string) {
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p); // Windows directory symlink / junction
  }
}

function makeLink(target: string, dest: string) {
  // Junctions need no admin rights on Windows but require absolute targets.
  const win = process.platform === 'win32';
  fs.symlinkSync(win ? path.resolve(path.dirname(dest), target) : target, dest, win ? 'junction' : 'dir');
}

// Trashing a real folder also trashes every symlink pointing at it (they'd break anyway); restore brings both back.
export function trash(ctx: Ctx, skill: Skill, all: Skill[]): TrashItem {
  fs.mkdirSync(ctx.trashDir, { recursive: true });
  // mkdtemp: unique even when same-named skills are trashed within one millisecond
  const itemDir = fs.mkdtempSync(path.join(ctx.trashDir, `${Date.now()}-${skill.name.replace(/[^\w.-]/g, '_')}-`));
  const id = path.basename(itemDir);
  const item: TrashItem = { id, name: skill.name, deletedAt: new Date().toISOString(), entries: [] };
  const set = [skill, ...all.filter((s) => !skill.link && skill.linkedFrom.includes(s.path))];
  try {
    for (const s of set) {
      const e: TrashEntry = { scope: s.location.scope, root: s.location.root, dir: s.location.dir, name: s.name, agents: s.location.agents };
      if (s.link) {
        e.link = s.link;
        e.target = path.resolve(s.location.dir, s.link);
        removeLink(s.path);
      } else {
        e.payload = 'payload';
        move(s.path, path.join(itemDir, e.payload));
      }
      item.entries.push(e);
    }
  } finally {
    // Always record what was moved, even if a later step failed.
    if (item.entries.length) fs.writeFileSync(path.join(itemDir, 'meta.json'), JSON.stringify(item, null, 2));
    else fs.rmSync(itemDir, { recursive: true, force: true });
  }
  return item;
}

export function listTrash(ctx: Ctx): TrashItem[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(ctx.trashDir);
  } catch {
    return [];
  }
  const items: TrashItem[] = [];
  for (const id of ids) {
    try {
      items.push(JSON.parse(fs.readFileSync(path.join(ctx.trashDir, id, 'meta.json'), 'utf8')));
    } catch {}
  }
  return items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export const payloadDir = (ctx: Ctx, item: TrashItem) => {
  const e = item.entries.find((x) => x.payload);
  return e ? path.join(ctx.trashDir, item.id, e.payload!) : undefined;
};

// null = restorable, otherwise the reason it is not.
export function cannotRestore(item: TrashItem, target: RestoreTarget): string | null {
  if (target.kind === 'original') {
    const missing = item.entries.find((e) => e.scope === 'project' && !fs.existsSync(e.root));
    if (missing) return `original project is gone: ${missing.root}`;
  }
  return null;
}

export function restorePlan(ctx: Ctx, item: TrashItem, target: RestoreTarget): { entry: TrashEntry; dest: string }[] {
  const plan: { entry: TrashEntry; dest: string }[] = [];
  const seen = new Set<string>();
  // payload first so links can point at its new home
  for (const entry of [...item.entries].sort((a, b) => Number(!!b.payload) - Number(!!a.payload))) {
    let dir = entry.dir;
    if (target.kind === 'global' && entry.scope !== 'global') dir = agentDir(entry.agents[0], 'global', ctx, ctx.home);
    if (target.kind === 'project' && !(entry.scope === 'project' && entry.root === target.root))
      dir = agentDir(entry.agents[0], 'project', ctx, target.root);
    const dest = path.join(dir, entry.name);
    if (seen.has(dest)) continue; // several agents share the same dir in the target scope
    seen.add(dest);
    plan.push({ entry, dest });
  }
  return plan;
}

export function restore(ctx: Ctx, item: TrashItem, target: RestoreTarget): string[] {
  const reason = cannotRestore(item, target);
  if (reason) throw new Error(reason);
  const plan = restorePlan(ctx, item, target);
  const conflict = plan.find((p) => exists(p.dest));
  if (conflict) throw new Error(`already exists: ${conflict.dest}`);
  const original = path.join(ctx.trashDir, item.id);
  const moved = new Map<string, string>(); // original path -> restored path
  for (const { entry, dest } of plan) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (entry.payload) {
      move(path.join(original, entry.payload), dest);
      moved.set(path.join(entry.dir, entry.name), dest);
    } else if (target.kind === 'original') {
      makeLink(entry.link!, dest);
    } else {
      const abs = moved.get(entry.target!) ?? entry.target!;
      makeLink(path.relative(path.dirname(dest), abs), dest);
    }
  }
  fs.rmSync(original, { recursive: true, force: true });
  return plan.map((p) => p.dest);
}

export function purge(ctx: Ctx, item: TrashItem) {
  fs.rmSync(path.join(ctx.trashDir, item.id), { recursive: true, force: true });
}

// Permanent delete, no trash. Same set as trash(): a real folder takes its links with it.
export function removeSkill(skill: Skill) {
  if (skill.link) return removeLink(skill.path);
  for (const l of skill.linkedFrom) removeLink(l);
  fs.rmSync(skill.path, { recursive: true, force: true });
}
