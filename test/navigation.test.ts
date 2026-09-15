/**
 * 화면 이동 검증.
 *
 *   home ─ 에이전트 / 알림 보기 / 체크 보기 / 설정
 *     ├ sessions → history → detail
 *     ├ notifications → notification
 *     ├ checklist
 *     └ settings
 *
 * 더블탭은 늘 한 단계 위로 간다. 시뮬레이터는 리스트 스크롤 이벤트를
 * 내보내지 않아 커서 이동은 여기서만 확인할 수 있다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import { toItem, type GestureEvent, type GlassesAdapter, type ItemLike } from '../src/core/glasses.js';
import { asText } from './g2-text.js';
import { GLASSES_LOGO } from '../src/adapters/g2-logo.js';

function stubGlasses() {
  const shown: { header: string; items: string[]; side?: string[] }[] = [];
  const texts: string[] = [];
  let onGesture: ((e: GestureEvent) => void) | undefined;
  let voice = true;

  const glasses = {
    name: 'stub',
    // 로고는 어댑터가 갖는다. 아래 테스트가 로고 아트 자체(줄 수·문자)를
    // 검사하므로 스텁도 G2의 진짜 로고를 들고 있어야 한다.
    logo: GLASSES_LOGO,
    get isVoiceEnabled() {
      return voice;
    },
    async connect() {},
    async disconnect() {},
    // 본체는 이제 Item을 넘긴다. 기존 단언이 글자를 보고 있으므로
    // G2 어댑터와 같은 규칙으로 글자를 만들어 담는다.
    async showList(header: string, items: readonly ItemLike[], side?: readonly ItemLike[]) {
      shown.push({ header, items: asText(items), side: side?.map((s) => toItem(s).text) });
    },
    async showText(t: string) {
      texts.push(t);
    },
    async speak() {},
    setVoiceEnabled(on: boolean) {
      voice = on;
    },
    async saveSetting() {},
    async loadSetting() {
      return '';
    },
    onGesture(cb: (e: GestureEvent) => void) {
      onGesture = cb;
      return () => {};
    },
  } as unknown as GlassesAdapter;

  return {
    glasses,
    shown,
    texts,
    fire: (gesture: string, selectedIndex?: number) =>
      onGesture?.({ gesture, selectedIndex } as GestureEvent),
  };
}

const SESSIONS = [
  { id: 'a', title: '첫 세션', live: true, status: 'idle' },
  { id: 'b', title: '둘째 세션', live: true, status: 'busy' },
];

const NOTIFS = [
  { id: 'n1', title: '빌드 완료', body: '테스트 통과', kind: 'done', createdAt: '', readAt: '2026-01-01T00:00:00Z' },
  { id: 'n2', title: '배포 실패', body: '권한 없음', kind: 'error', createdAt: '' },
];

/** 서버 호출을 전부 가로챈 relay를 홈 화면에 세워 돌려준다. */
async function atHome() {
  const stub = stubGlasses();
  const relay = new GlassesUI(stub.glasses, { onLog: () => {} });

  const orig = {
    listSessions: agentCli.listSessions,
    listNotifications: agentCli.listNotifications,
    getGlobalChecklist: agentCli.getGlobalChecklist,
    getHistory: agentCli.getHistory,
    readNotification: agentCli.readNotification,
    readAllNotifications: agentCli.readAllNotifications,
  };
  agentCli.listSessions = async () => SESSIONS as never;
  agentCli.listNotifications = async () => ({ items: [...NOTIFS] as never, unread: 1 });
  agentCli.getGlobalChecklist = async () =>
    [{ id: 'c1', text: '할 일', done: false, createdAt: '' }] as never;
  agentCli.getHistory = async () =>
    [
      { type: 'user', sessionId: 'a', at: '', text: '안녕' },
      { type: 'assistant', sessionId: 'a', at: '', text: '무엇을 도와드릴까요' },
    ] as never;
  agentCli.readNotification = async () => 0;
  agentCli.readAllNotifications = async () => {};

  await relay.start();

  const r = relay as unknown as {
    screen: string;
    menuCursor: number;
    cursor: number;
    histCursor: number;
    notifCursor: number;
    setCursor: number;
    screenOff: boolean;
    idleMs: number;
    render(): Promise<void>;
  };
  r.screenOff = false;
  r.screen = 'home';
  await r.render();

  const restore = () => Object.assign(agentCli, orig);
  return { relay, r, restore, ...stub };
}

/** 제스처가 비동기 처리를 마칠 때까지 기다린다. */
const settle = () => new Promise((res) => setTimeout(res, 60));

test('홈은 요약과 메뉴 네 개를 보여준다', async () => {
  const { shown, restore } = await atHome();
  try {
    const last = shown.at(-1)!;
    assert.deepEqual(last.items, ['에이전트', '알림 보기', '체크 보기', '설정']);
    // 상단 한 줄에 세션·알림·체크가 모두 있어야 한다.
    assert.match(last.header, /세션 .*알림 .*체크/);
  } finally {
    restore();
  }
});

test('홈 요약은 서버 숫자를 반영한다', async () => {
  const { r, shown, restore } = await atHome();
  try {
    // 홈에 서면 요약을 새로 읽는다.
    await (r as unknown as { refreshSummary(): Promise<void> }).refreshSummary();
    const header = shown.at(-1)!.header;
    assert.match(header, /세션 1\/2/, '진행중 1 / 전체 2');
    assert.match(header, /알림 1/, '안 읽은 알림 1건');
    assert.match(header, /체크 0\/1/, '완료 0 / 전체 1');
  } finally {
    restore();
  }
});

test('에이전트 > 세션 목록 > 대화 목록으로 내려간다', async () => {
  const { r, shown, fire, restore } = await atHome();
  try {
    fire('tap', 0); // 에이전트
    await settle();
    assert.equal(r.screen, 'sessions');
    assert.match(shown.at(-1)!.items[0]!, /첫 세션/);

    fire('tap', 0); // 첫 세션
    await settle();
    assert.equal(r.screen, 'history', '세션을 고르면 대화 목록이다');
    const items = shown.at(-1)!.items;
    assert.match(items[0]!, /나> 안녕/);
    assert.match(items[1]!, /AI> 무엇을/);
    assert.match(items.at(-1)!, /대화 이어서 보기/);
  } finally {
    restore();
  }
});

test('더블탭은 한 단계씩 위로 올라간다', async () => {
  const { r, fire, restore } = await atHome();
  try {
    fire('tap', 0); // → sessions
    await settle();
    fire('tap', 0); // → history
    await settle();
    assert.equal(r.screen, 'history');

    fire('doubleTap');
    await settle();
    assert.equal(r.screen, 'sessions', '대화 목록에서 세션 목록으로');

    fire('doubleTap');
    await settle();
    assert.equal(r.screen, 'home', '세션 목록에서 홈으로');

    // 최상위에서는 더 올라가지 않는다.
    fire('doubleTap');
    await settle();
    assert.equal(r.screen, 'home');
  } finally {
    restore();
  }
});

test('알림 보기 > 목록 > 내용', async () => {
  const { r, shown, texts, fire, restore } = await atHome();
  try {
    fire('tap', 1); // 알림 보기
    await settle();
    assert.equal(r.screen, 'notifications');
    const items = shown.at(-1)!.items;
    // 안 읽은 알림은 앞에 표시가 붙는다.
    assert.match(items[1]!, /^\* 배포 실패/, '안 읽은 알림에 표시');
    assert.match(items[0]!, /^- /, '읽은 알림도 보이는 문자로 시작한다');

    fire('tap', 1); // 배포 실패
    await settle();
    assert.equal(r.screen, 'notification');
    assert.match(texts.at(-1)!, /배포 실패/);
    assert.match(texts.at(-1)!, /권한 없음/, '본문이 보여야 한다');

    fire('doubleTap');
    await settle();
    assert.equal(r.screen, 'notifications', '알림 목록으로 돌아온다');
  } finally {
    restore();
  }
});

test('체크 보기는 전역 목록을 연다', async () => {
  const { r, shown, fire, restore } = await atHome();
  try {
    fire('tap', 2);
    await settle();
    assert.equal(r.screen, 'checklist');
    assert.match(shown.at(-1)!.header, /전역 할 일/);

    fire('doubleTap');
    await settle();
    assert.equal(r.screen, 'home');
  } finally {
    restore();
  }
});

test('설정에서 음성·로고·화면 꺼짐 시간을 바꾼다', async () => {
  const { r, shown, fire, restore } = await atHome();
  try {
    fire('tap', 3); // 설정
    await settle();
    assert.equal(r.screen, 'settings');

    const items = shown.at(-1)!.items;
    assert.match(items[0]!, /음성: 켜짐/);
    assert.match(items[1]!, /DEV 로고: 켜짐/);
    assert.deepEqual(
      items.slice(2).map((x) => x.replace(/^[*-] /, '')),
      ['화면 꺼짐: 10초', '화면 꺼짐: 15초', '화면 꺼짐: 30초'],
    );
    // 기본값 15초에 표시가 붙어 있어야 한다.
    // 펌웨어가 앞 공백을 지우므로 안 고른 값도 보이는 문자로 시작해야 한다.
    assert.match(items[3]!, /^\* /, '고른 값');
    assert.match(items[2]!, /^- /, '안 고른 값');

    fire('tap', 0); // 음성 토글
    await settle();
    assert.match(shown.at(-1)!.items[0]!, /음성: 꺼짐/);

    fire('tap', 4); // 30초 (로고 칸이 생겨 한 칸 밀렸다)
    await settle();
    assert.equal(r.idleMs, 30_000);
    assert.match(shown.at(-1)!.items[4]!, /^\*/, '고른 값에 표시가 옮겨간다');
  } finally {
    restore();
  }
});

test('설정에서 DEV 로고를 끄면 옆 패널이 사라진다', async () => {
  const { r, shown, fire, restore } = await atHome();
  try {
    // 켜져 있을 때는 로고가 보인다.
    assert.equal(shown.at(-1)!.side!.length, 6);

    fire('tap', 3); // 설정
    await settle();
    fire('tap', 1); // DEV 로고 토글
    await settle();
    assert.match(shown.at(-1)!.items[1]!, /DEV 로고: 꺼짐/);

    fire('doubleTap'); // 홈으로
    await settle();
    assert.equal(r.screen, 'home');
    assert.ok(!shown.at(-1)!.side, '로고를 끄면 옆 패널이 없어야 한다');

    // 다시 켜면 돌아온다.
    fire('tap', 3);
    await settle();
    fire('tap', 1);
    await settle();
    fire('doubleTap');
    await settle();
    assert.equal(shown.at(-1)!.side!.length, 6, '다시 켜면 로고가 돌아온다');
  } finally {
    restore();
  }
});

test('커서는 목록 끝을 넘지 않는다', async () => {
  const { r, fire, restore } = await atHome();
  try {
    for (let i = 0; i < 10; i++) fire('down');
    await settle();
    assert.equal(r.menuCursor, 3, '메뉴는 네 칸뿐이다');

    for (let i = 0; i < 10; i++) fire('up');
    await settle();
    assert.equal(r.menuCursor, 0);
  } finally {
    restore();
  }
});

test('agent-cli가 죽어 있어도 홈으로 돌아온다', async () => {
  const { r, fire, restore } = await atHome();
  try {
    fire('tap', 2); // 체크 보기 (서버가 직접 준다)
    await settle();
    assert.equal(r.screen, 'checklist');

    // 맥이 꺼진 상태를 만든다.
    agentCli.listSessions = async () => {
      throw new Error('연결된 agent-cli가 없습니다.');
    };

    fire('doubleTap');
    await settle();
    assert.equal(r.screen, 'home', '세션 조회가 던져도 홈은 떠야 한다');
  } finally {
    restore();
  }
});

test('시작하자마자 홈 요약이 채워진다', async () => {
  // start() 직후 화면에 0만 떠 있으면 고장으로 보인다.
  const stub = stubGlasses();
  const relay = new GlassesUI(stub.glasses, { onLog: () => {} });

  const orig = {
    listSessions: agentCli.listSessions,
    listNotifications: agentCli.listNotifications,
    getGlobalChecklist: agentCli.getGlobalChecklist,
  };
  agentCli.listSessions = async () => SESSIONS as never;
  agentCli.listNotifications = async () => ({ items: [...NOTIFS] as never, unread: 1 });
  agentCli.getGlobalChecklist = async () =>
    [{ id: 'c1', text: '할 일', done: false, createdAt: '' }] as never;

  try {
    await relay.start();
    await settle();
    const header = stub.shown.at(-1)!.header;
    assert.match(header, /세션 1\/2/);
    assert.match(header, /알림 1/);
    assert.match(header, /체크 0\/1/);
  } finally {
    Object.assign(agentCli, orig);
  }
});

test('인증 전에는 0이 아니라 안내를 띄운다', async () => {
  const stub = stubGlasses();
  const relay = new GlassesUI(stub.glasses, { onLog: () => {} });

  const orig = { listNotifications: agentCli.listNotifications };
  agentCli.listNotifications = async () => {
    throw new Error('인증이 필요합니다.');
  };

  try {
    await relay.start();
    await settle();
    assert.match(stub.texts.at(-1)!, /연결 중/, '숫자 대신 안내가 보여야 한다');
  } finally {
    Object.assign(agentCli, orig);
  }
});

test('DEV 로고가 홈 메뉴 옆에 상주한다', async () => {
  const { r, relay, shown, restore } = await atHome();
  try {
    await relay.showMotd();
    assert.equal(r.screen, 'home');

    const side = shown.at(-1)!.side!;
    assert.equal(side.length, 6, '로고 6줄만 둔다');

    // 안경 폰트에 있는 문자만 쓴다. 겹선(═ ║)과 블록(█)은 빈칸이 된다.
    assert.ok(!/[═║╔╗╚╝█░]/.test(side.join('')), '안경에 안 보이는 문자가 섞였다');
    assert.match(side.join(''), /[╭╮╰╯━┃]/, '로고가 그려져야 한다');

    // 줄 길이가 다르면 글자가 어긋난다.
    const widths = new Set(side.map((l) => l.length));
    assert.equal(widths.size, 1, `줄 길이가 제각각: ${[...widths].join(', ')}`);
  } finally {
    restore();
  }
});

test('옆 패널에 서버 상태를 넣지 않는다', async () => {
  // 로고와 같이 넣으면 높이가 모자라 아래가 잘린다.
  // 같은 내용은 상단 요약이 더 짧게 보여준다.
  const { relay, shown, restore } = await atHome();
  try {
    await relay.showMotd();
    const side = shown.at(-1)!.side!;
    assert.ok(!side.some((l) => /가동|agent|알림/.test(l)), '서버 상태가 섞이면 안 된다');
    assert.match(shown.at(-1)!.header, /세션 .*알림 .*체크/, '요약은 상단에 있다');
  } finally {
    restore();
  }
});

test('메뉴를 오갔다 와도 로고가 남아 있다', async () => {
  const { r, relay, shown, fire, restore } = await atHome();
  try {
    await relay.showMotd();
    fire('tap', 2); // 체크 보기로 내려간다
    await settle();
    assert.equal(r.screen, 'checklist');

    fire('doubleTap'); // 홈으로
    await settle();
    assert.equal(r.screen, 'home');
    assert.equal(shown.at(-1)!.side!.length, 6, '홈에 오면 로고가 다시 보여야 한다');
  } finally {
    restore();
  }
});

test('로고 설정은 다시 켜도 유지된다', async () => {
  // 저장소를 흉내 내 같은 값을 두 relay가 공유하게 한다.
  const store = new Map<string, string>();
  const make = async () => {
    const stub = stubGlasses();
    const g = stub.glasses as unknown as {
      saveSetting(k: string, v: string): Promise<void>;
      loadSetting(k: string): Promise<string>;
    };
    g.saveSetting = async (k, v) => void store.set(k, v);
    g.loadSetting = async (k) => store.get(k) ?? '';

    const relay = new GlassesUI(stub.glasses, { onLog: () => {} });
    await relay.start();
    const r = relay as unknown as { screen: string; screenOff: boolean; render(): Promise<void> };
    r.screenOff = false;
    r.screen = 'home';
    await r.render();
    return { relay, r, ...stub };
  };

  const orig = {
    listSessions: agentCli.listSessions,
    listNotifications: agentCli.listNotifications,
    getGlobalChecklist: agentCli.getGlobalChecklist,
  };
  agentCli.listSessions = async () => SESSIONS as never;
  agentCli.listNotifications = async () => ({ items: [] as never, unread: 0 });
  agentCli.getGlobalChecklist = async () => [] as never;

  try {
    const first = await make();
    await first.relay.toggleLogo();
    assert.equal(store.get('home.logo'), '0', '끈 상태가 저장돼야 한다');

    // 앱을 다시 띄운 것처럼 새 relay를 만든다.
    const second = await make();
    assert.ok(!second.shown.at(-1)!.side, '다시 켜도 로고는 꺼진 채여야 한다');
  } finally {
    Object.assign(agentCli, orig);
  }
});
