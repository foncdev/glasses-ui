/**
 * 맥 화면(mac-agent) 검증.
 *
 *  - 텍스트 한 장이 늘 10줄 안, 줄마다 화면 폭 안에 든다(넘치면 안내 줄이 밀려난다)
 *  - 발표: 탭은 다음 쪽(발표 전이면 시작), 위·아래는 이전·다음 쪽. 화면이 꺼지지 않는다
 *  - 자막: 같은 id가 고쳐지다 굳는다. 말이 들리면 화면이 켜진다
 *  - 화면을 떠나면 SSE를 끊는다
 *  - 못 쓰는 기능은 메뉴에 사유가 붙고, 누르면 고칠 곳을 알려 준다
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { GestureEvent, GlassesAdapter, ItemLike } from '../src/core/glasses.js';
import { msg, setLocale } from '../src/core/i18n.js';
import {
  MAC_COLS,
  MAC_ROWS,
  captionsPage,
  errorText,
  macItemLabel,
  MAC_ITEMS,
  meetingPage,
  presentPage,
  shortcutPage,
  wrapLines,
  type CaptionLine,
  type PresentState,
  prompterPage,
  type PrompterState,
} from '../src/core/mac.js';

const NOW = Date.parse('2026-10-04T10:00:00+09:00');

/** 텍스트 화면 한 장이 기기에 그대로 들어가는지. 576px에서 한 줄씩. */
function fitsScreen(page: string): void {
  const lines = page.split('\n');
  assert.ok(lines.length <= MAC_ROWS, `${lines.length}줄 > ${MAC_ROWS}줄:\n${page}`);
  for (const line of lines) {
    assert.ok(getTextWidth(line) <= 564 && measureTextWrap(line, 564).lineCount === 1, `넘치는 줄 (${getTextWidth(line)}px): ${line}`);
  }
}

const longNotes = Array.from({ length: 30 }, (_, i) => `${i + 1}번째 요점은 이렇게 길게 이어지는 설명을 담고 있다`).join('\n');

test('발표 화면: 머리에 상태·쪽·경과, 노트, 다음 쪽 한 줄, 안내', () => {
  const state: PresentState = {
    status: 'playing', app: 'keynote', slide: 3, total: 12,
    notes: '첫 요점\n둘째 요점', nextNotes: '다음 쪽 노트 첫 줄\n둘째 줄', startedAt: new Date(NOW - 4 * 60_000).toISOString(),
  };
  const page = presentPage(state, undefined, NOW).split('\n');
  assert.equal(page[0], '발표 중 · 3 / 12쪽 · 4분');
  assert.deepEqual(page.slice(1, 3), ['첫 요점', '둘째 요점']);
  assert.ok(page.includes('다음: 다음 쪽 노트 첫 줄'));
  assert.equal(page.at(-2), '   이전    [▶다음]    끄기 ');
  assert.equal(page.at(-1), msg().presentHint);
  assert.equal(page.length, 10, '단추 줄은 늘 맨 아래 자리다');
});

test('발표 단추 줄: 고른 단추를 표시하고, 끄기 확인 중이면 안내가 바뀐다', () => {
  const state: PresentState = { status: 'playing', slide: 1, total: 3, notes: '노트' };
  const prev = presentPage(state, undefined, NOW, { cursor: 0, stopArmed: false }).split('\n');
  assert.equal(prev.at(-2), '  [▶이전]    다음     끄기 ');
  const armed = presentPage(state, undefined, NOW, { cursor: 2, stopArmed: true }).split('\n');
  assert.equal(armed.at(-2), '   이전     다음    [▶끄기]');
  assert.equal(armed.at(-1), msg().presentStopConfirm);
});

test('발표 화면은 어떤 노트든 10줄·화면 폭 안이다', () => {
  for (const locale of ['ko', 'en'] as const) {
    setLocale(locale);
    try {
      fitsScreen(presentPage({ status: 'playing', slide: 1, total: 99, notes: longNotes, nextNotes: longNotes, startedAt: new Date(NOW).toISOString() }, '오류가 났습니다 '.repeat(10), NOW));
      fitsScreen(presentPage({ status: 'playing', slide: 1, total: 2 }, undefined, NOW, { cursor: 2, stopArmed: true }));
      fitsScreen(presentPage({ status: 'ready', slide: 1, total: 2 }, undefined, NOW));
      fitsScreen(presentPage({ status: 'none' }, undefined, NOW));
      fitsScreen(presentPage(undefined, undefined, NOW));
    } finally {
      setLocale('ko');
    }
  }
});

test('발표 전이면 탭이 시작이라고 알린다. 노트가 없으면 그렇게 쓴다', () => {
  const page = presentPage({ status: 'ready', slide: 1, total: 5 }, undefined, NOW).split('\n');
  assert.equal(page[0], '대기 · 1 / 5쪽');
  assert.equal(page[1], '(노트 없음)');
  assert.equal(page.at(-1), msg().presentStartHint);
});

test('자막: 맨 아래가 지금 하는 말이고, 넘치면 위가 밀려난다', () => {
  const lines: CaptionLine[] = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, text: `${i + 1}번 줄 `.repeat(12), final: true, at: '' }));
  const partial = { id: 7, text: '지금 말하는 중', final: false, at: '' };
  const page = captionsPage(lines, partial, { running: true }, undefined);
  fitsScreen(page);
  const rows = page.split('\n');
  assert.equal(rows[0], '회의 자막 · 듣는 중');
  assert.equal(rows.at(-2), '지금 말하는 중');
  assert.equal(rows.at(-1), msg().captionsHintOn);
});

test('자막: 말하는 중인 줄이 화면보다 길면 앞이 밀려나고 끝(지금 하는 말)이 보인다', () => {
  const partial = { id: 1, text: `${'앞에서 한 말 '.repeat(40)}마지막 낱말`, final: false, at: '' };
  const page = captionsPage([], partial, { running: true }, undefined);
  fitsScreen(page);
  const rows = page.split('\n');
  assert.match(rows.at(-2) ?? '', /마지막 낱말$/);
  assert.ok(!page.includes('…'));
});

test('자막: 옮긴 글이 있으면 그걸 보이고, 번역 언어가 없으면 맨 위에 알린다', () => {
  const lines: CaptionLine[] = [
    { id: 1, text: 'We decided to ship.', final: true, at: '', translation: '출시하기로 했습니다.' },
    { id: 2, text: 'QA is next.', final: true, at: '' },
  ];
  const rows = captionsPage(lines, { id: 3, text: 'and then', final: false, at: '' }, { running: true }, undefined).split('\n');
  assert.deepEqual(rows.slice(1, 4), ['출시하기로 했습니다.', 'QA is next.', 'and then']);

  const missing = captionsPage(lines, undefined, { running: true, translateError: 'translation_not_installed' }, undefined).split('\n');
  assert.equal(missing[1], '맥에서 번역 언어를 내려받으세요');

  // PC는 같은 사유라도 PC에 맞는 말로
  const pc = captionsPage(lines, undefined, { running: true, translateError: 'translation_local_en_only' }, undefined, 'win-agent').split('\n');
  assert.equal(pc[1], 'PC 안 번역은 영어로만 됩니다');
  const cloud = captionsPage(lines, undefined, { running: true, translateError: 'translation_unsupported' }, undefined, 'win-agent').split('\n');
  assert.equal(cloud[1], 'PC 설정에서 클라우드 번역을 고르세요');
});

test('자막이 꺼져 있으면 탭하라고 알린다', () => {
  const rows = captionsPage([], undefined, { running: false }, undefined).split('\n');
  assert.equal(rows[1], msg().captionsIdle);
  assert.equal(rows.at(-1), msg().captionsHintOff);
});

test('다음 회의: 남은 시간·시각·장소·링크', () => {
  const event = {
    title: '주간 회의', start: new Date(NOW + 5 * 60_000).toISOString(), end: new Date(NOW + 35 * 60_000).toISOString(),
    location: '3층 회의실', meetingURL: 'https://zoom.us/j/1',
  };
  const page = meetingPage(event, undefined, NOW);
  fitsScreen(page);
  assert.match(page, /10:05 - 10:35 · 5분 뒤/);
  assert.match(page, /3층 회의실/);
  assert.match(page, /회의 링크 있음/);
  assert.match(meetingPage({ ...event, start: new Date(NOW - 60_000).toISOString() }, undefined, NOW), /진행 중/);
  assert.match(meetingPage({ ...event, start: new Date(NOW + 150 * 60_000).toISOString() }, undefined, NOW), /2시간 뒤/);
  assert.match(meetingPage(null, undefined, NOW), /24시간 안에 일정이 없습니다/);
});

test('줄 나누기는 줄바꿈을 살리고 폭을 넘지 않는다', () => {
  const rows = wrapLines('짧은 줄\n' + '가'.repeat(50), MAC_COLS, 5);
  assert.equal(rows[0], '짧은 줄');
  assert.ok(rows.length >= 3);
  assert.ok(wrapLines(longNotes, MAC_COLS, 4).at(-1)!.endsWith('…'), '넘치면 …로 끝난다');
});

test('메뉴: 못 쓰는 기능엔 사유가 붙고, 글은 목록 칸(63바이트) 안이다', () => {
  const caps = [
    { id: 'present', ready: true },
    { id: 'captions', ready: false, reason: 'screen_recording_required' },
    { id: 'calendar', ready: false, reason: 'license_required' },
  ];
  assert.deepEqual(MAC_ITEMS.map((i) => macItemLabel(i, caps)), [
    '발표 리모컨', '회의 자막 · 화면 기록 권한 필요', '다음 회의 · 라이선스 필요', '단축어 · 쓸 수 없음', '텔레프롬프터 · 쓸 수 없음',
    '발표 자료 · 쓸 수 없음',
  ]);
  for (const locale of ['ko', 'en'] as const) {
    setLocale(locale);
    try {
      for (const reason of ['license_required', 'folder_missing', 'folder_empty', 'automation_denied', 'screen_recording_required', 'speech_denied', 'calendar_denied', 'no_app', 'x']) {
        for (const item of MAC_ITEMS) {
          const label = macItemLabel(item, [{ id: item.capability, ready: false, reason }]);
          assert.ok(Buffer.byteLength(label) <= 63, `${label} > 63바이트`);
        }
      }
    } finally {
      setLocale('ko');
    }
  }
});

test('오류 글: 서버 코드로 짧은 사유를 고른다', () => {
  assert.equal(errorText({ code: 'no_agent', message: '연결된 mac-agent가 없습니다.' }), '컴퓨터가 연결되지 않았습니다');
  assert.equal(errorText({ code: 'license_required', message: '긴 문구' }), '라이선스 필요');
  assert.equal(errorText({ code: 'something', message: '그대로' }), '그대로');
});

test('단축어 결과 화면도 10줄 안이다', () => {
  fitsScreen(shortcutPage('불 끄기', 'done', '출력 '.repeat(200)));
  assert.match(shortcutPage('불 끄기', 'still', undefined), /맥에서 계속 실행 중/);
});

// --- 화면 흐름 ---

interface Harness {
  ui: GlassesUI;
  r: Record<string, unknown> & { openMenu(t: string): Promise<void> };
  fire(gesture: GestureEvent['gesture'], selectedIndex?: number): Promise<void>;
  lists: Array<{ header: string; items: ItemLike[] }>;
  texts: string[];
  calls: Array<{ path: string; body?: unknown }>;
  /** 열린 스트림. 이벤트를 밀어 넣고, 닫혔는지 본다. */
  streams: Array<{ path: string; push(type: string, data: unknown): void; closed: boolean }>;
}

async function harness(responses: Record<string, unknown>, caps = [
  { id: 'present', ready: true }, { id: 'captions', ready: true }, { id: 'calendar', ready: true }, { id: 'shortcuts', ready: true },
  { id: 'prompter', ready: true },
], agent = 'mac-agent'): Promise<Harness & { restore(): void }> {
  const lists: Harness['lists'] = [];
  const texts: string[] = [];
  const calls: Harness['calls'] = [];
  const streams: Harness['streams'] = [];
  let onG: ((e: GestureEvent) => void) | undefined;
  const glasses = {
    name: 'stub', isVoiceEnabled: false,
    async connect() {}, async disconnect() {}, async showHome() {},
    async showList(header: string, items: ItemLike[]) { lists.push({ header, items }); },
    async showText(t: string) { texts.push(t); },
    speak() {}, stopSpeaking() {}, setVoiceEnabled() {},
    async saveSetting() {}, async loadSetting() { return ''; },
    onGesture(cb: (e: GestureEvent) => void) { onG = cb; return () => {}; },
  } as unknown as GlassesAdapter;

  const orig = { ...agentCli };
  Object.assign(agentCli, {
    listSessions: async () => [],
    listNotifications: async () => ({ items: [], unread: 0 }),
    getGlobalChecklist: async () => [],
    sysSummary: async () => { throw new Error('x'); },
    listSnippets: async () => [],
    streamEvents: () => () => undefined,
    listExt: async () => (caps ? [{ agent, name: '맥', version: '1', capabilities: caps }] : []),
    mac: async (path: string, body?: unknown) => {
      calls.push({ path, body });
      const r = responses[path];
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? (r as (body: unknown) => unknown)(body) : r;
    },
    streamMac: (path: string, _types: string[], onEvent: (type: string, data: unknown) => void) => {
      const s = { path, closed: false, push: (type: string, data: unknown) => onEvent(type, data) };
      streams.push(s);
      return () => { s.closed = true; };
    },
  });

  const ui = new GlassesUI(glasses, { onLog: () => {} });
  await ui.start();
  const r = ui as unknown as Harness['r'];
  r.screenOff = false;
  const settle = () => new Promise((res) => setTimeout(res, 30));
  return {
    ui, r, lists, texts, calls, streams,
    async fire(gesture, selectedIndex) {
      onG!({ gesture, selectedIndex } as GestureEvent);
      await settle();
    },
    restore() {
      Object.assign(agentCli, orig);
      void ui.stop();
    },
  };
}

const playing = (slide: number): PresentState => ({ status: 'playing', slide, total: 10, notes: `${slide}쪽 노트`, startedAt: new Date().toISOString() });

test('맥 메뉴 → 발표: 탭은 고른 단추(처음엔 다음), 위로 이전을 고르면 탭이 이전. 이벤트로 바뀐 쪽이 그대로 그려진다', async () => {
  let slide = 3;
  const h = await harness({
    '/present/state': () => playing(slide),
    '/present/next': () => playing(++slide),
    '/present/prev': () => playing(--slide),
  });
  try {
    await h.r.openMenu('mac');
    assert.deepEqual(h.lists.at(-1)!.items, ['발표 리모컨', '회의 자막', '다음 회의', '단축어', '텔레프롬프터', '발표 자료 · 쓸 수 없음']);

    await h.fire('tap', 0);
    assert.equal(h.r.screen, 'mac-present');
    assert.match(h.texts.at(-1)!, /3 \/ 10쪽/);
    assert.equal(h.streams.at(-1)!.path, '/present/stream');

    await h.fire('tap');
    await h.fire('tap');
    assert.match(h.texts.at(-1)!, /5 \/ 10쪽/);
    // 위아래는 단추만 고르고 명령은 보내지 않는다.
    await h.fire('up');
    assert.match(h.texts.at(-1)!, /\[▶이전\]/);
    await h.fire('tap');
    assert.match(h.texts.at(-1)!, /4 \/ 10쪽/);
    await h.fire('tap');
    assert.match(h.texts.at(-1)!, /3 \/ 10쪽/, '고른 자리가 남아 탭만으로 계속 이전');
    assert.deepEqual(h.calls.filter((c) => c.path !== '/present/state').map((c) => c.path),
      ['/present/next', '/present/next', '/present/prev', '/present/prev']);

    // 맥에서 직접 넘겨도 스트림으로 따라온다.
    h.streams.at(-1)!.push('state', playing(9));
    await new Promise((res) => setTimeout(res, 20));
    assert.match(h.texts.at(-1)!, /9 \/ 10쪽/);
    assert.match(h.texts.at(-1)!, /9쪽 노트/);
  } finally {
    h.restore();
  }
});

test('발표 화면에서는 무조작으로 꺼지지 않고, 나가면 다시 꺼질 수 있다. 스트림도 닫힌다', async () => {
  const h = await harness({ '/present/state': () => playing(1) });
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 0);
    assert.equal(h.r.idleTimer, undefined, '발표 중엔 꺼짐 타이머가 없다');

    await h.fire('doubleTap');
    assert.equal(h.r.screen, 'mac');
    assert.ok(h.r.idleTimer, '맥 메뉴로 나오면 다시 건다');
    assert.equal(h.streams[0].closed, true);
  } finally {
    h.restore();
  }
});

test('발표 끄기: 끄기를 고르고 두 번 탭해야 끈다. 확인 중 두 번 탭은 취소다', async () => {
  let status = 'playing';
  const h = await harness({
    '/present/state': () => (status === 'playing' ? playing(2) : { status: 'ready', slide: 2, total: 10 }),
    '/present/stop': () => {
      status = 'ready';
      return { status: 'ready', slide: 2, total: 10 };
    },
  });
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 0);
    await h.fire('down');
    assert.match(h.texts.at(-1)!, /\[▶끄기\]/);

    await h.fire('tap');
    assert.ok(h.texts.at(-1)!.endsWith(msg().presentStopConfirm), '첫 탭은 확인만 묻는다');
    assert.ok(!h.calls.some((c) => c.path === '/present/stop'));

    await h.fire('doubleTap');
    assert.equal(h.r.screen, 'mac-present', '확인 중 두 번 탭은 나가지 않고 취소한다');
    assert.ok(h.texts.at(-1)!.endsWith(msg().presentHint));

    await h.fire('tap');
    await h.fire('tap');
    assert.equal(h.calls.at(-1)!.path, '/present/stop');
    assert.match(h.texts.at(-1)!, /대기/);
    assert.ok(h.texts.at(-1)!.endsWith(msg().presentStartHint));
  } finally {
    h.restore();
  }
});

const filesCaps = [
  { id: 'present', ready: true }, { id: 'captions', ready: true }, { id: 'calendar', ready: true }, { id: 'shortcuts', ready: true },
  { id: 'prompter', ready: true }, { id: 'present-files', ready: true },
];

test('발표 리모컨: 열린 문서가 없으면 발표 자료 목록으로 가고, 고르면 맥에서 열어 리모컨(대기)으로 간다', async () => {
  let opened = false;
  const h = await harness({
    '/present/state': () => (opened ? { status: 'ready', slide: 1, total: 8, document: '분기 실적.key' } : { status: 'none' }),
    '/present/files': { folder: '~/Documents/발표', files: [{ name: '분기 실적.key', app: 'keynote' }, { name: '제품 소개.pptx', app: 'powerpoint' }] },
    '/present/open': () => {
      opened = true;
      return { status: 'ready', slide: 1, total: 8, document: '분기 실적.key' };
    },
  }, filesCaps);
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 0);
    assert.equal(h.r.screen, 'mac-present-files');
    assert.deepEqual(h.lists.at(-1)!.items, ['분기 실적.key', '제품 소개.pptx']);
    assert.equal(h.streams.length, 0, '목록에서는 발표 스트림을 열지 않는다');

    await h.fire('tap', 0);
    assert.deepEqual(h.calls.find((c) => c.path === '/present/open')!.body, { name: '분기 실적.key' });
    assert.ok(h.texts.includes('여는 중: 분기 실적.key'));
    assert.equal(h.r.screen, 'mac-present');
    assert.match(h.texts.at(-1)!, /대기 · 1 \/ 8쪽/);
    assert.equal(h.streams.at(-1)!.path, '/present/stream');

    // 리모컨에서 두 번 탭하면 맥 메뉴로 나간다(목록으로 되돌아가지 않는다).
    await h.fire('doubleTap');
    assert.equal(h.r.screen, 'mac');
  } finally {
    h.restore();
  }
});

test('발표 자료: 메뉴에서 바로 연다. 비었으면 넣을 폴더를 알려 주고, 열기 실패는 머리에 사유를 싣는다', async () => {
  const empty = await harness({ '/present/files': { folder: '~/Documents/발표', files: [] } }, filesCaps);
  try {
    await empty.r.openMenu('mac');
    await empty.fire('tap', 5);
    assert.equal(empty.r.screen, 'mac-present-files');
    assert.match(empty.texts.at(-1)!, /~\/Documents\/발표에 Keynote·PowerPoint/);
    fitsScreen(empty.texts.at(-1)!);
  } finally {
    empty.restore();
  }

  const failing = await harness({
    '/present/files': { folder: '~', files: [{ name: 'a.key' }] },
    '/present/open': new Error('발표 앱으로 열지 못했습니다.'),
  }, filesCaps);
  try {
    await failing.r.openMenu('mac');
    await failing.fire('tap', 5);
    await failing.fire('tap', 0);
    assert.equal(failing.r.screen, 'mac-present-files', '실패하면 목록에 남는다');
    assert.match(failing.lists.at(-1)!.header, /열지 못했습니다/);
    assert.deepEqual(failing.lists.at(-1)!.items, ['a.key']);
  } finally {
    failing.restore();
  }
});

test('발표 전 화면: 자료 기능이 있으면 [시작] [자료] 단추. 자료를 고르면 목록, 시작을 탭하면 발표', async () => {
  let status = 'ready';
  const h = await harness({
    '/present/state': () => (status === 'ready' ? { status: 'ready', slide: 1, total: 4, document: '이미 연 발표.key' } : playing(1)),
    '/present/files': { folder: '~/Documents/발표', files: [{ name: '다른 발표.key' }] },
    '/present/start': () => {
      status = 'playing';
      return playing(1);
    },
  }, filesCaps);
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 0);
    assert.equal(h.r.screen, 'mac-present', '문서가 열려 있으면 리모컨이다');
    assert.ok(h.texts.at(-1)!.split('\n').includes('  [▶시작]    자료 '));

    await h.fire('down');
    await h.fire('tap');
    assert.equal(h.r.screen, 'mac-present-files');
    assert.deepEqual(h.lists.at(-1)!.items, ['다른 발표.key']);

    await h.fire('doubleTap');
    await h.fire('tap', 0);
    await h.fire('tap');
    assert.equal(h.calls.at(-1)!.path, '/present/start');
    assert.ok(h.texts.at(-1)!.split('\n').includes('   이전    [▶다음]    끄기 '), '발표가 시작되면 다음에 놓인다');
  } finally {
    h.restore();
  }
});

test('발표 상태를 못 읽어도 자료 기능이 있으면 목록으로 간다', async () => {
  const h = await harness({
    '/present/state': new Error('Keynote 제어 권한이 없습니다.'),
    '/present/files': { folder: '~', files: [{ name: 'a.key' }] },
  }, filesCaps);
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 0);
    assert.equal(h.r.screen, 'mac-present-files');
    assert.deepEqual(h.lists.at(-1)!.items, ['a.key']);
  } finally {
    h.restore();
  }
});

test('발표 자료 폴더를 맥이 못 읽으면(권한) 사유와 고칠 곳을 글 화면으로 다 보인다', async () => {
  const denied = '~/Documents/발표을 읽을 권한이 없습니다. 맥의 시스템 설정 > 개인정보 보호 및 보안 > 파일 및 폴더에서 mac-agent를 켜세요.';
  const h = await harness({ '/present/state': { status: 'none' }, '/present/files': new Error(denied) }, filesCaps);
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 0);
    assert.equal(h.r.screen, 'mac-present-files');
    const text = h.texts.at(-1)!;
    assert.match(text.replace(/\n/g, ''), /파일 및 폴더에서 mac-agent를 켜세요/);
    fitsScreen(text);
    await h.fire('doubleTap');
    assert.equal(h.r.screen, 'mac');
  } finally {
    h.restore();
  }
});

test('발표 자료: 자모로 풀린 한글 이름은 완성형으로 보이고, Pages·PDF는 문서 화면에서 위아래로 스크롤한다', async () => {
  const nfd = '회의록.pages'.normalize('NFD');
  const h = await harness({
    '/present/state': { status: 'none' },
    '/present/files': { folder: '~/Documents', files: [{ name: nfd, app: 'pages' }, { name: '발표.key', app: 'keynote' }] },
    '/present/open': { status: 'opened', app: 'pages', document: '회의록.pages' },
    '/present/scroll': { status: 'scrolled' },
  }, filesCaps);
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 0);
    const items = h.lists.at(-1)!.items as string[];
    assert.equal(items[0], '회의록.pages'.normalize('NFC'));
    assert.equal(items[0].length, '회의록.pages'.length, '완성형이다');

    await h.fire('tap', 0);
    assert.deepEqual(h.calls.find((c) => c.path === '/present/open')!.body, { name: nfd }, '맥에는 받은 이름 그대로 보낸다');
    assert.equal(h.r.screen, 'mac-document', 'Pages는 리모컨이 아니라 문서 화면이다');
    assert.match(h.texts.at(-1)!, /^회의록\.pages\nPages/);
    fitsScreen(h.texts.at(-1)!);

    await h.fire('down');
    await h.fire('up');
    await h.fire('tap');
    assert.deepEqual(h.calls.filter((c) => c.path === '/present/scroll').map((c) => c.body), [
      { direction: 'down', page: false }, { direction: 'up', page: false }, { direction: 'down', page: true },
    ]);

    await h.fire('doubleTap');
    assert.equal(h.r.screen, 'mac-present-files', '문서에서 두 번 탭은 목록으로');
    assert.deepEqual(h.lists.at(-1)!.items, items);
  } finally {
    h.restore();
  }
});

test('문서 스크롤이 막히면(손쉬운 사용 권한) 사유를 문서 화면에 보인다', async () => {
  const h = await harness({
    '/present/state': { status: 'none' },
    '/present/files': { folder: '~', files: [{ name: '자료.pdf', app: 'preview' }] },
    '/present/open': { status: 'opened', app: 'preview', document: '자료.pdf' },
    '/present/scroll': new Error('스크롤하려면 손쉬운 사용에서 mac-agent를 켜세요.'),
  }, filesCaps);
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 0);
    await h.fire('tap', 0);
    assert.match(h.texts.at(-1)!, /\nPDF\n/);
    await h.fire('down');
    assert.match(h.texts.at(-1)!.replace(/\n/g, ''), /손쉬운 사용에서 mac-agent를 ?켜세요/, '줄이 나뉘어도 사유가 다 보인다');
    fitsScreen(h.texts.at(-1)!);
  } finally {
    h.restore();
  }
});

test('발표 자료 기능이 없는 맥(옛 판·PC)이면 리모컨은 지금처럼 문서 없음 화면이다', async () => {
  const h = await harness({ '/present/state': { status: 'none' } });
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 0);
    assert.equal(h.r.screen, 'mac-present');
    assert.ok(!h.calls.some((c) => c.path === '/present/files'));
  } finally {
    h.restore();
  }
});

test('발표 전이면 탭이 발표를 시작한다', async () => {
  const h = await harness({
    '/present/state': () => ({ status: 'ready', slide: 1, total: 4 }),
    '/present/start': () => playing(1),
  });
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 0);
    await h.fire('tap');
    assert.equal(h.calls.at(-1)!.path, '/present/start');
    assert.match(h.texts.at(-1)!, /발표 중/);
  } finally {
    h.restore();
  }
});

test('자막: 탭으로 켜고, 말하는 중인 줄이 고쳐지다 굳는다. 말이 들리면 화면이 켜진다', async () => {
  let running = false;
  const h = await harness({
    '/captions/state': () => ({ running }),
    '/captions/transcript': () => ({ lines: [] }),
    '/captions/start': () => ((running = true), { running }),
  });
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 1);
    assert.equal(h.r.screen, 'mac-captions');
    assert.match(h.texts.at(-1)!, /탭하면 맥 소리를 받아씁니다/);

    await h.fire('tap');
    assert.equal(h.calls.at(-1)!.path, '/captions/start');
    assert.match(h.texts.at(-1)!, /듣는 중/);

    const stream = h.streams.at(-1)!;
    h.r.screenOff = true; // 조용해서 꺼진 상태
    stream.push('caption', { id: 1, text: '안녕', final: false, at: '' });
    stream.push('caption', { id: 1, text: '안녕하세요', final: false, at: '' });
    await new Promise((res) => setTimeout(res, 20));
    assert.equal(h.r.screenOff, false, '말이 들리면 켜진다');
    assert.match(h.texts.at(-1)!, /안녕하세요/);

    stream.push('caption', { id: 1, text: '안녕하세요.', final: true, at: '' });
    stream.push('caption', { id: 2, text: '', final: true, at: '' });
    await new Promise((res) => setTimeout(res, 20));
    const rows = h.texts.at(-1)!.split('\n');
    assert.equal(rows.filter((l) => l.startsWith('안녕')).length, 1, '같은 줄은 한 번만');
    assert.equal(rows[1], '안녕하세요.');
  } finally {
    h.restore();
  }
});

test('발표·자막 중에는 새 알림이 팝업으로 덮지 않는다', async () => {
  const h = await harness({ '/present/state': () => playing(1) });
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 0);
    const r = h.r as unknown as { noticeForNewNotifications(items: unknown[]): void; notice: unknown; lastSeenNotifId: string | null };
    const mail = (id: string) => [{ id, title: '새 메일', body: '', kind: 'info', createdAt: new Date().toISOString() }];

    // 첫 조회는 원래 띄우지 않으므로, 이미 하나 본 상태에서 시작한다.
    r.lastSeenNotifId = 'old';
    r.noticeForNewNotifications(mail('n1'));
    assert.equal(r.notice ?? null, null, '발표 화면에서는 팝업이 없다');

    // 대조: 홈에서는 같은 새 알림이 팝업으로 뜬다.
    await h.fire('doubleTap');
    await h.fire('doubleTap');
    assert.equal(h.r.screen, 'home');
    r.noticeForNewNotifications(mail('n2'));
    assert.ok(r.notice, '홈에서는 뜬다')
  } finally {
    h.restore();
  }
});

test('단축어: 고르면 돌리고 결과를 보여 준 뒤 탭하면 목록으로', async () => {
  const h = await harness({
    '/shortcuts': { folder: 'Relay', shortcuts: [{ id: 'a', name: '불 끄기' }, { id: 'b', name: '집 모드' }] },
    '/shortcuts/run': { status: 'done', output: '꺼졌습니다' },
  });
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 3);
    assert.deepEqual(h.lists.at(-1)!.items, ['불 끄기', '집 모드']);
    await h.fire('tap', 1);
    assert.deepEqual(h.calls.at(-1), { path: '/shortcuts/run', body: { id: 'b' } });
    assert.match(h.texts.at(-1)!, /집 모드 · 완료\n꺼졌습니다/);
    await h.fire('tap');
    assert.equal(h.r.screen, 'mac-shortcuts');
  } finally {
    h.restore();
  }
});

test('못 쓰는 기능을 누르면 사유와 고칠 곳을 보여 주고 아무것도 부르지 않는다', async () => {
  const h = await harness({}, [{ id: 'present', ready: false, reason: 'license_required' }]);
  try {
    await h.r.openMenu('mac');
    assert.equal(h.lists.at(-1)!.items[0], '발표 리모컨 · 라이선스 필요');
    await h.fire('tap', 0);
    assert.equal(h.r.screen, 'mac-result');
    assert.match(h.texts.at(-1)!, /라이선스 필요\n맥의 메뉴바나 PC의 트레이에서 설정하세요/);
    assert.equal(h.calls.length, 0);
    await h.fire('doubleTap');
    assert.equal(h.r.screen, 'mac');
  } finally {
    h.restore();
  }
});

test('맥이 붙어 있지 않으면 그렇게 알리고 탭해도 아무 일 없다', async () => {
  const h = await harness({}, null as unknown as []);
  try {
    await h.r.openMenu('mac');
    assert.deepEqual(h.lists.at(-1)!.items, ['컴퓨터가 연결되지 않았습니다']);
    await h.fire('tap', 0);
    assert.equal(h.r.screen, 'mac');
    await h.fire('doubleTap');
    assert.equal(h.r.screen, 'home');
  } finally {
    h.restore();
  }
});

const script = (line: number, following = false): PrompterState => ({
  hasScript: true, following, line, total: 30, start: Math.max(0, line - 1),
  lines: Array.from({ length: 9 }, (_, i) => `${Math.max(0, line - 1) + i + 1}번째 줄은 이렇게 꽤 길게 이어지는 원고 문장입니다`),
});

test('텔레프롬프터: 지금 줄에 ▷, 앞 줄 하나, 10줄·화면 폭 안', () => {
  for (const locale of ['ko', 'en'] as const) {
    setLocale(locale);
    try {
      fitsScreen(prompterPage(script(5, true), undefined));
      fitsScreen(prompterPage(script(0), '마이크 권한이 필요합니다 '.repeat(5)));
      fitsScreen(prompterPage({ hasScript: false, following: false, line: 0, total: 0, start: 0, lines: [] }, undefined));
    } finally {
      setLocale('ko');
    }
  }
  const rows = prompterPage(script(5, true), undefined).split('\n');
  assert.equal(rows[0], '텔레프롬프터 · 6/30 · 말 따라가는 중');
  assert.ok(rows[1].startsWith('5번째'), '앞 줄 하나');
  assert.ok(rows.some((r) => r.startsWith('▷ 6번째')), '지금 줄 표시');
  assert.equal(rows.at(-1), msg().prompterHintOn);
});

const paged = (page: number, extra: Partial<PrompterState> = {}): PrompterState => ({
  ...script(page * 3),
  page, pages: 7, slide: 2, pageLine: 1, mode: 'manual', playing: false,
  pageLines: ['둘째 쪽 첫 화면의 첫 줄입니다', '둘째 줄은 조금 더 길게 이어지는 원고 문장입니다', '셋째 줄'],
  nextPageFirst: '다음 화면 첫 줄은 이렇습니다',
  ...extra,
});

test('텔레프롬프터 화면 단위: 쪽·화면 번호, 한 화면 통째로, 다음 화면 첫 줄 미리 보기, 10줄·폭 안', () => {
  for (const locale of ['ko', 'en'] as const) {
    setLocale(locale);
    try {
      fitsScreen(prompterPage(paged(2), undefined));
      fitsScreen(prompterPage(paged(2, { following: true }), '마이크 권한이 필요합니다 '.repeat(5)));
      fitsScreen(prompterPage(paged(2, { mode: 'timeline', playing: true }), undefined));
    } finally {
      setLocale('ko');
    }
  }
  const rows = prompterPage(paged(2), undefined).split('\n');
  assert.equal(rows[0], '텔레프롬프터 · 2쪽 · 3/7');
  assert.equal(rows[1], '둘째 쪽 첫 화면의 첫 줄입니다');
  assert.ok(!rows.some((r) => r.startsWith('▷')), '손으로 넘길 때는 줄 표시가 없다');
  assert.ok(rows.includes('다음: 다음 화면 첫 줄은 이렇습니다'));
  assert.equal(rows.at(-1), msg().prompterHintPageOff);
  const timed = prompterPage(paged(2, { mode: 'timeline', playing: true }), undefined).split('\n');
  assert.equal(timed[0], '텔레프롬프터 · 2쪽 · 3/7 · 시간대로');
  assert.ok(timed.some((r) => r.startsWith('▷ 둘째 줄')), '흘릴 때는 지금 줄 표시');
  assert.equal(timed.at(-1), msg().prompterHintPagePlaying);
});

test('텔레프롬프터 화면 단위: 위아래는 화면 넘기기, 시간대로면 탭은 흘리기·멈추기', async () => {
  let state = paged(0);
  const h = await harness({
    '/prompter/state': () => state,
    '/prompter/page': (body: unknown) => (state = paged(Math.max(0, (state.page ?? 0) + (body as { delta: number }).delta), { mode: state.mode })),
    '/prompter/play': (body: unknown) => (state = { ...state, playing: (body as { on: boolean }).on }),
  });
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 4);
    await h.fire('down');
    await h.fire('down');
    await h.fire('up');
    assert.deepEqual(h.calls.at(-1), { path: '/prompter/page', body: { delta: -1 } });
    assert.match(h.texts.at(-1)!, /· 2\/7/);
    state = { ...state, mode: 'timeline' };
    h.streams.at(-1)!.push('state', state);
    await new Promise((res) => setTimeout(res, 20));
    await h.fire('tap');
    assert.deepEqual(h.calls.at(-1), { path: '/prompter/play', body: { on: true } });
    assert.match(h.texts.at(-1)!, /시간대로/);
  } finally {
    h.restore();
  }
});

test('텔레프롬프터: 원고가 없으면 탭으로 맥 클립보드를 불러오고, 있으면 탭으로 따라가기를 켠다. 꺼지지 않는다', async () => {
  let state: PrompterState = { hasScript: false, following: false, line: 0, total: 0, start: 0, lines: [] };
  const h = await harness({
    '/prompter/state': () => state,
    '/prompter/load-clipboard': () => (state = script(0)),
    '/prompter/follow': () => (state = { ...state, following: true }),
    '/prompter/next': () => (state = script(state.line + 1, state.following)),
    '/prompter/prev': () => (state = script(Math.max(0, state.line - 1), state.following)),
  });
  try {
    await h.r.openMenu('mac');
    await h.fire('tap', 4);
    assert.equal(h.r.screen, 'mac-prompter');
    assert.equal(h.r.idleTimer, undefined, '원고 화면에서는 꺼지지 않는다');
    assert.match(h.texts.at(-1)!, /컴퓨터에서 원고를 복사한 뒤 탭하세요/);

    await h.fire('tap');
    assert.equal(h.calls.at(-1)!.path, '/prompter/load-clipboard');
    await h.fire('tap');
    assert.deepEqual(h.calls.at(-1), { path: '/prompter/follow', body: { on: true } });
    assert.match(h.texts.at(-1)!, /말 따라가는 중/);

    await h.fire('down');
    await h.fire('down');
    await h.fire('up');
    assert.match(h.texts.at(-1)!, /· 2\/30 ·/);

    // 맥에서 말을 따라 넘어가면 스트림으로 온다.
    h.streams.at(-1)!.push('state', script(12, true));
    await new Promise((res) => setTimeout(res, 20));
    assert.match(h.texts.at(-1)!, /▷ 13번째/);

    await h.fire('doubleTap');
    assert.equal(h.r.screen, 'mac');
    assert.equal(h.streams.at(-1)!.closed, true);
  } finally {
    h.restore();
  }
});

test('메시지 알림: 탭하면 답장 목록, 고르면 맥에서 보내고 결과 뒤 알림 목록으로. 다른 알림은 탭이 닫기', async () => {
  const h = await harness({ '/messages/reply': { status: 'sent', to: '홍길동' } });
  try {
    const r = h.r as unknown as Record<string, unknown> & { render(): Promise<void> };
    r.openNotif = { id: 'n1', title: '[메시지] 홍길동', body: '오늘 저녁 몇 시에 와?', kind: 'info', createdAt: new Date().toISOString() };
    r.screen = 'notification';
    await r.render();

    await h.fire('tap');
    assert.equal(h.r.screen, 'mac-reply');
    assert.equal(h.lists.at(-1)!.header, '홍길동에게 답장 · 더블탭 뒤로');
    assert.deepEqual(h.lists.at(-1)!.items, ['알겠어요.', '곧 갈게요.', '지금은 어려워요. 나중에 연락할게요.', '고마워요!', '취소']);
    for (const item of h.lists.at(-1)!.items) assert.ok(Buffer.byteLength(String(item)) <= 63);

    await h.fire('tap', 1);
    assert.deepEqual(h.calls.at(-1), { path: '/messages/reply', body: { to: '홍길동', text: '곧 갈게요.' } });
    assert.match(h.texts.at(-1)!, /홍길동에게 답장 · 완료\n곧 갈게요\./);

    await h.fire('tap');
    assert.equal(h.r.screen, 'notifications');

    // 취소는 아무것도 보내지 않고 알림으로 돌아간다.
    r.openNotif = { id: 'n2', title: '[메시지] 홍길동', body: '?', kind: 'info', createdAt: new Date().toISOString() };
    r.screen = 'notification';
    await r.render();
    await h.fire('tap');
    await h.fire('tap', 4);
    assert.equal(h.r.screen, 'notification');
    assert.equal(h.calls.filter((c) => c.path === '/messages/reply').length, 1);

    // 메시지가 아닌 알림은 예전처럼 탭이 닫기다.
    r.openNotif = { id: 'n3', title: '[카카오톡] 홍길동', body: '?', kind: 'info', createdAt: new Date().toISOString() };
    r.screen = 'notification';
    await r.render();
    await h.fire('tap');
    assert.equal(h.r.screen, 'notifications');
  } finally {
    h.restore();
  }
});

test('메시지 답장이 꺼져 있으면 맥의 사유를 보여 준다', async () => {
  const err = Object.assign(new Error('메시지 답장이 꺼져 있습니다. 맥의 mac-agent 설정에서 켜세요.'), { code: 'messages_disabled', status: 403 });
  const h = await harness({ '/messages/reply': err });
  try {
    const r = h.r as unknown as Record<string, unknown> & { render(): Promise<void> };
    r.openNotif = { id: 'n1', title: '[메시지] 홍길동', body: '?', kind: 'info', createdAt: new Date().toISOString() };
    r.screen = 'notification';
    await r.render();
    await h.fire('tap');
    await h.fire('tap', 0);
    assert.match(h.texts.at(-1)!, /실패\n메시지 답장이 꺼져 있습니다/);
  } finally {
    h.restore();
  }
});

test('PC(win-agent)만 붙어 있으면 그쪽을 고르고 제목을 PC로 한다', async () => {
  const h = await harness({}, [{ id: 'present', ready: true }], 'win-agent');
  try {
    await h.r.openMenu('mac');
    assert.equal(agentCli.desktopAgent, 'win-agent');
    assert.match(h.lists.at(-1)!.header, /^PC/);
  } finally {
    h.restore();
  }
  assert.equal(agentCli.desktopAgent, 'mac-agent', 'restore가 되돌린다');
});

test('고른 데스크톱 에이전트의 경로로 부른다(/ext/win-agent/…)', async () => {
  const before = agentCli.desktopAgent;
  const seen: string[] = [];
  const cli = agentCli as unknown as { request: (path: string) => Promise<unknown> };
  const origRequest = cli.request;
  cli.request = async (path: string) => {
    seen.push(path);
    return {};
  };
  // 앞 시험의 harness가 mac을 인스턴스에 덮어 둔 채라 원래 메서드를 부른다.
  const mac = Object.getPrototypeOf(agentCli).mac as typeof agentCli.mac;
  try {
    agentCli.desktopAgent = 'win-agent';
    await mac.call(agentCli, '/info');
    agentCli.desktopAgent = 'mac-agent';
    await mac.call(agentCli, '/present/state');
    assert.deepEqual(seen, ['/ext/win-agent/info', '/ext/mac-agent/present/state']);
  } finally {
    cli.request = origRequest;
    agentCli.desktopAgent = before;
  }
});

test('PC(win-agent) 텔레프롬프터: 원고가 있으면 탭은 따라가기 대신 다음 줄로', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `${i + 1}번째 줄`);
  let state = { hasScript: true, following: false, line: 0, total: 10, start: 0, lines, mode: 'manual' } as unknown as PrompterState;
  const h = await harness({
    '/prompter/state': () => state,
    '/prompter/next': () => (state = { ...state, line: state.line + 1 } as PrompterState),
  }, [{ id: 'prompter', ready: true }], 'win-agent');
  try {
    await h.r.openMenu('mac');
    const index = h.lists.at(-1)!.items.findIndex((i) => String(typeof i === 'string' ? i : (i as { label?: string }).label ?? i).includes('텔레프롬프터'));
    await h.fire('tap', index);
    assert.equal(h.r.screen, 'mac-prompter');
    await h.fire('tap');
    assert.equal(h.calls.at(-1)!.path, '/prompter/next');
    assert.ok(!h.calls.some((c) => c.path === '/prompter/follow'));
  } finally {
    h.restore();
  }
});

test('PC(win-agent) 컴퓨터 메뉴: 단축어 자리는 스크립트, 폴더가 없으면 스크립트 폴더 없음', () => {
  const item = MAC_ITEMS.find((i) => i.capability === 'shortcuts')!;
  assert.equal(macItemLabel(item, [{ id: 'shortcuts', ready: true }], 'win-agent'), '스크립트');
  assert.equal(macItemLabel(item, [{ id: 'shortcuts', ready: false, reason: 'folder_missing' }], 'win-agent'), '스크립트 · 스크립트 폴더 없음');
  assert.equal(macItemLabel(item, [{ id: 'shortcuts', ready: false, reason: 'folder_missing' }]), '단축어 · Relay 폴더 없음');
});
