/**
 * 꾸민 시스템 화면 검증.
 *
 * 고르는 것이 없어 목록을 쓰지 않는다. 왼쪽 계기판이 조작을 받고(탭 새로
 * 읽기, 더블탭 뒤로), 오른쪽에 CPU를 많이 쓰는 프로세스를 둔다. 못 구한
 * 값은 '—'로 비운다 — 0%나 -1을 그대로 두면 사실과 다른 값이 남는다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext';
import { G2Display } from '../src/adapters/g2-display.js';
import type { Box } from '../src/adapters/g2-home.js';
import { layoutSystem } from '../src/adapters/g2-sys.js';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { GestureEvent, GlassesAdapter, SystemView } from '../src/core/glasses.js';

const VIEW: SystemView = {
  title: '$ ~/sys',
  status: '읽음 14:05:12',
  summary: { cpu: 15.2, mem: { used: 31.9, total: 64 }, load: [2.3, 2.58, 2.42], uptime: '16일 6시간' },
  procs: [
    { name: 'WindowServer', cpu: 12.4 },
    { name: 'Google Chrome Helper (Renderer) 아주 긴 프로세스 이름', cpu: 8.1 },
    { name: 'node', cpu: 6.3 },
    { name: 'claude', cpu: 4.8 },
    { name: 'mds_stores', cpu: 1.1 },
  ],
  hint: '● 새로 읽기    ●● 뒤로',
  note: 'mac-dev',
};

const inner = (b: Box) => b.w - 2 * (b.padding + (b.border?.width ?? 0));
const innerH = (b: Box) => b.h - 2 * (b.padding + (b.border?.width ?? 0));
const fits = (b: Box & { text: string }) =>
  b.text.split('\n').every((l) => measureTextWrap(l, inner(b)).lineCount <= 1) &&
  innerH(b) >= b.text.split('\n').length * 27;

test('계기판과 프로세스 카드가 칸 안에 들고 겹치지 않는다', () => {
  const l = layoutSystem(VIEW);
  assert.ok(fits(l.gauges), l.gauges.text);
  assert.ok(fits(l.procs!), l.procs!.text);
  assert.ok(fits(l.footer));
  assert.ok(l.gauges.x + l.gauges.w <= l.procs!.x, '두 카드가 겹친다');
  assert.ok(l.procs!.x + l.procs!.w <= 576);
  assert.ok(Math.max(l.gauges.y + l.gauges.h, l.procs!.y + l.procs!.h) <= l.footer.y, '안내 줄을 덮는다');
});

test('게이지와 비율, 프로세스는 네 개까지', () => {
  const l = layoutSystem(VIEW);
  assert.match(l.gauges.text, /^cpu\s+█▒{6}\s+15%\nmem\s+███▒{4}\s+50%/);
  // 막대가 같은 자리에서 시작한다. 이름 폭이 달라도 공백으로 맞춘다.
  const [cpuLine, memLine] = l.gauges.text.split('\n');
  const start = (line: string) => getTextWidth(line.slice(0, line.search(/[█▒]/)));
  assert.ok(Math.abs(start(cpuLine!) - start(memLine!)) <= 3, `${start(cpuLine!)} vs ${start(memLine!)}`);
  assert.match(l.gauges.text, /load\s+2\.3 {2}2\.6 {2}2\.4/);
  assert.match(l.gauges.text, /mem\s+31\.9 \/ 64 GB$/);
  const rows = l.procs!.text.split('\n');
  assert.equal(rows.length, 5, '제목 + 넷');
  assert.match(rows[0]!, /^프로세스\s+CPU$/);
  assert.match(rows[2]!, /\.\.\.\s+8\.1%$/, '긴 이름은 줄이고 숫자는 남긴다');
});

test('못 구한 값은 —로 비운다', () => {
  const l = layoutSystem({ ...VIEW, summary: { cpu: null, mem: null, load: [], uptime: '' }, procs: [] });
  assert.match(l.gauges.text, /^cpu\s+▒{7}\s+—\nmem\s+▒{7}\s+—\nload\s+—\nup\s+—\nmem\s+—$/);
  assert.match(l.procs!.text, /읽지 못했습니다/);
});

test('요약이 없으면 안내 카드 하나만 두고 그것이 조작을 받는다', async () => {
  const l = layoutSystem({ ...VIEW, summary: undefined, procs: [], notice: '시스템 상태를 읽지 못했습니다' });
  assert.equal(l.procs, undefined);
  assert.ok(fits(l.gauges));
  assert.match(l.gauges.text, /시스템 상태를 읽지 못했습니다/);

  const calls: string[] = [];
  const display = new G2Display();
  (display as unknown as { bridge: unknown }).bridge = {
    async rebuildPageContainer(c: { textObject?: { containerName?: string; isEventCapture?: number }[]; listObject?: unknown[] }) {
      calls.push(`list=${c.listObject?.length ?? 0} capture=${(c.textObject ?? []).filter((t) => t.isEventCapture === 1).map((t) => t.containerName).join(',')} n=${c.textObject?.length}`);
      return true;
    },
    async textContainerUpgrade() { return true; },
  };
  await display.showSystem({ ...VIEW, summary: undefined, procs: [] });
  await display.showSystem(VIEW);
  assert.deepEqual(calls, ['list=0 capture=side n=5', 'list=0 capture=side n=6']);
});

test('본체: 읽은 시각을 초까지, -1 값은 null로, .local은 떼고 넘긴다', async () => {
  let seen: SystemView | undefined;
  const glasses = {
    name: 'stub', isVoiceEnabled: false,
    async connect() {}, async disconnect() {}, async showList() {}, async showText() {}, async showHome() {},
    async showSystem(v: SystemView) { seen = v; },
    speak() {}, stopSpeaking() {}, setVoiceEnabled() {},
    async saveSetting() {}, async loadSetting() { return ''; },
    onGesture(_cb: (e: GestureEvent) => void) { return () => {}; },
  } as unknown as GlassesAdapter;
  const orig = { ...agentCli };
  Object.assign(agentCli, {
    listSessions: async () => [],
    listNotifications: async () => ({ items: [], unread: 0 }),
    getGlobalChecklist: async () => [],
    sysSummary: async () => ({
      cpuPercent: -1, memUsedGB: 10, memTotalGB: 0, load: [1.5], uptime: '3일', host: 'kairu.local', os: 'darwin',
    }),
    sysProcs: async () => [{ pid: 1, cpu: -1, mem: 0, name: 'x' }],
  });
  try {
    const ui = new GlassesUI(glasses, { onLog: () => {} });
    await ui.start();
    const r = ui as unknown as Record<string, unknown> & { refreshSystem(): Promise<void> };
    r.screen = 'system';
    await r.refreshSystem();
    assert.equal(seen!.title, '$ ~/sys');
    assert.match(seen!.status, /^읽음 \d\d:\d\d:\d\d$/);
    assert.equal(seen!.summary!.cpu, null);
    assert.equal(seen!.summary!.mem, null);
    assert.equal(seen!.procs[0]!.cpu, null);
    assert.equal(seen!.note, 'kairu');
  } finally {
    Object.assign(agentCli, orig);
  }
});
