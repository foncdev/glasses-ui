/**
 * 폰(Relay 앱)의 타이머·물 마시기를 안경에 그리는 규칙.
 *
 * 상단 선은 타이머가 돌면 진행바가 된다. 진행바가 찰 때 화면을 다시 세우면
 * 목록 선택이 첫 항목으로 돌아가므로 글자만 고쳐야 한다(live).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getTextWidth } from '@evenrealities/pretext';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli, AgentCliError } from '../src/core/agent-cli.js';
import type { GestureEvent, GlassesAdapter, HomeView, NoticeView } from '../src/core/glasses.js';
import {
  durationLabel,
  phoneEvents,
  timerLabel,
  timerRatio,
  waterLabel,
  type PhoneStatus,
} from '../src/core/phone.js';
import { progressLine, TOP_BAR_W } from '../src/adapters/g2-home.js';

const idleWater = { enabled: false, count: 0, goal: 8 };

function status(timer: Partial<PhoneStatus['timer']>, water: Partial<PhoneStatus['water']> = {}): PhoneStatus {
  return {
    timer: { phase: 'idle', duration: 3600, remaining: 3600, progress: 0, ...timer },
    water: { ...idleWater, ...water },
  };
}

test('남은 시간은 받은 때부터 흐른 만큼 줄고, 멈췄으면 그대로다', () => {
  const t = status({ phase: 'running', duration: 600, remaining: 300 }).timer;
  assert.equal(timerRatio(t, 0, 0), 0.5);
  assert.equal(timerRatio(t, 0, 60_000), 0.6);
  assert.equal(timerLabel(t, 0, 61_000), '▶ 4분', '239초는 4분으로 올린다');
  const paused = { ...t, phase: 'paused' as const };
  assert.equal(timerLabel(paused, 0, 600_000), '■ 5분');
  assert.equal(timerRatio(status({}).timer, 0, 0), null, '안 쓰면 원래 선');
  assert.equal(timerLabel(status({ phase: 'done', remaining: 0 }).timer, 0, 0), '◆ 끝');
});

test('끝남·물 마실 때는 바뀐 순간에만 알린다', () => {
  const running = status({ phase: 'running' });
  assert.deepEqual(phoneEvents(undefined, status({ phase: 'done' })), [], '처음 받은 것에는 알리지 않는다');
  assert.deepEqual(phoneEvents(running, status({ phase: 'done' })), ['timerDone']);
  assert.deepEqual(phoneEvents(status({ phase: 'paused' }), status({ phase: 'done' })), []);

  const due = status({}, { enabled: true, lastDue: 1000 });
  assert.deepEqual(phoneEvents(status({}, { enabled: true, lastDue: 500 }), due), ['waterDue']);
  assert.deepEqual(phoneEvents(due, due), [], '같은 알림 시각이면 다시 알리지 않는다');
  assert.equal(waterLabel(due.water), '물 0/8');
  assert.equal(waterLabel(idleWater), '');
  assert.equal(durationLabel(3600), '60분');
  assert.equal(durationLabel(100), '1분 40초');
});

test('진행바는 폭이 늘 같고 지나간 만큼 굵다', () => {
  const empty = progressLine(0);
  const half = progressLine(0.5);
  const full = progressLine(1);
  assert.ok(!empty.includes('━') && !full.includes('─'));
  assert.equal(half.length, empty.length);
  assert.ok(getTextWidth(half) <= TOP_BAR_W, '화면 폭을 넘는다');
  assert.equal([...half].filter((c) => c === '━').length, Math.round(empty.length / 2));
});

test('타이머가 돌면 홈 상태에 남은 시간·물 잔 수가 붙고, 끝나면 팝업을 띄운다', async () => {
  const views: HomeView[] = [];
  const notices: NoticeView[] = [];
  const bars: (number | null)[] = [];
  const glasses = {
    name: 'stub',
    isVoiceEnabled: false,
    async connect() {},
    async disconnect() {},
    async showList() {},
    async showText() {},
    async showHome(v: HomeView) {
      views.push(v);
    },
    async showNotice(v: NoticeView) {
      notices.push(v);
    },
    setTopBar(ratio: number | null) {
      bars.push(ratio);
      return true;
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

  let next = status({ phase: 'running', duration: 600, remaining: 300 }, { enabled: true, count: 3 });
  const orig = { ...agentCli };
  Object.assign(agentCli, {
    listSessions: async () => [],
    listNotifications: async () => ({ items: [], unread: 0 }),
    getGlobalChecklist: async () => [],
    sysSummary: async () => {
      throw new Error('없음');
    },
    phoneStatus: async () => next,
  });
  Object.defineProperty(agentCli, 'canPoll', { get: () => true, configurable: true });
  // 폰은 로그인한 뒤에만 읽는다.
  Object.defineProperty(agentCli, 'isConfigured', { get: () => true, configurable: true });
  Object.defineProperty(agentCli, 'connection', {
    get: () => ({ baseUrl: 'http://127.0.0.1:4100', apiKey: 'KEY' }),
    configurable: true,
  });
  const ui = new GlassesUI(glasses, { onLog: () => {} });
  try {
    await ui.start();
    const refresh = () => (ui as unknown as { refreshPhone(): Promise<boolean> }).refreshPhone();
    await refresh();
    assert.ok(Math.abs((bars.at(-1) ?? 0) - 0.5) < 0.01, `진행바 ${bars.at(-1)}`);
    assert.match(views.at(-1)!.status, /▶ 5분 {2}물 3\/8/);

    // 한 번 못 읽어도 지우지 않는다. 지우면 진행바가 사라졌다 돌아오며 깜빡였다.
    const before = { bars: bars.length, views: views.length };
    let fail: Error | null = new Error('접속 실패');
    Object.assign(agentCli, {
      phoneStatus: async () => {
        if (fail) throw fail;
        return next;
      },
    });
    assert.equal(await refresh(), true, '가진 값으로 계속 돈다');
    assert.ok(!bars.slice(before.bars).includes(null), '진행바를 지웠다');
    assert.ok(views.slice(before.views).every((v) => /▶ 5분/.test(v.status)), '홈 상태에서 타이머가 빠졌다');

    // 폰이 이 경로를 모르면(404) 원래 선으로 돌린다.
    fail = new AgentCliError('없는 경로', 404);
    assert.equal(await refresh(), false);
    assert.equal(bars.at(-1), null, '폰이 모르면 원래 선으로 돌린다');

    // 다시 붙으면(돌던 중) 이어 보이고, 끝나면 알린다.
    fail = null;
    await refresh();
    assert.equal(notices.length, 0);
    next = status({ phase: 'done', duration: 600, remaining: 0 }, { enabled: true, count: 3 });
    await refresh();
    assert.equal(notices.at(-1)?.title, '타이머 종료');
  } finally {
    await ui.stop();
    Object.assign(agentCli, orig);
    delete (agentCli as { canPoll?: boolean }).canPoll;
    delete (agentCli as { isConfigured?: boolean }).isConfigured;
    delete (agentCli as { connection?: unknown }).connection;
  }
});

test('타이머가 겹쳐 불려도 폰 읽기는 늘지 않는다', async () => {
  // 안경 웹뷰는 미뤄 둔 타이머를 두 번 부르기도 한다. 예전에는 그때마다 읽기
  // 사슬이 갈라져 1분마다 네 배로 늘다 웹뷰가 죽었다.
  const glasses = {
    name: 'stub',
    isVoiceEnabled: false,
    async connect() {},
    async disconnect() {},
    async showList() {},
    async showText() {},
    async showHome() {},
    speak() {},
    stopSpeaking() {},
    setVoiceEnabled() {},
    async saveSetting() {},
    async loadSetting() {
      return '';
    },
    onGesture() {
      return () => {};
    },
  } as unknown as GlassesAdapter;
  let reads = 0;
  const orig = { ...agentCli };
  Object.assign(agentCli, {
    listSessions: async () => [],
    listNotifications: async () => ({ items: [], unread: 0 }),
    getGlobalChecklist: async () => [],
    phoneStatus: async () => {
      reads += 1;
      await new Promise((res) => setTimeout(res, 20));
      return status({ phase: 'running', duration: 600, remaining: 300 });
    },
  });
  Object.defineProperty(agentCli, 'canPoll', { get: () => true, configurable: true });
  Object.defineProperty(agentCli, 'isConfigured', { get: () => true, configurable: true });
  Object.defineProperty(agentCli, 'connection', {
    get: () => ({ baseUrl: 'http://127.0.0.1:4100', apiKey: 'KEY' }),
    configurable: true,
  });
  const ui = new GlassesUI(glasses, { onLog: () => {} });
  const poll = (force: boolean) => (ui as unknown as { pollPhone(f: boolean): Promise<void> }).pollPhone(force);
  try {
    await ui.start();
    await new Promise((res) => setTimeout(res, 50));
    const afterStart = reads;

    // 같은 순간에 50번 불려도(겹친 타이머) 읽는 중이면 건너뛴다.
    await Promise.all(Array.from({ length: 50 }, () => poll(true)));
    assert.equal(reads - afterStart, 1, '읽는 중에 또 읽었다');

    // 간격이 안 됐으면 몇 번을 불려도 읽지 않는다.
    await Promise.all(Array.from({ length: 50 }, () => poll(false)));
    assert.equal(reads - afterStart, 1, '간격 전에 또 읽었다');
  } finally {
    await ui.stop();
    Object.assign(agentCli, orig);
    delete (agentCli as { canPoll?: boolean }).canPoll;
    delete (agentCli as { isConfigured?: boolean }).isConfigured;
    delete (agentCli as { connection?: unknown }).connection;
  }
});
