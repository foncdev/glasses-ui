/**
 * 홈 메뉴 구성: 기본 순서, 컴퓨터 보이기, 안경 설정의 메뉴 편집, 폰 앱과 맞추기.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { GestureEvent, GlassesAdapter } from '../src/core/glasses.js';
import type { PhoneStatus } from '../src/core/phone.js';
import { DEFAULT_MENU, moveMenu, normalizeMenu, toggleMenu, visibleMenu } from '../src/core/menu.js';

test('메뉴 규칙: 모르는·겹친 id는 빼고, 빠진 것은 기본 순서로 붙이고, 설정은 숨길 수 없다', () => {
  assert.deepEqual(normalizeMenu(undefined), DEFAULT_MENU);
  assert.deepEqual(
    normalizeMenu({ order: ['settings', 'x', 'mac', 'mac', 'sessions'], hidden: ['settings', 'mac', 'nope'] }),
    {
      order: ['settings', 'mac', 'sessions', 'phone', 'notifications', 'checklist', 'system', 'commands'],
      hidden: ['mac', 'commands'],
    },
    '빠진 명령은 기본처럼 숨긴다',
  );
  assert.deepEqual(normalizeMenu({ order: 'bad', hidden: 3 }), DEFAULT_MENU);
  assert.deepEqual(normalizeMenu({ order: ['sessions'], hidden: ['system'] }).hidden, ['commands'], '빠졌던 id는 기본값이 정한다');
});

test('컴퓨터는 연결됐을 때만, 숨긴 것은 빼고 보인다', () => {
  assert.deepEqual(visibleMenu(DEFAULT_MENU, false), ['sessions', 'phone', 'notifications', 'checklist', 'system', 'settings']);
  assert.deepEqual(visibleMenu(DEFAULT_MENU, true), ['sessions', 'phone', 'notifications', 'checklist', 'system', 'mac', 'settings']);
});

test('옮기기는 끝에서 멈추고, 설정은 숨기기를 바꾸지 않는다', () => {
  assert.equal(moveMenu(DEFAULT_MENU, 'sessions', -1), DEFAULT_MENU);
  assert.deepEqual(moveMenu(DEFAULT_MENU, 'phone', -1).order.slice(0, 2), ['phone', 'sessions']);
  assert.equal(toggleMenu(DEFAULT_MENU, 'settings'), DEFAULT_MENU);
  assert.deepEqual(toggleMenu(DEFAULT_MENU, 'commands').hidden, []);
  assert.deepEqual(toggleMenu(DEFAULT_MENU, 'system').hidden, ['system', 'commands']);
});

const settle = () => new Promise((res) => setTimeout(res, 30));

/** 목록만 그리는 안경과, 폰 상태를 바꿀 수 있는 서버. */
async function harness(opts: { saved?: string; phone?: Partial<PhoneStatus> | null; oldPhone?: boolean } = {}) {
  const oldPhone = opts.oldPhone ?? false;
  const lists: Array<{ header: string; items: string[]; screen?: string }> = [];
  let ref: { screen: string } | undefined;
  const store: Record<string, string> = opts.saved ? { 'home.menu': opts.saved } : {};
  const sent: unknown[] = [];
  let onGesture: ((e: GestureEvent) => void) | undefined;
  const glasses = {
    name: 'stub',
    isVoiceEnabled: true,
    async connect() {},
    async disconnect() {},
    async showList(header: string, items: Array<string | { text: string }>) {
      lists.push({ header, items: items.map((i) => (typeof i === 'string' ? i : i.text)), screen: ref?.screen });
    },
    async showText() {},
    speak() {},
    stopSpeaking() {},
    setVoiceEnabled() {},
    async saveSetting(k: string, v: string) {
      store[k] = v;
    },
    async loadSetting(k: string) {
      return store[k] ?? '';
    },
    onGesture(cb: (e: GestureEvent) => void) {
      onGesture = cb;
      return () => {};
    },
  } as unknown as GlassesAdapter;

  const base: PhoneStatus = {
    timer: { phase: 'idle', duration: 0, remaining: 0, progress: 0 },
    water: { enabled: false, count: 0, goal: 8 },
  } as PhoneStatus;
  let phone: PhoneStatus | null = opts.phone === null ? null : { ...base, ...(opts.phone ?? {}) };
  const orig = { ...agentCli };
  Object.assign(agentCli, {
    listSessions: async () => [],
    listNotifications: async () => ({ items: [], unread: 0 }),
    getGlobalChecklist: async () => [],
    listSnippets: async () => [],
    listExt: async () => [],
    sysSummary: async () => {
      throw new Error('없음');
    },
    streamEvents: () => () => undefined,
    phoneStatus: async () => {
      if (!phone) throw new Error('폰 없음');
      return phone;
    },
    // 진짜 폰처럼 받은 메뉴를 저장해 다음 상태에 싣는다(reset이면 지운다).
    phoneMenu: async (body: { reset?: boolean; order?: string[]; hidden?: string[] }) => {
      sent.push(body);
      if (!phone) throw new Error('폰 없음');
      if (oldPhone) throw new Error('404');
      if (body.reset) delete phone.menu;
      else phone.menu = { order: body.order ?? [], hidden: body.hidden ?? [] };
      return phone;
    },
  });
  Object.defineProperty(agentCli, 'canPoll', { get: () => true, configurable: true });
  Object.defineProperty(agentCli, 'isConfigured', { get: () => true, configurable: true });
  Object.defineProperty(agentCli, 'connection', {
    get: () => ({ baseUrl: 'http://127.0.0.1:4100', apiKey: 'KEY' }),
    configurable: true,
  });
  const ui = new GlassesUI(glasses, { onLog: () => {} });
  ref = ui as unknown as { screen: string };
  await ui.start();
  const refreshPhone = () => (ui as unknown as { refreshPhone(): Promise<boolean> }).refreshPhone();
  await refreshPhone();
  const fire = async (gesture: GestureEvent['gesture'], selectedIndex?: number) => {
    onGesture?.({ gesture, selectedIndex } as GestureEvent);
    await settle();
  };
  const home = () => lists.filter((l) => l.screen === 'home').at(-1)!.items;
  return {
    ui: ui as unknown as { screen: string },
    lists,
    store,
    sent,
    fire,
    home,
    refreshPhone,
    setPhone: (p: Partial<PhoneStatus> | null) => {
      phone = p === null ? null : { ...base, ...p };
    },
    async restore() {
      await ui.stop();
      Object.assign(agentCli, orig);
    },
  };
}

test('폰이 맥·PC에 연결돼 있으면 홈에 컴퓨터가 시스템 다음에 생기고, 끊기면 빠진다', async () => {
  const h = await harness({ phone: { computer: false } });
  try {
    assert.deepEqual(h.home(), ['에이전트', '타이머 · 물', '알림 보기', '체크 보기', '시스템', '설정']);
    h.setPhone({ computer: true });
    await h.refreshPhone();
    assert.deepEqual(h.home(), ['에이전트', '타이머 · 물', '알림 보기', '체크 보기', '시스템', '컴퓨터', '설정']);
    h.setPhone({ computer: false });
    await h.refreshPhone();
    assert.ok(!h.home().includes('컴퓨터'));
  } finally {
    await h.restore();
  }
});

test('설정 > 메뉴 편집: 명령을 보이게 하고 시스템을 위로 옮기면 홈·저장소·폰이 따라 바뀐다', async () => {
  const h = await harness();
  try {
    await h.fire('tap', h.home().indexOf('설정'));
    assert.equal(h.ui.screen, 'settings');
    const settings = h.lists.at(-1)!.items;
    await h.fire('tap', settings.indexOf('메뉴 편집'));
    assert.equal(h.ui.screen, 'menu-edit');
    assert.deepEqual(h.lists.at(-1)!.items, [
      '[x] 에이전트', '[x] 타이머 · 물', '[x] 알림 보기', '[x] 체크 보기', '[x] 시스템', '[x] 컴퓨터 · 연결 시', '[x] 설정', '[ ] 명령',
      '기본값으로',
    ]);

    // 명령 보이기
    await h.fire('tap', 7);
    assert.equal(h.ui.screen, 'menu-item');
    assert.deepEqual(h.lists.at(-1)!.items, ['보이기', '위로', '아래로', '완료']);
    await h.fire('tap', 0);
    assert.deepEqual(h.lists.at(-1)!.items[0], '숨기기');
    await h.fire('doubleTap');
    assert.equal(h.ui.screen, 'menu-edit');

    // 시스템을 두 칸 위로(위로를 거듭 누른다)
    await h.fire('tap', 4);
    await h.fire('tap', 1);
    await h.fire('tap', 1);
    assert.match(h.lists.at(-1)!.header, /^시스템 3\/8/);
    await h.fire('tap', 3); // 완료

    assert.deepEqual(JSON.parse(h.store['home.menu']!), {
      order: ['sessions', 'phone', 'system', 'notifications', 'checklist', 'mac', 'settings', 'commands'],
      hidden: [],
    });
    assert.deepEqual(h.sent.at(-1), JSON.parse(h.store['home.menu']!), '폰에도 맞춘다');

    await h.fire('doubleTap');
    await h.fire('doubleTap');
    assert.equal(h.ui.screen, 'home');
    assert.deepEqual(h.home(), ['에이전트', '타이머 · 물', '시스템', '알림 보기', '체크 보기', '설정', '명령']);
  } finally {
    await h.restore();
  }
});

test('설정은 숨길 수 없고, 기본값으로를 고르면 폰에 저장한 것도 지운다', async () => {
  const h = await harness({ saved: JSON.stringify({ order: ['settings', 'sessions'], hidden: ['phone'] }) });
  try {
    await h.fire('tap', h.home().indexOf('설정'));
    await h.fire('tap', h.lists.at(-1)!.items.indexOf('메뉴 편집'));
    await h.fire('tap', 0); // 설정
    assert.equal(h.lists.at(-1)!.items[0], '설정은 숨길 수 없음');
    await h.fire('tap', 0);
    assert.ok(!JSON.parse(h.store['home.menu']!).hidden.includes('settings'));
    await h.fire('doubleTap');

    const rows = h.lists.at(-1)!.items;
    await h.fire('tap', rows.indexOf('기본값으로'));
    assert.equal(h.store['home.menu'], '');
    assert.deepEqual(h.sent.at(-1), { reset: true });
  } finally {
    await h.restore();
  }
});

test('폰 앱에서 정한 메뉴를 따르고, 폰에서 기본값으로 돌리면 안경도 돌아간다', async () => {
  const h = await harness();
  try {
    h.setPhone({ menu: { order: ['settings', 'system', 'sessions', 'notifications'], hidden: ['notifications'] } });
    await h.refreshPhone();
    assert.deepEqual(h.home(), ['설정', '시스템', '에이전트', '타이머 · 물', '체크 보기']);
    assert.ok(h.store['home.menu'], '안경에도 저장한다');

    h.setPhone({});
    await h.refreshPhone();
    assert.deepEqual(h.home(), ['에이전트', '타이머 · 물', '알림 보기', '체크 보기', '시스템', '설정']);
    assert.equal(h.store['home.menu'], '');
  } finally {
    await h.restore();
  }
});

test('예전 폰 앱(/phone/menu 없음)이면 안경에서 바꾼 메뉴를 지우지 않는다', async () => {
  const saved = { order: DEFAULT_MENU.order, hidden: [] };
  const h = await harness({ saved: JSON.stringify(saved), oldPhone: true });
  try {
    await h.refreshPhone();
    await h.refreshPhone();
    assert.equal(h.sent.length, 1, '한 번만 보내 본다');
    assert.deepEqual(JSON.parse(h.store['home.menu']!), saved, '안경 것은 그대로');
    assert.ok(h.home().includes('명령'));
  } finally {
    await h.restore();
  }
});

test('안경에서 바꾼 메뉴가 있는데 폰에 없으면 폰에 한 번 올린다', async () => {
  const saved = { order: DEFAULT_MENU.order, hidden: [] };
  const h = await harness({ saved: JSON.stringify(saved) });
  try {
    await h.refreshPhone();
    assert.equal(h.sent.length, 1, '한 번만 올린다');
    assert.deepEqual(h.sent[0], saved);
  } finally {
    await h.restore();
  }
});
