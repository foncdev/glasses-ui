/**
 * 본체가 꾸민 홈에 넘기는 값 검증.
 *
 * 메뉴 오른쪽에는 드물게 바뀌는 값만, 자주 바뀌는 값은 상태 표시줄에.
 * 그래야 작업 중 수가 오르내릴 때마다 목록이 다시 세워지지 않는다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { GestureEvent, GlassesAdapter, HomeView, SessionsView } from '../src/core/glasses.js';
import { GLASSES_LOGO } from '../src/adapters/g2-logo.js';

async function homeWith(sessions: unknown[], sys?: unknown, openSessions = false) {
  const views: HomeView[] = [];
  const sessionViews: SessionsView[] = [];
  const glasses = {
    name: 'stub',
    logo: GLASSES_LOGO,
    isVoiceEnabled: false,
    async connect() {},
    async disconnect() {},
    async showList() {},
    async showText() {},
    async showHome(v: HomeView) {
      views.push(v);
    },
    async showSessions(v: SessionsView) {
      sessionViews.push(v);
    },
    speak() {},
    stopSpeaking() {},
    setVoiceEnabled() {},
    async saveSetting() {},
    async loadSetting() {
      return '';
    },
    onGesture(_cb: (e: GestureEvent) => void) {
      return () => {};
    },
  } as unknown as GlassesAdapter;

  const orig = { ...agentCli };
  Object.assign(agentCli, {
    listSessions: async () => sessions,
    listNotifications: async () => ({ items: [], unread: 3 }),
    getGlobalChecklist: async () => [
      { id: 'a', text: 'x', done: true, createdAt: '' },
      { id: 'b', text: 'y', done: false, createdAt: '' },
    ],
    sysSummary: async () => {
      if (!sys) throw new Error('terminal-agent 없음');
      return sys;
    },
  });
  try {
    const ui = new GlassesUI(glasses, { onLog: () => {} });
    await ui.start();
    await (ui as unknown as { refreshSummary(): Promise<void> }).refreshSummary();
    if (openSessions) {
      await (ui as unknown as { openMenu(t: string): Promise<void> }).openMenu('sessions');
      return sessionViews.at(-1)! as unknown as HomeView;
    }
    return views.at(-1)!;
  } finally {
    Object.assign(agentCli, orig);
  }
}

const SESSIONS = [
  { id: 'a', title: 'a', live: true, status: 'busy' },
  { id: 'b', title: 'b', live: true, status: 'idle' },
];

test('메뉴 오른쪽에는 세션 수·안 읽은 알림·할 일만 둔다', async () => {
  const v = await homeWith(SESSIONS);
  const meta = Object.fromEntries(v.items.map((i) => [i.label, i.meta]));
  assert.equal(meta['에이전트'], '2', '작업 중 수가 아니라 전체 수');
  assert.equal(meta['알림 보기'], '3 new');
  assert.equal(meta['체크 보기'], '1 / 2');
});

test('작업 중 수와 시각은 상태 표시줄에 둔다', async () => {
  const v = await homeWith(SESSIONS);
  assert.match(v.status, /작업 1/);
  assert.match(v.status, /\d\d:\d\d/);
  assert.match(v.title, /relay/);
});

test('시스템 상태를 읽으면 게이지를, 못 읽으면 게이지 없이 그린다', async () => {
  const withSys = await homeWith(SESSIONS, {
    cpuPercent: 42, memUsedGB: 6, memTotalGB: 16, load: [], uptime: '', host: '', os: '',
  });
  assert.deepEqual(withSys.gauges?.map((g) => [g.label, g.text]), [['cpu', '42%'], ['mem', '38%']]);

  const without = await homeWith(SESSIONS);
  assert.equal(without.gauges, undefined);
});

test('세션 화면은 상태 기호용 상태·경과 시간·상태별 개수를 넘긴다', async () => {
  const now = Date.now();
  const v = (await homeWith(
    [
      { id: 'a', title: '빌드', live: true, status: 'busy', lastActivityAt: new Date(now - 30_000).toISOString(), pending: [] },
      { id: 'b', title: '', live: true, status: 'idle', lastActivityAt: new Date(now - 5 * 60_000).toISOString(), pending: [{ id: 'p' }] },
      { id: 'c', title: '끝남', live: false, status: 'closed', lastActivityAt: new Date(now - 30 * 3600_000).toISOString(), pending: [] },
    ],
    undefined,
    true,
  )) as unknown as SessionsView;
  assert.deepEqual(
    v.rows.map((r) => [r.state, r.title, r.meta]),
    [['running', '빌드', '방금'], ['pending', '새 대화', '5분'], ['offline', '끝남', '어제']],
  );
  assert.deepEqual(v.counts.map((c) => c.count), [1, 1, 0, 1]);
  assert.match(v.status, /작업 1/);
  assert.match(v.status, /◆ 승인 1/);
  assert.equal(v.total, '세션 3개');
});
