/**
 * 꾸민 대화 화면(대화 목록·진행 중 대화·권한 요청) 검증.
 *
 * 진행 중 대화는 도는 기호가 1.5초마다 돌아서, 그때마다 다시 세우면
 * 깜빡인다. 글자만 고쳐야 한다. 권한 요청은 거부가 맨 위여야 한다 —
 * 잘못 탭해도 승인되지 않게.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { measureTextWrap } from '@evenrealities/pretext';
import { G2Display } from '../src/adapters/g2-display.js';
import { ITEM_MAX_BYTES, utf8Bytes } from '../src/adapters/g2-bytes.js';
import type { Box } from '../src/adapters/g2-home.js';
import { layoutHistory, layoutLive, layoutPermission } from '../src/adapters/g2-talk.js';
import { GlassesUI, toolBrief } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type {
  GestureEvent,
  GlassesAdapter,
  HistoryView,
  LiveView,
  PermissionView,
} from '../src/core/glasses.js';

const inner = (b: Box) => b.w - 2 * (b.padding + (b.border?.width ?? 0));
const innerH = (b: Box) => b.h - 2 * (b.padding + (b.border?.width ?? 0));
const fits = (b: Box & { text: string }) =>
  b.text.split('\n').every((l) => measureTextWrap(l, inner(b)).lineCount <= 1) &&
  innerH(b) >= b.text.split('\n').length * 27;
const onScreen = (b: Box) => b.x >= 0 && b.y >= 0 && b.x + b.w <= 576 && b.y + b.h <= 288;

const HISTORY: HistoryView = {
  title: '$ ~/agent-cli 테스트 보강',
  status: '14:05',
  rows: [
    { kind: 'me', text: 'runner 테스트가 윈도우에서 깨지는지 봐줘' },
    { kind: 'ai', text: '윈도우에서는 sh 문법을 쓰는 테스트 두 개가 실패합니다. 건너뛰도록 고치겠습니다' },
  ],
  action: '대화 이어서 보기',
  info: {
    state: 'idle',
    label: '대기',
    rows: [
      { label: '턴', value: '12' },
      { label: '비용', value: '$0.42' },
      { label: '폴더', value: 'agent-cli' },
      { label: '활동', value: '12분 전' },
    ],
  },
  hint: '● 전문 보기    ●● 뒤로',
};

test('대화 목록: 나·AI 기호, 63바이트, 끝에 이어 보기, 폴더 이름이 잘리지 않는다', () => {
  const l = layoutHistory(HISTORY);
  assert.ok(l.list.items[0]!.startsWith('▷') && l.list.items[1]!.startsWith('◆'));
  assert.equal(l.list.items.at(-1), '»  대화 이어서 보기');
  for (const i of l.list.items) assert.ok(utf8Bytes(i) <= ITEM_MAX_BYTES, `${utf8Bytes(i)}: ${i}`);
  assert.match(l.card.text, /폴더\s+agent-cli/, '짧은 라벨 옆 긴 값을 자르지 않는다');
  assert.ok(fits(l.card) && fits(l.footer) && onScreen(l.card) && onScreen(l.list));
});

const LIVE: LiveView = {
  title: '$ ~/agent-cli 테스트 보강',
  status: '작업 중   14:05',
  lines: [
    { kind: 'me', text: '커밋까지 해줘' },
    { kind: 'ai', text: '변경을 확인하고 커밋하겠습니다' },
    { kind: 'tool', text: 'Bash  git status --porcelain --untracked-files=all --ignored' },
  ],
  activity: { text: 'Bash  git commit -F -', elapsed: '12초', tick: 0 },
  idle: '대기  ·  탭하면 할 일',
  hint: '● 할 일    ●● 뒤로',
  meta: '턴 12  ·  $0.42',
};

test('진행 중 대화: 기록·진행 카드가 칸 안에 들고, 긴 도구 줄은 한 줄로 자른다', () => {
  const l = layoutLive(LIVE);
  assert.ok(fits(l.log) && fits(l.activity) && fits(l.footer));
  assert.ok(onScreen(l.log) && onScreen(l.activity) && l.activity.y + l.activity.h <= 256);
  assert.match(l.log.text, /^▷ 커밋까지 해줘\n◆ .*\n└ Bash/);
  assert.match(l.activity.text, /^◐\s+Bash\s+git commit -F -\s+12초$/);
  assert.match(layoutLive({ ...LIVE, activity: { ...LIVE.activity!, tick: 1 } }).activity.text, /^◑/);
  assert.match(layoutLive({ ...LIVE, activity: undefined }).activity.text, /^○\s+대기/);
  assert.equal(layoutLive({ ...LIVE, lines: [] }).log.text, ' ');
});

const PERM: PermissionView = {
  title: '$ ~/agent-cli 테스트 보강',
  status: '◆ 권한 요청   14:05',
  tool: 'Bash',
  summary: 'git push origin main --force-with-lease && echo 아주 긴 명령이 들어와도 한 줄로',
  choices: [
    { kind: 'deny', label: '거부' },
    { kind: 'once', label: '허용 (이번만)' },
    { kind: 'always', label: '허용 (이 세션 계속)' },
  ],
  hint: '더블탭 = 거부',
};

test('권한 요청: 거부가 맨 위이고 카드·목록이 화면 안에 있다', () => {
  const l = layoutPermission(PERM);
  assert.equal(l.list.items[0], '○  거부');
  assert.ok(l.list.items[1]!.startsWith('●') && l.list.items[2]!.startsWith('◎'));
  assert.ok(fits(l.card) && onScreen(l.card) && onScreen(l.list));
  assert.match(l.card.text, /^◆\s+Bash\s+더블탭 = 거부\n\$ git push/);
});

function fakeBridge() {
  const calls: string[] = [];
  const bridge = {
    async rebuildPageContainer(c: { textObject?: { containerName?: string; isEventCapture?: number }[]; listObject?: unknown[] }) {
      const cap = (c.textObject ?? []).filter((t) => t.isEventCapture === 1).map((t) => t.containerName);
      calls.push(`rebuild list=${c.listObject?.length ?? 0} capture=${cap.join(',')}`);
      return true;
    },
    async textContainerUpgrade(c: { containerName?: string }) {
      calls.push(`upgrade:${c.containerName}`);
      return true;
    },
  };
  const display = new G2Display();
  (display as unknown as { bridge: unknown }).bridge = bridge;
  return { display, calls };
}

test('진행 중 대화: 기호가 돌거나 줄이 늘면 글자만 고친다', async () => {
  const { display, calls } = fakeBridge();
  await display.showLive(LIVE);
  const turned = { ...LIVE, activity: { ...LIVE.activity!, tick: 1, elapsed: '13초' } };
  await display.showLive(turned);
  await display.showLive({ ...turned, lines: [...LIVE.lines, { kind: 'ai', text: '커밋했습니다' }] });
  assert.deepEqual(calls, ['rebuild list=0 capture=body', 'upgrade:side', 'upgrade:body']);
});

test('진행 중 대화: 작업이 끝나면(카드 테두리가 바뀌면) 다시 세운다', async () => {
  const { display, calls } = fakeBridge();
  await display.showLive(LIVE);
  await display.showLive({ ...LIVE, activity: undefined });
  assert.equal(calls.filter((c) => c.startsWith('rebuild')).length, 2);
});

test('대화 목록·권한 요청은 목록이 조작을 받는다', async () => {
  const { display, calls } = fakeBridge();
  await display.showHistory(HISTORY);
  await display.showPermission(PERM);
  assert.deepEqual(calls, ['rebuild list=1 capture=', 'rebuild list=1 capture=']);
});

test('도구 입력에서 보여줄 대상을 고른다', () => {
  assert.equal(toolBrief({ command: 'git status\ngit diff' }), 'git status');
  assert.equal(toolBrief({ file_path: '/Users/me/develop/app/src/index.ts' }), 'src/index.ts');
  assert.equal(toolBrief({ pattern: 'TODO' }), 'TODO');
  assert.equal(toolBrief({}), '');
  assert.equal(toolBrief(undefined), '');
});

// --- 본체가 넘기는 값 ---

async function uiAt() {
  const seen: { live?: LiveView; history?: HistoryView; perm?: PermissionView } = {};
  const glasses = {
    name: 'stub', isVoiceEnabled: false,
    async connect() {}, async disconnect() {}, async showList() {}, async showText() {}, async showHome() {},
    async showLive(v: LiveView) { seen.live = v; },
    async showHistory(v: HistoryView) { seen.history = v; },
    async showPermission(v: PermissionView) { seen.perm = v; },
    speak() {}, stopSpeaking() {}, setVoiceEnabled() {},
    async saveSetting() {}, async loadSetting() { return ''; },
    onGesture(_cb: (e: GestureEvent) => void) { return () => {}; },
  } as unknown as GlassesAdapter;
  const orig = { ...agentCli };
  Object.assign(agentCli, {
    listSessions: async () => [],
    listNotifications: async () => ({ items: [], unread: 0 }),
    getGlobalChecklist: async () => [],
    sysSummary: async () => { throw new Error('x'); },
  });
  const ui = new GlassesUI(glasses, { onLog: () => {} });
  await ui.start();
  const r = ui as unknown as Record<string, unknown> & {
    render(): Promise<void>;
    handleEvent(e: unknown): Promise<void>;
    setSpinning(on: boolean): void;
  };
  r.sessions = [{ id: 's', title: '빌드 고치기', live: true, status: 'busy', turns: 3, totalCostUsd: 0.1234, cwd: '/Users/me/develop/app', lastActivityAt: new Date().toISOString(), pending: [], workspaceId: 'w' }];
  r.activeId = 's';
  return { seen, r, restore: () => Object.assign(agentCli, orig) };
}

test('본체: 진행 중 대화에 나·AI·도구 줄과 지금 하는 일(명령까지)을 넘긴다', async () => {
  const t = await uiAt();
  try {
    t.r.screen = 'detail';
    t.r.status = 'busy';
    for (const e of [
      { type: 'user', text: '테스트 돌려줘' },
      { type: 'assistant', text: '돌려 보겠습니다\n자세한 설명' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ]) await t.r.handleEvent({ sessionId: 's', at: '', ...e });
    t.r.setSpinning(false);
    const v = t.seen.live!;
    assert.deepEqual(v.lines, [
      { kind: 'me', text: '테스트 돌려줘' },
      { kind: 'ai', text: '돌려 보겠습니다' },
      { kind: 'tool', text: 'Bash  npm test' },
    ]);
    assert.equal(v.activity?.text, 'Bash  npm test');
    assert.equal(v.meta, '턴 3  ·  $0.12');
    assert.match(v.status, /^작업 중/);
  } finally {
    t.restore();
  }
});

test('본체: 대화 목록 카드에 상태·턴·비용·폴더를 넘긴다', async () => {
  const t = await uiAt();
  try {
    t.r.screen = 'history';
    t.r.history = [
      { type: 'user', text: '안녕', sessionId: 's', at: '' },
      { type: 'assistant', text: '무엇을\n도와드릴까요', sessionId: 's', at: '' },
    ];
    await t.r.render();
    const v = t.seen.history!;
    assert.deepEqual(v.rows, [{ kind: 'me', text: '안녕' }, { kind: 'ai', text: '무엇을 도와드릴까요' }]);
    const info = Object.fromEntries(v.info.rows.map((x) => [x.label, x.value]));
    assert.deepEqual([info['턴'], info['비용'], info['폴더']], ['3', '$0.12', 'app']);
  } finally {
    t.restore();
  }
});

test('본체: 권한 요청 선택지는 거부가 맨 앞이다', async () => {
  const t = await uiAt();
  try {
    t.r.pending = { id: 'p', toolName: 'Bash', summary: 'rm -rf dist\n두 번째 줄' };
    await t.r.render();
    const v = t.seen.perm!;
    assert.deepEqual(v.choices.map((c) => c.kind), ['deny', 'once', 'always']);
    assert.equal(v.summary, 'rm -rf dist 두 번째 줄');
    assert.equal(v.tool, 'Bash');
  } finally {
    t.restore();
  }
});

test('목록은 항목 수만큼만 높다(적으면 펌웨어가 가운데로 내려 그린다)', () => {
  // 2줄 + 이어 보기 = 3칸
  assert.equal(layoutHistory(HISTORY).list.h, 3 * 40 + 8);
  const many = { ...HISTORY, rows: Array.from({ length: 9 }, (_, i) => ({ kind: 'me' as const, text: `${i}` })) };
  assert.equal(layoutHistory(many).list.h, 5 * 40 + 8, '5칸을 넘으면 스크롤');
});

test('본체: 승인을 기다리는 동안 하던 일을 지우지 않는다', async () => {
  const t = await uiAt();
  try {
    t.r.screen = 'detail';
    const ev = (e: Record<string, unknown>) => t.r.handleEvent({ sessionId: 's', at: '', ...e });
    await ev({ type: 'status', status: 'busy' });
    await ev({ type: 'tool_use', name: 'Bash', input: { command: 'sleep 6' } });
    await ev({ type: 'status', status: 'waiting' });
    await ev({ type: 'status', status: 'busy' });
    assert.equal(t.seen.live?.activity?.text, 'Bash  sleep 6');
    await ev({ type: 'status', status: 'idle' });
    assert.equal(t.seen.live?.activity, undefined, '끝나면 지운다');
    t.r.setSpinning(false);
  } finally {
    t.restore();
  }
});
