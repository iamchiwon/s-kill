import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { cannotRestore, listTrash, parseFrontmatter, removeSkill, restore, scan, trash, type Ctx } from '../src/core.ts';

function setup() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 's-kill-')));
  const home = path.join(base, 'home');
  const proj = path.join(home, 'work', 'proj');
  const skill = (dir: string, name: string) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    fs.writeFileSync(path.join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: >\n  does ${name}\n---\nbody`);
  };
  skill(path.join(home, '.agents/skills'), 'shared');
  fs.mkdirSync(path.join(home, '.claude/skills'), { recursive: true });
  // junctions on Windows need absolute targets but no admin rights
  const win = process.platform === 'win32';
  fs.symlinkSync(win ? path.join(home, '.agents/skills/shared') : '../../.agents/skills/shared', path.join(home, '.claude/skills/shared'), 'junction');
  fs.mkdirSync(path.join(home, '.claude/skills/not-a-skill'));
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  skill(path.join(proj, '.claude/skills'), 'local');
  const ctx: Ctx = { home, cwd: path.join(proj, 'sub'), trashDir: path.join(base, 'trash'), env: {} };
  fs.mkdirSync(ctx.cwd);
  return { base, home, proj, ctx };
}

test('frontmatter', () => {
  assert.deepEqual(parseFrontmatter('---\nname: "x"\ndescription: |\n  a\n  b\n---\n'), { name: 'x', description: 'a b' });
});

test('scan, trash with links, restore original', () => {
  const { home, proj, ctx } = setup();
  const { projectRoot, skills } = scan(ctx);
  assert.equal(projectRoot, proj);
  assert.deepEqual(skills.map((s) => `${s.location.scope}:${s.name}:${!!s.link}`).sort(), ['global:shared:false', 'global:shared:true', 'project:local:false']);
  const real = skills.find((s) => s.name === 'shared' && !s.link)!;
  assert.equal(real.description, 'does shared');
  assert.deepEqual(real.linkedFrom, [path.join(home, '.claude/skills/shared')]);

  trash(ctx, real, skills);
  assert.equal(scan(ctx).skills.filter((s) => s.name === 'shared').length, 0);
  const [item] = listTrash(ctx);
  assert.equal(item.entries.length, 2);

  restore(ctx, item, { kind: 'original' });
  assert.equal(scan(ctx).skills.filter((s) => s.name === 'shared').length, 2);
  assert.equal(listTrash(ctx).length, 0);
});

test('project skill: blocked when project gone, restorable to global or another project', () => {
  const { home, proj, ctx } = setup();
  const local = scan(ctx).skills.find((s) => s.name === 'local')!;
  trash(ctx, local, []);
  fs.rmSync(proj, { recursive: true });
  const [item] = listTrash(ctx);
  assert.match(cannotRestore(item, { kind: 'original' })!, /original project is gone/);
  assert.throws(() => restore(ctx, item, { kind: 'original' }));

  const other = path.join(home, 'other');
  restore(ctx, item, { kind: 'project', root: other });
  assert.ok(fs.existsSync(path.join(other, '.claude/skills/local/SKILL.md')));

  const moved = scan({ ...ctx, cwd: other }).skills.find((s) => s.name === 'local')!;
  trash({ ...ctx, cwd: other }, moved, []);
  restore(ctx, listTrash(ctx)[0], { kind: 'global' });
  assert.ok(fs.existsSync(path.join(home, '.claude/skills/local/SKILL.md')));
});

test('global bundle restored into a project keeps link pointing at restored folder', () => {
  const { home, proj, ctx } = setup();
  const { skills } = scan(ctx);
  trash(ctx, skills.find((s) => s.name === 'shared' && !s.link)!, skills);
  const dests = restore(ctx, listTrash(ctx)[0], { kind: 'project', root: proj });
  assert.deepEqual(dests, [path.join(proj, '.agents/skills/shared'), path.join(proj, '.claude/skills/shared')]);
  assert.equal(fs.realpathSync(dests[1]), dests[0]);
  assert.ok(!fs.existsSync(path.join(home, '.agents/skills/shared')));
});

test('restore refuses to overwrite', () => {
  const { ctx } = setup();
  const local = scan(ctx).skills.find((s) => s.name === 'local')!;
  trash(ctx, local, []);
  fs.mkdirSync(local.path);
  assert.throws(() => restore(ctx, listTrash(ctx)[0], { kind: 'original' }), /already exists/);
  assert.equal(listTrash(ctx).length, 1);
});

test('removeSkill: link only removes link, real folder removes links too, nothing in trash', () => {
  const { home, ctx } = setup();
  const find = (link: boolean) => scan(ctx).skills.find((s) => s.name === 'shared' && !!s.link === link)!;
  removeSkill(find(true));
  assert.ok(fs.existsSync(path.join(home, '.agents/skills/shared/SKILL.md')));
  fs.symlinkSync(path.join(home, '.agents/skills/shared'), path.join(home, '.claude/skills/shared'), 'junction');
  removeSkill(find(false));
  assert.equal(scan(ctx).skills.filter((s) => s.name === 'shared').length, 0);
  assert.ok(!fs.existsSync(path.join(home, '.claude/skills/shared')));
  assert.equal(listTrash(ctx).length, 0);
});

test('codex home: ~/.codex/skills and CODEX_HOME are scanned, .system is hidden', () => {
  const { base, home, ctx } = setup();
  const mk = (dir: string) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: x\n---\n');
  };
  mk(path.join(home, '.codex/skills/cx'));
  mk(path.join(home, '.codex/skills/.system/builtin'));
  const names = (c: Ctx) => scan(c).skills.filter((s) => s.location.agents.includes('codex-home')).map((s) => s.name);
  assert.deepEqual(names(ctx), ['cx']);
  mk(path.join(base, 'ch/skills/custom'));
  assert.deepEqual(names({ ...ctx, env: { CODEX_HOME: path.join(base, 'ch') } }), ['custom']);
});

test('agent dirs that are symlinks to each other are scanned once', () => {
  const { home, ctx } = setup();
  fs.mkdirSync(path.join(home, '.gemini/config/skills/g'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gemini/config/skills/g/SKILL.md'), '---\nname: g\n---\n');
  fs.mkdirSync(path.join(home, '.gemini/antigravity'));
  fs.symlinkSync(path.join(home, '.gemini/config/skills'), path.join(home, '.gemini/antigravity/skills'), 'junction');
  const g = scan(ctx).skills.filter((s) => s.name === 'g');
  assert.equal(g.length, 1);
  assert.ok(g[0].location.agents.includes('antigravity') && g[0].location.agents.includes('antigravity2.0'));
});

test('same-named skills trashed back to back get separate trash items', () => {
  const { home, ctx } = setup();
  for (const d of ['.cursor/skills/dup', '.gemini/skills/dup']) {
    fs.mkdirSync(path.join(home, d), { recursive: true });
    fs.writeFileSync(path.join(home, d, 'SKILL.md'), '---\nname: dup\n---\n');
  }
  const { skills } = scan(ctx);
  for (const s of skills.filter((x) => x.name === 'dup')) trash(ctx, s, skills);
  const items = listTrash(ctx);
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => i.entries.length === 1));
});
