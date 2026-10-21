import fs from 'node:fs';
import path from 'node:path';
import { Box, Text, useApp, useBoxMetrics, useInput, useWindowSize } from 'ink';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AGENTS } from './agents.js';
import {
  cannotRestore,
  listFiles,
  listTrash,
  payloadDir,
  purge,
  removeSkill,
  restore,
  restorePlan,
  scan,
  trash,
  type Ctx,
  type RestoreTarget,
  type Skill,
  type TrashItem,
} from './core.js';

type PanelId = 'global' | 'project' | 'trash';
type Modal = { kind: 'delete'; skills: Skill[] } | { kind: 'remove'; skill: Skill } | { kind: 'restore'; items: TrashItem[] } | { kind: 'purge'; items: TrashItem[] } | { kind: 'help' } | null;

const PANELS: PanelId[] = ['global', 'project', 'trash'];
const agentName = (id: string) => AGENTS.find((a) => a[0] === id)?.[1] ?? id;
const clamp = (n: number, len: number) => Math.max(0, Math.min(n, len - 1));
const fmtDate = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const keyOf = (x: Skill | TrashItem) => ('id' in x ? x.id : x.path);

// Run fn on every item, keep going on failure, summarize.
function bulk<T>(items: T[], fn: (t: T) => void, label: string): string {
  const errors: string[] = [];
  for (const t of items) {
    try {
      fn(t);
    } catch (e: any) {
      errors.push(e.message);
    }
  }
  const ok = `${label}: ${items.length - errors.length}`;
  if (errors.length) throw new Error(`${ok}, failed ${errors.length} — ${errors.join(' / ')}`);
  return ok;
}

function readPreview(file: string | undefined): string[] {
  if (!file) return ['(nothing to preview)'];
  try {
    if (fs.statSync(file).isDirectory()) return ['(directory)'];
    const buf = fs.readFileSync(file).subarray(0, 256 * 1024);
    if (buf.includes(0)) return ['(binary file)'];
    return buf.toString('utf8').replace(/\t/g, '  ').split(/\r?\n/);
  } catch (e: any) {
    return [`(read failed: ${e.message})`];
  }
}

function Panel(props: { title: string; active: boolean; width: number; height?: number; maxHeight?: number; children?: React.ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={props.active ? 'green' : 'gray'} width={props.width} height={props.height} maxHeight={props.maxHeight} overflow="hidden">
      <Text bold color={props.active ? 'green' : undefined} wrap="truncate-end">
        {props.title}
      </Text>
      {props.children}
    </Box>
  );
}

function Rows<T>(props: { items: T[]; cursor: number; size: number; active: boolean; render: (t: T) => React.ReactNode; marked?: (i: number) => boolean }) {
  const { items, cursor, size } = props;
  const start = Math.max(0, Math.min(cursor - Math.floor(size / 2), items.length - size));
  return (
    <>
      {items.slice(start, start + size).map((it, i) => (
        <Text key={start + i} inverse={start + i === cursor && props.active} bold={start + i === cursor} wrap="truncate-end">
          {props.marked ? <Text color="magenta">{props.marked(start + i) ? '● ' : '  '}</Text> : null}
          {props.render(it)}
        </Text>
      ))}
    </>
  );
}

export function App({ ctx }: { ctx: Ctx }) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const [data, setData] = useState(() => scan(ctx));
  const [trashItems, setTrash] = useState(() => listTrash(ctx));
  const [version, setVersion] = useState(0);
  const [panel, setPanel] = useState<PanelId>('global');
  const [inFiles, setInFiles] = useState(false);
  const [cursor, setCursor] = useState<Record<PanelId, number>>({ global: 0, project: 0, trash: 0 });
  const [fileCursor, setFileCursor] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [filter, setFilter] = useState('');
  const [filtering, setFiltering] = useState(false);
  const [modal, setModal] = useState<Modal>(null);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);
  // multi-select: explicit marks (by key) plus an active shift-range from `anchor` to the cursor
  const [marks, setMarks] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);

  const { home } = ctx;
  const root = data.projectRoot;
  const short = (p: string) => (root && p.startsWith(root + path.sep) ? '.' + p.slice(root.length) : p.startsWith(home) ? '~' + p.slice(home.length) : p);

  const q = filter.toLowerCase();
  const match = (name: string) => name.toLowerCase().includes(q);
  const byName = (a: Skill, b: Skill) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
  const lists = {
    global: data.skills.filter((s) => s.location.scope === 'global' && match(s.name)).sort(byName),
    project: data.skills.filter((s) => s.location.scope === 'project' && match(s.name)).sort(byName),
    trash: trashItems.filter((t) => match(t.name)),
  };
  const cur = clamp(cursor[panel], lists[panel].length);
  const skill = panel === 'trash' ? undefined : (lists[panel][cur] as Skill | undefined);
  const item = panel === 'trash' ? lists.trash[cur] : undefined;
  const dir = skill ? skill.real : item ? payloadDir(ctx, item) : undefined;
  const list: (Skill | TrashItem)[] = lists[panel];
  const inRange = (i: number) => anchor !== null && i >= Math.min(anchor, cur) && i <= Math.max(anchor, cur);
  const isMarked = (i: number) => inRange(i) || (!!list[i] && marks.has(keyOf(list[i])));
  const picked = list.filter((_, i) => isMarked(i));
  const selection = picked.length ? picked : list[cur] ? [list[cur]] : [];
  const clearMarks = () => (setMarks(new Set()), setAnchor(null));
  const commitRange = () => {
    const next = new Set(marks);
    list.forEach((x, i) => inRange(i) && next.add(keyOf(x)));
    setAnchor(null);
    return next;
  };
  useEffect(clearMarks, [panel, filter]);

  const files = useMemo(() => (dir ? listFiles(dir) : []), [dir, version]);
  const fcur = clamp(fileCursor, files.length);
  const previewFile = dir && (inFiles && files[fcur] ? path.join(dir, files[fcur].rel) : path.join(dir, 'SKILL.md'));
  const preview = useMemo(() => readPreview(previewFile), [previewFile, version]);

  useEffect(() => {
    setFileCursor(0);
    setScroll(0);
  }, [dir]);
  useEffect(() => setScroll(0), [previewFile]);

  const reload = () => {
    setData(scan(ctx));
    setTrash(listTrash(ctx));
    setVersion((v) => v + 1);
  };
  const run = (fn: () => string) => {
    try {
      setMsg({ text: fn() });
    } catch (e: any) {
      setMsg({ text: e.message, error: true });
    }
    setModal(null);
    setInFiles(false);
    clearMarks();
    reload();
  };

  // layout
  const H = rows - 1;
  const leftW = Math.max(28, Math.floor(columns * 0.38));
  const rightW = columns - leftW;
  const panelH = [Math.floor(H / 3), Math.floor(H / 3), H - 2 * Math.floor(H / 3)];
  // info panel grows with its content (full description); files/preview take the rest
  const infoRef = useRef(null);
  const infoBox = useBoxMetrics(infoRef);
  const infoMax = Math.max(5, H - 8);
  const infoH = infoBox.hasMeasured ? infoBox.height : 8;
  const filesW = Math.max(20, Math.floor(rightW * 0.32));
  const bodyH = H - infoH;
  const previewSize = Math.max(1, bodyH - 3);
  const page = Math.max(1, Math.floor(previewSize / 2));

  const targets: { key: string; label: string; target: RestoreTarget | null; reason?: string }[] = [
    { key: 'o', label: 'Original location', target: { kind: 'original' } },
    { key: 'g', label: 'Global', target: { kind: 'global' } },
    root
      ? { key: 'p', label: `Current project (${short(root)})`, target: { kind: 'project', root } }
      : { key: 'p', label: 'Current project', target: null, reason: 'current folder is not a project' },
  ];

  useInput((input, key) => {
    setMsg(null);
    if (modal) {
      if (modal.kind === 'help') return setModal(null);
      if (key.escape || input === 'n') return setModal(null);
      if (modal.kind === 'delete' && input === 'y') {
        const ss = modal.skills;
        return run(() => bulk(ss, (s) => trash(ctx, s, data.skills), 'Moved to trash'));
      }
      if (modal.kind === 'remove' && input === 'y') {
        const s = modal.skill;
        return run(() => (removeSkill(s), `Deleted permanently: ${short(s.path)}`));
      }
      if (modal.kind === 'purge' && input === 'y') {
        const its = modal.items;
        return run(() => bulk(its, (it) => purge(ctx, it), 'Deleted permanently'));
      }
      if (modal.kind === 'restore') {
        const t = targets.find((x) => x.key === input);
        const ok = t?.target ? modal.items.filter((it) => !cannotRestore(it, t.target!)) : [];
        if (ok.length) return run(() => bulk(ok, (it) => restore(ctx, it, t!.target!), 'Restored'));
      }
      return;
    }
    if (filtering) {
      if (key.escape) return setFiltering(false), setFilter('');
      if (key.return) return setFiltering(false);
      if (key.backspace || key.delete) return setFilter((f) => f.slice(0, -1));
      if (input && !key.ctrl && !key.meta) setFilter((f) => f + input);
      return;
    }
    const move = (d: number) => {
      if (inFiles) setFileCursor(clamp(fcur + d, files.length));
      else setCursor((c) => ({ ...c, [panel]: clamp(cur + d, lists[panel].length) }));
    };
    const scrollBy = (d: number) => setScroll((s) => Math.max(0, Math.min(s + d, preview.length - 1)));
    const switchTo = (p: PanelId) => (setPanel(p), setInFiles(false));

    if (input === 'q') return exit();
    if (input === '?') return setModal({ kind: 'help' });
    if (input === '/') return setFiltering(true);
    if (input === 'R') return reload(), setMsg({ text: 'Refreshed' });
    if (key.tab) return switchTo(PANELS[(PANELS.indexOf(panel) + (key.shift ? 2 : 1)) % 3]);
    if (input >= '1' && input <= '3') return switchTo(PANELS[Number(input) - 1]);
    // key repeat can arrive as one chunk ("jjj")
    if (!inFiles && key.shift && (key.upArrow || key.downArrow)) {
      if (anchor === null) setAnchor(cur);
      return move(key.upArrow ? -1 : 1);
    }
    if (!inFiles && input === ' ') {
      const next = commitRange();
      if (list[cur]) next.has(keyOf(list[cur])) ? next.delete(keyOf(list[cur])) : next.add(keyOf(list[cur]));
      setMarks(next);
      return move(1);
    }
    if (key.escape && !inFiles && (marks.size || anchor !== null)) return clearMarks();
    if ((key.upArrow || key.downArrow || /^[jkgG]+$/.test(input)) && anchor !== null) setMarks(commitRange());
    if (key.upArrow || /^k+$/.test(input)) return move(-Math.max(1, input.length));
    if (key.downArrow || /^j+$/.test(input)) return move(Math.max(1, input.length));
    if (key.pageUp) return move(-previewSize);
    if (key.pageDown) return move(previewSize);
    if (input === 'g') return move(-Infinity);
    if (input === 'G') return move(Infinity);
    if (input === 'K' || (key.ctrl && input === 'u')) return scrollBy(-page);
    if (input === 'J' || (key.ctrl && input === 'd')) return scrollBy(page);
    if ((key.return || input === 'l' || key.rightArrow) && !inFiles && files.length) return setInFiles(true);
    if ((key.escape || input === 'h' || key.leftArrow) && inFiles) return setInFiles(false);
    if (!selection.length) return;
    if (input === 'D' && panel !== 'trash') {
      if (picked.length > 1) return setMsg({ text: 'Permanent delete works on one skill at a time (esc to clear selection)', error: true });
      return setModal({ kind: 'remove', skill: selection[0] as Skill });
    }
    if (input === 'd' && panel !== 'trash') {
      // a real folder already takes its links along; don't trash those links twice
      const ss = selection as Skill[];
      const covered = new Set(ss.flatMap((s) => s.linkedFrom));
      return setModal({ kind: 'delete', skills: ss.filter((s) => !covered.has(s.path)) });
    }
    if (input === 'd') return setModal({ kind: 'purge', items: selection as TrashItem[] });
    if (input === 'r' && panel === 'trash') return setModal({ kind: 'restore', items: selection as TrashItem[] });
  });

  const skillRow = (s: Skill) => (
    <>
      {s.link ? <Text color={s.real ? 'cyan' : 'red'}>{s.real ? '↪ ' : '✗ '}</Text> : '  '}
      {s.name}
      <Text dimColor> {short(s.location.dir)}</Text>
    </>
  );
  const trashRow = (t: TrashItem) => {
    const blocked = cannotRestore(t, { kind: 'original' });
    return (
      <>
        <Text color={blocked ? 'red' : 'yellow'}>{t.entries.some((e) => e.scope === 'project') ? 'P ' : 'G '}</Text>
        {t.name}
        <Text dimColor> {fmtDate(t.deletedAt)}</Text>
      </>
    );
  };

  const titles: Record<PanelId, string> = {
    global: `[1] Global (${lists.global.length})`,
    project: root ? `[2] Project ${short(root)} (${lists.project.length})` : '[2] Project (none)',
    trash: `[3] Trash (${lists.trash.length})`,
  };

  const info = (): React.ReactNode => {
    if (skill) {
      return (
        <>
          <Text bold wrap="truncate-end">
            {skill.title}
            {skill.title !== skill.name ? <Text dimColor> ({skill.name})</Text> : null}
          </Text>
          <Text dimColor>{skill.description || '(no description)'}</Text>
          <Text wrap="truncate-end">Path    {short(skill.path)}</Text>
          {skill.link ? (
            <Text wrap="truncate-end" color={skill.real ? 'cyan' : 'red'}>
              Link  → {skill.link} {skill.real ? `(${short(skill.real)})` : '(broken)'}
            </Text>
          ) : null}
          <Text wrap="truncate-end">Agents  {[...new Set(skill.location.agents.map(agentName))].join(', ')}</Text>
          {skill.linkedFrom.length ? (
            <Text wrap="truncate-end" color="cyan">
              Linked from {skill.linkedFrom.length}: {skill.linkedFrom.map(short).join(', ')}
            </Text>
          ) : null}
        </>
      );
    }
    if (item) {
      const blocked = cannotRestore(item, { kind: 'original' });
      return (
        <>
          <Text bold>{item.name}</Text>
          <Text>Deleted {fmtDate(item.deletedAt)}</Text>
          {item.entries.map((e, i) => (
            <Text key={i} wrap="truncate-end">
              {e.scope === 'project' ? 'project' : 'global '} {short(path.join(e.dir, e.name))}
              {e.link ? <Text color="cyan"> → {e.link}</Text> : null}
            </Text>
          ))}
          {blocked ? <Text color="red">{blocked} — can only be restored to global or the current project</Text> : null}
        </>
      );
    }
    return <Text dimColor>(nothing selected)</Text>;
  };

  const modalView = (): React.ReactNode => {
    if (!modal) return null;
    if (modal.kind === 'help') {
      return [
        'tab / 1 2 3     switch panel',
        'j k ↑ ↓ g G     move',
        'shift+↑ ↓       select range',
        'space           toggle current item',
        'esc             clear selection',
        'enter l →       open file list / h esc ← back',
        'J K ^d ^u       scroll preview',
        '/               filter by name (esc clears)',
        'd               move selection to trash (in Trash: delete permanently)',
        'D               delete current skill permanently, skipping trash',
        'r               restore selected trash items',
        'R               refresh',
        'q               quit',
        '',
        '↪ symlink   ✗ broken link   G/P trashed from global/project',
        '',
        'press any key to close',
      ].map((l, i) => <Text key={i}>{l}</Text>);
    }
    if (modal.kind === 'delete') {
      const ss = modal.skills;
      return (
        <>
          <Text bold color="yellow">Move {ss.length} skill(s) to trash?</Text>
          {ss.flatMap((s) => [s.path, ...s.linkedFrom]).map((p) => (
            <Text key={p} wrap="truncate-end">  {short(p)}</Text>
          ))}
          {ss.some((s) => s.link) ? <Text dimColor>Symlinks: only the link is removed; the original stays.</Text> : null}
          {ss.some((s) => s.linkedFrom.length) ? <Text dimColor>Links pointing to an original folder move with it (and are restored with it).</Text> : null}
          <Text> </Text>
          <Text>[y] move  [n/esc] cancel</Text>
        </>
      );
    }
    if (modal.kind === 'remove') {
      const s = modal.skill;
      return (
        <>
          <Text bold color="red">Delete permanently, skipping trash? This cannot be undone.</Text>
          {[s.path, ...s.linkedFrom].map((p) => (
            <Text key={p} wrap="truncate-end">  {short(p)}</Text>
          ))}
          {s.link ? <Text dimColor>Only the link is removed; the original ({s.real ? short(s.real) : s.link}) stays.</Text> : null}
          {s.linkedFrom.length ? <Text dimColor>Links pointing to this skill are deleted too.</Text> : null}
          <Text> </Text>
          <Text>[y] delete permanently  [n/esc] cancel</Text>
        </>
      );
    }
    if (modal.kind === 'purge') {
      return (
        <>
          <Text bold color="red">Delete {modal.items.length} item(s) permanently? This cannot be undone.</Text>
          {modal.items.map((it) => (
            <Text key={it.id}>  {it.name}</Text>
          ))}
          <Text> </Text>
          <Text>[y] delete permanently  [n/esc] cancel</Text>
        </>
      );
    }
    const its = modal.items;
    return (
      <>
        <Text bold color="yellow">Restore: {its.map((it) => it.name).join(', ')}</Text>
        {targets.map((t) => {
          const blocked = t.target ? its.filter((it) => cannotRestore(it, t.target!)) : its;
          const ok = its.filter((it) => !blocked.includes(it));
          return (
            <Box key={t.key} flexDirection="column" marginTop={1}>
              <Text color={ok.length ? undefined : 'gray'} wrap="truncate-end">
                [{t.key}] {t.label}
                {blocked.length ? (
                  <Text color="red">
                    {' '}— {ok.length ? `${blocked.length} skipped: ` : ''}
                    {t.target ? blocked.map((it) => `${it.name}(${cannotRestore(it, t.target!)})`).join(', ') : t.reason}
                  </Text>
                ) : null}
              </Text>
              {ok.flatMap((it) => restorePlan(ctx, it, t.target!)).map((p, i) => (
                <Text key={i} dimColor wrap="truncate-end">      {short(p.dest)}</Text>
              ))}
            </Box>
          );
        })}
        <Text> </Text>
        <Text>[esc] cancel</Text>
      </>
    );
  };

  const hints = modal
    ? ''
    : picked.length
      ? `${picked.length} selected  ${panel === 'trash' ? 'r restore  d purge' : 'd trash'}  space toggle  esc clear`
    : inFiles
      ? 'j/k file  J/K scroll  esc back  d trash  ? help'
      : panel === 'trash'
        ? 'r restore  d purge  shift+↑↓ select  enter files  / filter  tab panel  ? help  q quit'
        : 'd trash  D delete  shift+↑↓ select  enter files  / filter  tab panel  ? help  q quit';

  return (
    <Box flexDirection="column" width={columns} height={rows}>
      <Box>
        <Box flexDirection="column" width={leftW}>
          {PANELS.map((p, i) => {
            const active = p === panel && !inFiles;
            const size = panelH[i] - 3;
            const list = lists[p];
            const marked = p === panel && (picked.length > 0) ? isMarked : undefined;
            return (
              <Panel key={p} title={titles[p]} active={p === panel} width={leftW} height={panelH[i]}>
                {p === 'trash' ? (
                  <Rows items={list as TrashItem[]} cursor={clamp(cursor[p], list.length)} size={size} active={active} render={trashRow} marked={marked} />
                ) : (
                  <Rows items={list as Skill[]} cursor={clamp(cursor[p], list.length)} size={size} active={active} render={skillRow} marked={marked} />
                )}
              </Panel>
            );
          })}
        </Box>
        {modal ? (
          <Panel title={modal.kind === 'help' ? 'Help' : 'Confirm'} active width={rightW} height={H}>
            {modalView()}
          </Panel>
        ) : (
          <Box flexDirection="column" width={rightW}>
            <Box ref={infoRef} flexShrink={0}>
              <Panel title="Info" active={false} width={rightW} maxHeight={infoMax}>
                {info()}
              </Panel>
            </Box>
            <Box>
              <Panel title={`Files (${files.length})`} active={inFiles} width={filesW} height={bodyH}>
                <Rows
                  items={files}
                  cursor={fcur}
                  size={bodyH - 3}
                  active={inFiles}
                  render={(f) => (
                    <Text color={f.isDir ? 'blue' : undefined}>
                      {'  '.repeat(f.depth)}
                      {path.basename(f.rel)}
                      {f.isDir ? '/' : ''}
                    </Text>
                  )}
                />
              </Panel>
              <Panel title={previewFile ? short(previewFile) : 'Preview'} active={false} width={rightW - filesW} height={bodyH}>
                {preview.slice(scroll, scroll + previewSize).map((l, i) => (
                  <Text key={i} wrap="truncate-end">
                    {l || ' '}
                  </Text>
                ))}
              </Panel>
            </Box>
          </Box>
        )}
      </Box>
      <Text wrap="truncate-end">
        {filtering || filter ? <Text color="yellow">/{filter}{filtering ? '█' : ''}  </Text> : null}
        {msg ? <Text color={msg.error ? 'red' : 'green'}>{msg.text}  </Text> : null}
        <Text dimColor>{hints}</Text>
      </Text>
    </Box>
  );
}
