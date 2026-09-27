/**
 * 꾸민 명령 화면(목록·실행 결과) 검증.
 *
 * 직접 ▷, 예약 ∞, 성공 ◎, 실패 ◇, 확인 필요 ▲. 목록은 스크롤 이벤트가
 * 오지 않아 오른쪽 카드는 고른 것과 상관없는 요약이다. 결과 화면은
 * 목록이 없어 카드가 조작을 받는다 — 확인이 필요하면 탭이 실행이다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { measureTextWrap } from '@evenrealities/pretext';
import { G2Display } from '../src/adapters/g2-display.js';
import { ITEM_MAX_BYTES, utf8Bytes } from '../src/adapters/g2-bytes.js';
import type { Box } from '../src/adapters/g2-home.js';
import { every, layoutCommandResult, layoutCommands } from '../src/adapters/g2-cmd.js';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli, type Snippet } from '../src/core/agent-cli.js';
import type { CommandResultView, CommandsView, GestureEvent, GlassesAdapter } from '../src/core/glasses.js';

const LIST: CommandsView = {
  title: '$ ~/cmd',
  status: '예약 2   14:05',
  rows: [
    { label: '디스크' },
    { label: '저장소 상태 전체 점검하고 결과를 요약해서 보여주기', cron: 90 },
    { label: 'relay 로그 끝 20줄' },
    { label: '빌드 서버 핑', cron: 120 },
  ],
  counts: { once: 2, cron: 2 },
  last: { label: '디스크', exitCode: 0, ago: '2분 전' },
  hint: '● 실행    ●● 뒤로',
  note: '폰·웹에서 등록',
};

const OUT = [
  'Filesystem      Size   Used  Avail Capacity  iused ifree %iused  Mounted on',
  '/dev/disk3s1s1  926Gi   11Gi  512Gi     3%    453k  4.3G    0%   /',
  '/dev/disk3s5    926Gi  398Gi  512Gi    44%    3.1M  5.4G    0%   /System/Volumes/Data',
  'a', 'b', 'c', 'd', 'e', 'f',
];

const RESULT: CommandResultView = {
  title: '$ 디스크',
  status: '◎ 종료 0 · 0.4초   14:05',
  state: 'done',
  command: 'df -h',
  lines: OUT,
  hint: '●● 목록으로',
  note: 'df -h',
};

const inner = (b: Box) => b.w - 2 * (b.padding + (b.border?.width ?? 0));
const innerH = (b: Box) => b.h - 2 * (b.padding + (b.border?.width ?? 0));
const fits = (b: Box & { text: string }) =>
  b.text.split('\n').every((l) => measureTextWrap(l, inner(b)).lineCount <= 1) &&
  innerH(b) >= b.text.split('\n').length * 27;

test('목록: 직접 ▷·예약 ∞와 주기, 63바이트, 요약 카드가 칸 안에 든다', () => {
  const l = layoutCommands(LIST);
  const items = l.list!.items;
  assert.ok(items[0]!.startsWith('▷') && items[1]!.startsWith('∞'));
  assert.match(items[1]!, /90분$/);
  assert.match(items[3]!, /2시간$/);
  for (const i of items) assert.ok(utf8Bytes(i) <= ITEM_MAX_BYTES, `${utf8Bytes(i)}: ${i}`);
  assert.ok(fits(l.card), l.card.text);
  assert.match(l.card.text, /▷\s+직접\s+2\n∞\s+예약\s+2\n\n디스크\n◎\s+종료 0\s+2분 전/);
  assert.equal(l.card.capture, false);
  assert.equal(every(45), '45분');
});

test('목록: 한 번도 안 돌았으면 마지막 실행 줄이 없다', () => {
  const l = layoutCommands({ ...LIST, last: undefined });
  assert.equal(l.card.text.split('\n').length, 2);
  assert.ok(fits(l.card));
});

test('목록: 명령이 없으면 안내 카드가 조작을 받는다', async () => {
  const l = layoutCommands({ ...LIST, rows: [], counts: { once: 0, cron: 0 }, last: undefined });
  assert.equal(l.list, undefined);
  assert.equal(l.card.capture, true);
  assert.ok(fits(l.card));

  const calls: string[] = [];
  const display = new G2Display();
  (display as unknown as { bridge: unknown }).bridge = {
    async rebuildPageContainer(c: { textObject?: { containerName?: string; isEventCapture?: number }[]; listObject?: unknown[] }) {
      calls.push(`list=${c.listObject?.length ?? 0} capture=${(c.textObject ?? []).filter((t) => t.isEventCapture === 1).map((t) => t.containerName).join(',')}`);
      return true;
    },
    async textContainerUpgrade() { return true; },
  };
  await display.showCommands({ ...LIST, rows: [], counts: { once: 0, cron: 0 }, last: undefined });
  await display.showCommands(LIST);
  await display.showCommandResult(RESULT);
  assert.deepEqual(calls, ['list=0 capture=side', 'list=1 capture=', 'list=0 capture=side']);
});

test('결과: 줄마다 폭에 맞춰 자르고, 넘치면 여섯 줄에 몇 줄 더를 붙인다', () => {
  const l = layoutCommandResult(RESULT);
  assert.ok(fits(l.card), l.card.text);
  const rows = l.card.text.split('\n');
  assert.equal(rows.length, 7);
  assert.match(rows.at(-1)!, /… 3줄 더 · 폰에서 보기$/);
  assert.ok(rows[0]!.startsWith('Filesystem') && rows[0]!.endsWith('...'), '긴 줄은 자른다');
  assert.ok(l.card.y + l.card.h <= l.footer.y, '안내 줄을 덮는다');
});

test('결과: 일곱 줄 이하면 다 보이고, 출력이 없으면 (출력 없음)', () => {
  assert.equal(layoutCommandResult({ ...RESULT, lines: OUT.slice(0, 7) }).card.text.split('\n').length, 7);
  assert.match(layoutCommandResult({ ...RESULT, lines: [] }).card.text, /\(출력 없음\)/);
});

test('결과: 실행 중과 확인 필요', () => {
  const run = layoutCommandResult({ ...RESULT, state: 'running', lines: [] });
  assert.ok(fits(run.card));
  assert.match(run.card.text, /◐[\s\S]*실행 중…[\s\S]*\$ df -h/);

  const confirm = layoutCommandResult({
    ...RESULT, state: 'confirm', command: 'sudo shutdown -r now',
    lines: ['시스템을 끄거나 다시 켭니다', '저장하지 않은 작업을 잃을 수 있습니다', '셋', '넷은 버린다'],
  });
  assert.ok(fits(confirm.card), confirm.card.text);
  assert.equal(confirm.card.border?.width, 2, '굵은 테두리');
  assert.equal(confirm.card.brightness, 4);
  const rows = confirm.card.text.split('\n');
  assert.equal(rows.length, 5, '제목 + 명령 + 까닭 셋');
  assert.match(rows[0]!, /^▲/);
  assert.equal(rows[1], '$ sudo shutdown -r now');
});

test('본체: 목록 요약과 결과 상태 표시줄을 만든다', async () => {
  let list: CommandsView | undefined;
  let result: CommandResultView | undefined;
  let onG: ((e: GestureEvent) => void) | undefined;
  const glasses = {
    name: 'stub', isVoiceEnabled: false,
    async connect() {}, async disconnect() {}, async showList() {}, async showText() {}, async showHome() {},
    async showCommands(v: CommandsView) { list = v; },
    async showCommandResult(v: CommandResultView) { result = v; },
    speak() {}, stopSpeaking() {}, setVoiceEnabled() {},
    async saveSetting() {}, async loadSetting() { return ''; },
    onGesture(cb: (e: GestureEvent) => void) { onG = cb; return () => {}; },
  } as unknown as GlassesAdapter;
  const snippets: Snippet[] = [
    { id: 'a', label: '디스크', command: 'df -h', kind: 'once', lastRunAt: '2026-01-01T00:00:00Z', lastExitCode: 0 },
    { id: 'b', label: '핑', command: 'ping -c1 x', kind: 'cron', everyMinutes: 10, lastRunAt: '2026-01-02T00:00:00Z', lastExitCode: 1 },
  ];
  const orig = { ...agentCli };
  Object.assign(agentCli, {
    listSessions: async () => [],
    listNotifications: async () => ({ items: [], unread: 0 }),
    getGlobalChecklist: async () => [],
    sysSummary: async () => { throw new Error('x'); },
    streamEvents: () => () => undefined,
    listSnippets: async () => snippets,
    runSnippet: async () => ({ result: { output: 'line1\nline2\n', exitCode: 0, timedOut: false, tookMs: 1234 } }),
  });
  try {
    const ui = new GlassesUI(glasses, { onLog: () => {} });
    await ui.start();
    const r = ui as unknown as Record<string, unknown> & { openMenu(t: string): Promise<void> };
    r.screenOff = false;
    await r.openMenu('commands');
    assert.equal(list!.title, '$ ~/cmd');
    assert.match(list!.status, /^예약 1/);
    assert.deepEqual(list!.rows, [{ label: '디스크' }, { label: '핑', cron: 10 }]);
    assert.deepEqual(list!.counts, { once: 1, cron: 1 });
    assert.equal(list!.last!.label, '핑', '가장 최근에 돈 것');
    assert.equal(list!.last!.exitCode, 1);

    onG!({ gesture: 'tap', selectedIndex: 0 } as GestureEvent);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(result!.state, 'done');
    assert.equal(result!.title, '$ 디스크');
    assert.match(result!.status, /^◎ 종료 0 · 1\.2초/);
    assert.deepEqual(result!.lines, ['line1', 'line2'], '끝의 빈 줄은 버린다');
    assert.equal(result!.note, 'df -h');

    // 금방 끝나면 0.0초 대신 '0.1초 미만'.
    agentCli.runSnippet = async () => ({ result: { output: '', exitCode: 0, timedOut: false, tookMs: 12 } });
    onG!({ gesture: 'doubleTap' } as GestureEvent);
    await new Promise((res) => setTimeout(res, 50));
    onG!({ gesture: 'tap', selectedIndex: 0 } as GestureEvent);
    await new Promise((res) => setTimeout(res, 50));
    assert.match(result!.status, /^◎ 종료 0 · 0\.1초 미만/);
  } finally {
    Object.assign(agentCli, orig);
  }
});
