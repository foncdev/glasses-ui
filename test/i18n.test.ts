/**
 * 한국어·영어 판 검증.
 *
 * 1. 두 판의 키가 같다(타입은 i18n.ts의 `en: Messages`가, 실행 시에는 여기서 본다).
 * 2. 언어 고르기: 첫 번째 선호 언어가 ko면 한국어, 그 밖에는 영어.
 * 3. 영어 화면이 실제로 영어로 그려진다.
 * 4. 모든 고정 글이 두 언어 모두 G2 칸 폭 안에 들어간다. 영어는 한국어보다
 *    길어지기 쉬워, 잘리면(…) 뜻이 사라진다. 폭은 펌웨어 폰트와 같은 pretext로 잰다.
 *
 * 다른 테스트는 test/setup-locale.ts가 한국어로 고정한다. 여기서는 언어를 바꿔
 * 쓰고, 끝나면 한국어로 되돌린다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext';
import {
  CATALOGS,
  LOCALES,
  detectLocale,
  getLocale,
  msg,
  setLocale,
  speechLang,
  type Locale,
} from '../src/core/i18n.js';
import { GlassesUI, timeAgo, agoPhrase } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import { durationLabel, phoneActions, phoneHeader, timerLabel, waterLabel, type PhoneStatus } from '../src/core/phone.js';
import type { GestureEvent, GlassesAdapter, HomeView, SessionsView } from '../src/core/glasses.js';
import { layoutHome, SCREEN_W } from '../src/adapters/g2-home.js';
import { layoutSessions } from '../src/adapters/g2-sessions.js';
import { layoutNotice, layoutNotifications } from '../src/adapters/g2-inbox.js';
import { layoutChecklist } from '../src/adapters/g2-todo.js';
import { layoutCommandResult, layoutCommands } from '../src/adapters/g2-cmd.js';
import { layoutSystem } from '../src/adapters/g2-sys.js';
import { layoutHistory, layoutLive, layoutPermission } from '../src/adapters/g2-talk.js';
import { utf8Bytes, ITEM_MAX_BYTES } from '../src/adapters/g2-bytes.js';
import { GLASSES_LOGO } from '../src/adapters/g2-logo.js';

/** 언어를 잠깐 바꿔 fn을 돌린다. 끝나면 한국어로 되돌린다. */
async function inLocale<T>(locale: Locale, fn: () => T | Promise<T>): Promise<T> {
  setLocale(locale);
  try {
    return await fn();
  } finally {
    setLocale('ko');
  }
}

// --- 1. 키 ---

test('영어 판은 한국어 판과 키가 같고, 글·함수 모양도 같다', () => {
  const ko = CATALOGS.ko as unknown as Record<string, unknown>;
  const en = CATALOGS.en as unknown as Record<string, unknown>;
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort());
  for (const key of Object.keys(ko)) {
    assert.equal(typeof en[key], typeof ko[key], `${key}의 모양이 다르다`);
    if (typeof ko[key] === 'function') {
      assert.equal((en[key] as Function).length, (ko[key] as Function).length, `${key}의 인자 수가 다르다`);
    } else {
      assert.ok((en[key] as string).length > 0, `${key}가 비어 있다`);
    }
  }
  assert.deepEqual([...LOCALES].sort(), Object.keys(CATALOGS).sort());
});

test('영어 판에 한글이 남아 있지 않다', () => {
  const en = CATALOGS.en as unknown as Record<string, unknown>;
  const sample = (v: unknown): string =>
    typeof v === 'function' ? String((v as (...a: unknown[]) => unknown)(1, 2, 3, 4, 5)) : String(v);
  for (const [key, v] of Object.entries(en)) {
    assert.doesNotMatch(sample(v), /[가-힣]/, `${key}에 한글이 있다`);
  }
});

// --- 2. 언어 고르기 ---

test('첫 번째 선호 언어가 한국어면 ko, 그 밖에는 en', () => {
  assert.equal(detectLocale(['ko-KR']), 'ko');
  assert.equal(detectLocale(['ko']), 'ko');
  assert.equal(detectLocale('ko-kr'), 'ko');
  assert.equal(detectLocale(['en-US']), 'en');
  assert.equal(detectLocale(['ja-JP']), 'en');
  assert.equal(detectLocale(['zh-Hans-CN', 'ko-KR']), 'en', '첫 번째만 본다');
  assert.equal(detectLocale(['en-US', 'ko-KR']), 'en');
  assert.equal(detectLocale([]), 'en');
  assert.equal(detectLocale(''), 'en');
  assert.equal(detectLocale(undefined), 'en');
  assert.equal(detectLocale(['', 'ko-KR']), 'ko', '빈 값은 건너뛴다');
});

test('setLocale로 바꾸면 msg()와 음성 언어가 바로 따라간다', async () => {
  await inLocale('en', () => {
    assert.equal(getLocale(), 'en');
    assert.equal(msg().screenOff, 'Screen off');
    assert.equal(speechLang(), 'en-US');
  });
  assert.equal(getLocale(), 'ko');
  assert.equal(msg().screenOff, '화면 꺼짐');
  assert.equal(speechLang(), 'ko-KR');
  assert.equal(setLocale('ja-JP'), 'en', '모르는 언어는 영어');
  setLocale('ko');
});

// --- 3. 영어 화면 ---

function stubGlasses(sink: { home: HomeView[]; sessions: SessionsView[]; lists: Array<[string, string[]]> }) {
  let onGesture: (e: GestureEvent) => void = () => {};
  const glasses = {
    name: 'stub',
    logo: GLASSES_LOGO,
    isVoiceEnabled: false,
    async connect() {},
    async disconnect() {},
    async showList(header: string, items: Array<string | { text: string }>) {
      sink.lists.push([header, items.map((i) => (typeof i === 'string' ? i : i.text))]);
    },
    async showText() {},
    async showHome(v: HomeView) {
      sink.home.push(v);
    },
    async showSessions(v: SessionsView) {
      sink.sessions.push(v);
    },
    speak() {},
    stopSpeaking() {},
    setVoiceEnabled() {},
    async saveSetting() {},
    async loadSetting() {
      return '';
    },
    onGesture(cb: (e: GestureEvent) => void) {
      onGesture = cb;
      return () => {};
    },
  } as unknown as GlassesAdapter;
  return { glasses, gesture: (e: GestureEvent) => onGesture(e) };
}

async function withServer<T>(fn: () => Promise<T>): Promise<T> {
  const orig = { ...agentCli };
  const now = Date.now();
  Object.assign(agentCli, {
    listSessions: async () => [
      { id: 'a', title: 'build', live: true, status: 'busy', lastActivityAt: new Date(now - 30_000).toISOString() },
      { id: 'b', title: '', live: true, status: 'idle', lastActivityAt: new Date(now - 5 * 60_000).toISOString() },
    ],
    listNotifications: async () => ({ items: [], unread: 7 }),
    getGlobalChecklist: async () => [
      { id: 'a', text: 'x', done: true, createdAt: '' },
      { id: 'b', text: 'y', done: false, createdAt: '' },
    ],
    sysSummary: async () => {
      throw new Error('no terminal-agent');
    },
  });
  try {
    return await fn();
  } finally {
    Object.assign(agentCli, orig);
  }
}

test('영어로 두면 홈 메뉴·요약이 영어로 그려진다', async () => {
  await inLocale('en', () =>
    withServer(async () => {
      const sink = { home: [] as HomeView[], sessions: [] as SessionsView[], lists: [] as Array<[string, string[]]> };
      const { glasses } = stubGlasses(sink);
      const ui = new GlassesUI(glasses, { onLog: () => {} });
      await ui.start();
      const v = sink.home.at(-1)!;
      assert.deepEqual(
        v.items.map((i) => i.label),
        // 기본 순서. 명령은 기본으로 숨기고, 컴퓨터는 맥·PC가 연결됐을 때만 보인다.
        ['Agents', 'Timer · Water', 'Notifications', 'To-Dos', 'System', 'Settings'],
      );
      const meta = Object.fromEntries(v.items.map((i) => [i.label, i.meta]));
      assert.equal(meta.Notifications, '7 new');
      assert.equal(meta['To-Dos'], '1 / 2');
      assert.match(v.status, /1 busy/);
      await ui.stop();
    }),
  );
});

test('영어로 두면 홈 더블탭 선택지가 Screen off · Exit · Cancel이고, 고르면 그대로 동작한다', async () => {
  await inLocale('en', () =>
    withServer(async () => {
      const sink = { home: [] as HomeView[], sessions: [] as SessionsView[], lists: [] as Array<[string, string[]]> };
      const { glasses, gesture } = stubGlasses(sink);
      const ui = new GlassesUI(glasses, { onLog: () => {} });
      await ui.start();
      gesture({ gesture: 'doubleTap' });
      await new Promise((r) => setTimeout(r, 10));
      const [header, items] = sink.lists.at(-1)!;
      assert.equal(header, 'Home · Double-tap: cancel');
      assert.deepEqual(items, ['Screen off', 'Exit', 'Cancel']);

      // 글이 아니라 id로 고르므로 영어에서도 '취소'가 홈으로 돌아간다.
      gesture({ gesture: 'down' });
      await new Promise((r) => setTimeout(r, 10));
      gesture({ gesture: 'down' });
      await new Promise((r) => setTimeout(r, 10));
      const before = sink.home.length;
      gesture({ gesture: 'tap' });
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(sink.home.length > before, 'Cancel이 홈으로 돌아가지 않았다');
      await ui.stop();
    }),
  );
});

test('영어로 두면 세션 화면의 개수·경과 시간·안내가 영어다', async () => {
  await inLocale('en', () =>
    withServer(async () => {
      const sink = { home: [] as HomeView[], sessions: [] as SessionsView[], lists: [] as Array<[string, string[]]> };
      const { glasses } = stubGlasses(sink);
      const ui = new GlassesUI(glasses, { onLog: () => {} });
      await ui.start();
      await (ui as unknown as { openMenu(t: string): Promise<void> }).openMenu('sessions');
      const v = sink.sessions.at(-1)!;
      assert.deepEqual(
        v.rows.map((r) => [r.title, r.meta]),
        [['build', 'now'], ['New chat', '5m']],
      );
      assert.deepEqual(v.counts.map((c) => c.label), ['Working', 'Approval', 'Idle', 'Ended']);
      assert.equal(v.total, '2 sessions');
      assert.equal(v.hint, '● Open    ●● Back');
      await ui.stop();
    }),
  );
});

test('경과 시간과 타이머·물 글이 언어를 따른다', async () => {
  const now = Date.parse('2026-01-02T12:00:00Z');
  const iso = (ms: number) => new Date(now - ms).toISOString();
  assert.equal(timeAgo(iso(3 * 60_000), now), '3분');
  assert.equal(agoPhrase(iso(3 * 60_000), now), '3분 전');
  assert.equal(agoPhrase(iso(30 * 3600_000), now), '어제');
  assert.equal(agoPhrase(iso(10_000), now), '방금');
  await inLocale('en', () => {
    assert.equal(timeAgo(iso(3 * 60_000), now), '3m');
    assert.equal(timeAgo(iso(2 * 3600_000), now), '2h');
    assert.equal(agoPhrase(iso(3 * 60_000), now), '3m ago');
    assert.equal(agoPhrase(iso(30 * 3600_000), now), '1d ago');
    assert.equal(agoPhrase(iso(10_000), now), 'now');

    const idle: PhoneStatus = {
      timer: { phase: 'idle', duration: 0, remaining: 0, progress: 0 },
      water: { enabled: true, count: 3, goal: 8 },
    };
    assert.deepEqual(phoneActions(idle).map((a) => a.label), [
      '▶ Start 60 min', '▶ Start 30 min', '▶ Start 15 min', 'Drank a glass', 'Undo a glass',
    ]);
    const running: PhoneStatus = { ...idle, timer: { phase: 'running', duration: 600, remaining: 290, progress: 0.5 } };
    assert.deepEqual(phoneActions(running).map((a) => a.label), [
      '■ Pause', '+1 min', 'Drank a glass', 'Undo a glass', 'Reset',
    ]);
    assert.equal(timerLabel(running.timer, 0, 0), '▶ 5m');
    assert.equal(waterLabel(idle.water), 'H2O 3/8', '홈 상태 표시줄은 좁아 줄인다');
    assert.equal(phoneHeader(idle, 0, 0), 'Timer Idle · Water 3/8');
    assert.equal(durationLabel(100), '1 min 40 sec');
  });
});

test('타이머·물 줄의 id는 언어와 상관없이 같다', async () => {
  const s: PhoneStatus = {
    timer: { phase: 'paused', duration: 600, remaining: 290, progress: 0.5 },
    water: { enabled: true, count: 3, goal: 8 },
  };
  const ko = phoneActions(s).map((a) => a.id);
  const en = await inLocale('en', () => phoneActions(s).map((a) => a.id));
  assert.deepEqual(en, ko);
});

// --- 4. 폭 ---

/**
 * 한 칸에 이 글이 잘리지 않고 한 줄로 들어가는지.
 * pretext의 pxTruncate는 잘리면 '...'을 붙이고, 펌웨어는 넘치면 접는다.
 */
function fitsLine(text: string, width: number): boolean {
  return getTextWidth(text) <= width && measureTextWrap(text, width).lineCount === 1;
}

/** 두 언어 모두에서 fn을 돌린다. */
async function eachLocale(fn: (locale: Locale) => void): Promise<void> {
  for (const l of LOCALES) await inLocale(l, () => fn(l));
}

test('홈 메뉴: 라벨과 가장 긴 오른쪽 값이 한 칸에 잘리지 않고 들어간다', async () => {
  await eachLocale((l) => {
    const m = msg();
    const labels = [m.menuAgents, m.menuNotifications, m.menuChecklist, m.menuSystem, m.menuCommands, m.menuMac, m.menuPhone, m.menuSettings];
    const view: HomeView = {
      title: '$ relay ~/home',
      status: '',
      items: labels.map((label) => ({ label, meta: label === m.menuNotifications ? m.homeUnread(99) : '20 / 20' })),
      logo: GLASSES_LOGO,
    };
    const out = layoutHome(view).list.items;
    out.forEach((row, i) => {
      assert.ok(row.startsWith(labels[i]!), `[${l}] '${labels[i]}'이 잘렸다: ${row}`);
      assert.ok(!row.includes('...'), `[${l}] 잘림: ${row}`);
      assert.ok(utf8Bytes(row) <= ITEM_MAX_BYTES, `[${l}] 바이트 초과: ${row}`);
    });
  });
});

/**
 * 한 자리(slot)의 글을 두 언어로 만들어 잰다. 한국어가 들어가던 자리면 영어도
 * 들어가야 하고, 한국어부터 넘치던 자리(극단값)면 영어가 한국어보다 넓으면 안 된다.
 */
async function sameSlot(name: string, width: number, make: () => string): Promise<void> {
  const ko = await inLocale('ko', make);
  const en = await inLocale('en', make);
  if (fitsLine(ko, width)) {
    assert.ok(fitsLine(en, width), `${name}: 영어가 넘친다 (${getTextWidth(en)}px > ${width}px): ${en}`);
  } else {
    // 한국어부터 넘쳐 끝(시각)이 잘리는 자리다. 영어도 끝만 잘리면 되므로
    // 한국어보다 조금(40px, 낱말 하나) 넓은 것까지는 둔다.
    assert.ok(
      getTextWidth(en) <= getTextWidth(ko) + 40,
      `${name}: 한국어도 넘치는 자리인데 영어가 훨씬 넓다 (${getTextWidth(en)} > ${getTextWidth(ko)}px): ${en}`,
    );
  }
}

test('상태 표시줄: 영어 상태 글이 한국어가 들어가던 오른쪽 칸(236px)에 들어간다', async () => {
  const W = 246 - 4 - 6;
  const slots: Array<[string, () => string]> = [
    // 홈: 작업 수 · 타이머 · 물 · 연결 · 시각
    ['home+phone', () => [msg().busyCount(2), `▶ ${msg().minShort(12)}`, msg().water(3, 8), '●', '23:59'].join('  ')],
    ['home+phone max', () => [msg().busyCount(9), `▶ ${msg().minShort(60)}`, msg().water(10, 12), '●', '23:59'].join('  ')],
    ['home', () => [msg().busyCount(9), '● online', '23:59'].join('  ')],
    ['sessions', () => [msg().busyCount(9), msg().approvals(9), '23:59'].join('   ')],
    ['inbox', () => [msg().unreadStatus(99), '23:59'].join('   ')],
    ['commands', () => [msg().cronCount(20), '23:59'].join('   ')],
    ['result done', () => `◇ ${msg().exitCode(127)} · ${msg().secShort('12.3')}   23:59`],
    ['result timeout', () => `◇ ${msg().timedOut} · ${msg().tookUnder}   23:59`],
    ['result confirm', () => `▲ ${msg().confirmNeeded}   23:59`],
    ['result failed', () => `◇ ${msg().failed}   23:59`],
    ['system', () => msg().readAt('23:59:59')],
    ['live', () => [msg().stateWaiting, '23:59'].join('   ')],
    ['permission', () => [msg().permRequest, '23:59'].join('   ')],
  ];
  for (const [name, make] of slots) await sameSlot(name, W, make);
  // 타이머·물만 있을 때(작업 중 세션 없음)는 두 언어 모두 실제로 들어가야 한다.
  // 작업 수까지 붙으면 한국어도 넘친다(위 'home+phone'). 그때는 fitStatus가 왼쪽부터 빼 시각을 남긴다.
  await eachLocale((l) => {
    const s = [`▶ ${msg().minShort(12)}`, msg().water(3, 8), '●', '23:59'].join('  ');
    assert.ok(fitsLine(s, W), `[${l}] ${s} (${getTextWidth(s)}px)`);
  });
});

test('아래 안내 줄: 안내와 오른쪽 글이 함께 들어간다', async () => {
  await eachLocale((l) => {
    const m = msg();
    const W = SCREEN_W - 4 - 12;
    const cases: Array<[string, string]> = [
      [m.hintOpenBack, m.sessionsTotal(20)],
      [m.hintOpenBack, m.legendUnread],
      [m.hintCloseBack, ''],
      [m.hintReplyBack, ''],
      [m.hintCheckBack, m.addOnPhoneWeb],
      [m.hintRunBack, m.registerOnPhoneWeb],
      [m.hintRunAnyway, ''],
      [m.hintBackToList, 'ls -la ~/projects'],
      [m.hintRefreshBack, 'macbook-pro'],
      [m.hintFullBack, ''],
      [m.hintResumeBack, `${m.turns(120)}  ·  $12.34`],
      [m.hintCommandsBack, `${m.turns(120)}  ·  $12.34`],
      [m.hintBack, ''],
    ];
    for (const [left, right] of cases) {
      const s = right ? `${left}   ${right}` : left;
      assert.ok(fitsLine(s, W), `[${l}] 안내 줄이 넘친다: ${s}`);
    }
  });
});

test('오른쪽 카드: 라벨이 잘리지 않는다 (세션·알림·할 일·명령·대화 정보)', async () => {
  await eachLocale((l) => {
    const m = msg();
    const noTrunc = (text: string, labels: string[], where: string) => {
      assert.ok(!text.includes('...'), `[${l}] ${where}에서 잘림: ${text}`);
      for (const label of labels) assert.ok(text.includes(label), `[${l}] ${where}에 '${label}'이 없다: ${text}`);
    };

    const sessions = layoutSessions({
      title: '$ relay ~/agents', status: '', hint: m.hintOpenBack, total: m.sessionsTotal(20),
      rows: [{ state: 'running', title: 'x', meta: m.minShort(59) }],
      counts: [
        { state: 'running', label: m.countRunning, count: 20 },
        { state: 'pending', label: m.countPending, count: 20 },
        { state: 'idle', label: m.countIdle, count: 20 },
        { state: 'offline', label: m.countOffline, count: 20 },
      ],
    });
    noTrunc(sessions.card.text, [m.countRunning, m.countPending, m.countIdle, m.countOffline], 'sessions card');

    const inbox = layoutNotifications({
      title: '$ relay ~/inbox', status: '', hint: m.hintOpenBack, legend: m.legendUnread, unread: 99,
      action: m.markAllRead,
      rows: [{ kind: 'info', read: false, title: 'x', meta: m.hourShort(23) }],
      counts: [
        { kind: 'error', label: m.kindError, count: 99 },
        { kind: 'permission', label: m.kindPermission, count: 99 },
        { kind: 'done', label: m.kindDone, count: 99 },
        { kind: 'info', label: m.kindInfo, count: 99 },
      ],
    });
    noTrunc(inbox.card.text, [m.newNotifications, m.kindError, m.kindPermission, m.kindDone, m.kindInfo], 'inbox card');
    assert.ok(inbox.list!.items.at(-1)!.endsWith(m.markAllRead));

    const todo = layoutChecklist({
      title: '$ ~/todo', status: '', hint: m.hintCheckBack, note: m.addOnPhoneWeb,
      items: [{ done: false, text: 'x' }], action: m.clearDone, progress: { done: 19, total: 20 },
    });
    noTrunc(todo.card.text, [m.todoProgress, m.todoLeft, m.todoDone], 'todo card');

    const cmds = layoutCommands({
      title: '$ ~/cmd', status: '', hint: m.hintRunBack, note: m.registerOnPhoneWeb,
      rows: [{ label: 'x', cron: 90 }],
      counts: { once: 20, cron: 20 },
      last: { label: 'x', exitCode: 1, ago: m.agoTight(m.minShort(5)) },
    });
    noTrunc(cmds.card.text, [m.cmdOnce, m.cmdCron, m.exitCode(1), m.agoTight(m.minShort(5))], 'commands card');

    const hist = layoutHistory({
      title: '$ ~/x', status: '', hint: m.hintFullBack, action: m.continueChat,
      rows: [{ kind: 'me', text: 'x' }],
      info: {
        state: 'pending', label: m.stateWaiting,
        rows: [
          { label: m.infoTurns, value: '120' },
          { label: m.infoCost, value: '$12.34' },
          { label: m.infoFolder, value: 'glasses' },
          { label: m.infoActivity, value: m.ago(m.minShort(59)) },
        ],
      },
    });
    noTrunc(hist.card.text, [m.stateWaiting, m.infoTurns, m.infoCost, m.infoActivity, m.ago(m.minShort(59))], 'history card');
    // 카드 폭: 390px 목록 옆 → 안쪽 폭
    const histInner = SCREEN_W - (390 + 6) - 6 - 2 * (6 + 1) - 6;
    for (const line of hist.card.text.split('\n')) {
      assert.ok(fitsLine(line, histInner + 6), `[${l}] history card 줄이 넘친다: ${line}`);
    }
    assert.ok(hist.list.items.at(-1)!.endsWith(m.continueChat));
  });
});

test('빈 화면 안내 카드: 제목·안내가 카드 폭(402px) 안에 든다', async () => {
  await eachLocale((l) => {
    const m = msg();
    const inner = 420 - 2 * (8 + 1);
    for (const s of [
      m.noSessionsTitle, m.noSessionsHint,
      m.noNotificationsTitle, m.noNotificationsHint,
      m.noTodosTitle, m.noTodosHint,
      m.noCommandsTitle, m.noCommandsHint,
      m.reading, m.runTerminalAgent, m.sysReadFailed, m.running,
    ]) {
      assert.ok(fitsLine(s, inner - 6), `[${l}] 안내가 넘친다 (${getTextWidth(s)}px): ${s}`);
    }
    // 시스템 화면 오른쪽 카드 머리
    const sys = layoutSystem({
      title: '$ ~/sys', status: '', hint: m.hintRefreshBack, note: 'host',
      summary: { cpu: 10, mem: { used: 1, total: 2 }, load: [1], uptime: '1d' },
      procs: [],
    });
    assert.ok(sys.procs!.text.startsWith(m.procHeader), `[${l}] ${sys.procs!.text}`);
    assert.ok(sys.procs!.text.includes(m.readFailed));
    assert.ok(!sys.procs!.text.includes('...'), `[${l}] ${sys.procs!.text}`);
  });
});

test('권한 요청·팝업·진행 카드·실행 결과 글이 칸에 들어간다', async () => {
  await eachLocale((l) => {
    const m = msg();
    const perm = layoutPermission({
      title: '$ ~/x', status: '', tool: 'Bash', summary: 'rm -rf build', hint: m.permHint,
      choices: [
        { kind: 'deny', label: m.permDeny },
        { kind: 'once', label: m.permOnce },
        { kind: 'always', label: m.permAlways },
      ],
    });
    for (const row of perm.list.items) assert.ok(fitsLine(row, SCREEN_W - 8 - 24), `[${l}] ${row}`);
    assert.ok(perm.card.text.split('\n')[0]!.endsWith(m.permHint), `[${l}] ${perm.card.text}`);

    const notice = layoutNotice({ kind: 'done', label: m.kindNotification, title: 'x', body: 'y', closeHint: m.closeHint(5) });
    assert.ok(notice.card.text.split('\n')[0]!.endsWith(m.newNotifications), `[${l}] ${notice.card.text}`);
    assert.ok(fitsLine(m.closeHint(10), SCREEN_W - 16), `[${l}] ${m.closeHint(10)}`);

    const live = layoutLive({
      title: '$ ~/x', status: '', lines: [], hint: m.hintCommandsBack, meta: '',
      idle: m.stateTapCommands(m.stateWaiting),
    });
    assert.ok(fitsLine(live.activity.text, SCREEN_W - 12 - 2 * (3 + 1) - 6), `[${l}] ${live.activity.text}`);
    assert.ok(fitsLine(`○  ${m.endedTapResume}`, SCREEN_W - 12 - 2 * (3 + 1) - 6));

    const confirm = layoutCommandResult({
      title: '$ x', status: '', state: 'confirm', command: 'rm -rf build', lines: [], hint: m.hintRunAnyway, note: '',
    });
    assert.ok(!confirm.card.text.split('\n')[0]!.includes('...'), `[${l}] ${confirm.card.text}`);
    const more = layoutCommandResult({
      title: '$ x', status: '', state: 'done', command: 'ls', lines: Array.from({ length: 30 }, (_, i) => `l${i}`), hint: m.hintBackToList, note: '',
    });
    assert.ok(more.card.text.trimEnd().endsWith(m.moreLines(24)), `[${l}] ${more.card.text}`);
  });
});

test('글 목록 화면(홈 선택지·타이머·설정·폴백): 머리줄과 줄이 한 칸에 들어간다', async () => {
  await eachLocale((l) => {
    const m = msg();
    // 머리줄 칸: 576px, 여백 6. clamp(header, 60)으로도 자른다.
    const headerW = SCREEN_W - 2 * 6;
    const headers = [
      m.homeMenuHeader,
      m.withBack(m.menuPhone),
      m.withBack(m.phoneHeader(`▶ ${m.minShort(60)}`, 10, 12)),
      m.withBack(m.menuSettings),
      m.withBack(m.menuCommands),
      m.withBack(m.commandsHeader(20, 20)),
      m.withBack(m.notificationsHeader(99, 99)),
      m.withBack(`${m.globalTodos} 20/20`),
      m.withBack([m.sessionsHeader(20), m.busyHeader(20)].join(' · ')),
      m.withBack(m.system),
      m.summary(20, 20, 99, 20, 20),
      m.permHeader('Bash'),
    ];
    for (const h of headers) {
      assert.ok(h.length <= 60, `[${l}] 60자를 넘는다: ${h}`);
      assert.ok(fitsLine(h, headerW), `[${l}] 머리줄이 넘친다 (${getTextWidth(h)}px): ${h}`);
    }

    // 목록 한 줄: 576px 목록, 여백 4, 칸 여백 12씩. 63바이트까지.
    const rowW = SCREEN_W - 2 * 4 - 2 * 12 - 12;
    const running: PhoneStatus = {
      timer: { phase: 'running', duration: 600, remaining: 290, progress: 0.5 },
      water: { enabled: true, count: 3, goal: 8 },
    };
    const idle: PhoneStatus = { ...running, timer: { phase: 'idle', duration: 0, remaining: 0, progress: 0 } };
    const rows = [
      m.screenOff, m.exit, m.cancel,
      m.phoneNeedsApp,
      ...phoneActions(idle).map((a) => a.label),
      ...phoneActions(running).map((a) => a.label),
      m.resumeTimer,
      m.voiceOn, m.voiceOff, m.logoOn, m.logoOff, m.idleChoice('*', 30),
      m.noSessionsRow, m.noHistoryRow, `> ${m.continueChat}`, m.noNotificationsRow, m.markAllRead,
      m.noCommandsRow, m.registerOnWebRow, `x${m.scheduledSuffix}`, m.noTodosRow, m.clearDone,
      m.permDeny, m.permOnce, m.permAlways, m.emptyList,
    ];
    for (const r of rows) {
      assert.ok(fitsLine(r, rowW), `[${l}] 목록 줄이 넘친다 (${getTextWidth(r)}px): ${r}`);
      assert.ok(utf8Bytes(r) <= ITEM_MAX_BYTES, `[${l}] 63바이트를 넘는다: ${r}`);
    }
  });
});

test('영어 글은 같은 자리의 한국어보다 크게 넓지 않다 (홈 메뉴 라벨)', async () => {
  // 홈 메뉴 칸은 오른쪽 값과 함께 238px이다. 라벨은 그 절반을 넘지 않게 둔다.
  await eachLocale((l) => {
    const m = msg();
    for (const label of [m.menuAgents, m.menuNotifications, m.menuChecklist, m.menuSystem, m.menuCommands, m.menuMac, m.menuPhone, m.menuSettings]) {
      assert.ok(getTextWidth(label) <= 140, `[${l}] 메뉴 라벨이 길다 (${getTextWidth(label)}px): ${label}`);
    }
  });
});

test('할 일 알림 제목은 서버 언어가 한국어든 영어든 알아본다', async () => {
  const { isTodoNoticeTitle } = await import('../src/core/glasses-ui.js');
  for (const t of [
    '할 일 추가: 우유', '할 일 완료: 우유', '할 일 3건 추가', '할 일 2건 삭제', '완료한 할 일 2건 정리',
    'To-Do Added: Milk', 'To-Do Completed: Milk', 'To-Do Reopened: Milk', 'To-Do Edited: Milk', 'To-Do Deleted: Milk',
    'Added 3 to-dos', 'Deleted 1 to-do', 'Cleared 2 completed to-dos', 'Cleared 1 completed to-do',
  ]) {
    assert.ok(isTodoNoticeTitle(t), t);
  }
  for (const t of ['Build finished', 'Deploy failed', '[KakaoTalk] 홍길동', '빌드 완료']) {
    assert.ok(!isTodoNoticeTitle(t), t);
  }
});
