/**
 * 화면 출력 고정.
 *
 * 다기기 지원으로 넘어가면서 본체가 글자를 만들던 일을 어댑터로 내린다.
 * 그 과정에서 G2 화면이 조용히 틀어지는 것을 막으려고, 지금 나오는 글자를
 * 그대로 박아 둔다.
 *
 * 여기가 깨지면 둘 중 하나다.
 *   - 실수로 G2 출력이 바뀌었다 → 코드를 고친다
 *   - 의도적으로 바꿨다 → 기대값을 고치고 왜 바뀌었는지 남긴다
 *
 * 상태 글자(* · ! > ○, [x], -)는 이제 G2 어댑터가 만든다. 본체는 뜻만
 * 넘긴다. 옮긴 뒤에도 화면에 뜨는 글자는 같아야 한다.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import { toItem, type GestureEvent, type GlassesAdapter, type ItemLike } from '../src/core/glasses.js';
import { asText, MARK } from './g2-text.js';

function stubGlasses() {
  const shown: { header: string; items: string[]; side?: string[] }[] = [];
  const texts: string[] = [];
  let onGesture: ((e: GestureEvent) => void) | undefined;
  let voice = true;

  const glasses = {
    name: 'stub',
    get isVoiceEnabled() {
      return voice;
    },
    async connect() {},
    async disconnect() {},
    // 본체가 넘긴 Item을 G2가 그리는 글자로 바꿔서 담는다.
    // 화면에 실제로 뜨는 문자열을 검사하려는 것이다.
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

  return { glasses, shown, texts, fire: (g: string, i?: number) => onGesture?.({ gesture: g, selectedIndex: i } as GestureEvent) };
}

/**
 * 상태 글자를 전부 훑도록 일부러 여러 상태를 섞었다.
 * statusOf의 분기 여섯 개가 모두 걸린다.
 */
const SESSIONS = [
  { id: 'a', title: '대기 세션', live: true, status: 'idle' },
  { id: 'b', title: '작업 중 세션', live: true, status: 'busy' },
  { id: 'c', title: '승인 대기 세션', live: true, status: 'waiting' },
  { id: 'd', title: '권한 요청 세션', live: true, status: 'busy', pending: [{ id: 'p1' }] },
  { id: 'e', title: '끊긴 세션', live: false, status: 'closed' },
];

const NOTIFS = [
  { id: 'n1', title: '읽은 알림', body: '본문', kind: 'done', createdAt: '', readAt: '2026-01-01T00:00:00Z' },
  { id: 'n2', title: '안 읽은 알림', body: '본문', kind: 'error', createdAt: '' },
];

const CHECKLIST = [
  { id: 'c1', text: '끝난 항목', done: true, createdAt: '' },
  { id: 'c2', text: '남은 항목', done: false, createdAt: '' },
];

async function boot() {
  const stub = stubGlasses();
  const ui = new GlassesUI(stub.glasses, { onLog: () => {} });

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
  agentCli.getGlobalChecklist = async () => CHECKLIST as never;
  agentCli.getHistory = async () => [] as never;
  agentCli.readNotification = async () => 0;
  agentCli.readAllNotifications = async () => {};

  await ui.start();

  const r = ui as unknown as { screen: string; screenOff: boolean; render(): Promise<void> };
  r.screenOff = false;

  return { ui, r, restore: () => Object.assign(agentCli, orig), ...stub };
}

/** 해당 화면을 그리고 마지막에 나온 목록을 돌려준다. */
async function draw(screen: string) {
  const s = await boot();
  try {
    s.r.screen = screen;
    s.shown.length = 0;
    await s.r.render();
    return s.shown.at(-1);
  } finally {
    s.restore();
  }
}

test('세션 목록의 상태 글자가 그대로다', async () => {
  const out = await draw('sessions');
  assert.ok(out, '세션 화면이 목록을 그려야 한다');

  // statusOf 분기 전부. pending과 waiting은 뜻이 다르지만 G2에서는
  // 둘 다 '!'로 보인다. 색을 쓸 수 있는 기기는 다르게 그릴 수 있다.
  assert.deepEqual(out.items, [
    '○ 대기 세션',
    '> 작업 중 세션',
    '! 승인 대기 세션',
    '! 권한 요청 세션',
    '· 끊긴 세션',
  ]);
});

test('알림 목록의 읽음 표시가 그대로다', async () => {
  const out = await draw('notifications');
  assert.ok(out);
  // 마지막 줄은 항목이 아니라 액션이다. 상태 글자가 붙지 않는다.
  assert.deepEqual(out.items, ['- 읽은 알림', '* 안 읽은 알림', '모두 읽음 처리']);
});

test('체크리스트의 완료 표시가 그대로다', async () => {
  const out = await draw('checklist');
  assert.ok(out);
  assert.deepEqual(out.items, ['[x] 끝난 항목', '[ ] 남은 항목', '완료 항목 치우기']);
});

test('긴 제목은 화면 폭에 맞춰 잘린다', async () => {
  const s = await boot();
  try {
    // 한글은 한 글자가 두 칸이다. 글자 수로 세면 목록이 화면 밖으로
    // 밀리므로 폭으로 잘라야 한다.
    agentCli.listSessions = async () =>
      [{ id: 'x', title: '가'.repeat(60), live: true, status: 'idle' }] as never;

    // boot()이 이미 세션을 읽어 왔으므로 다시 읽게 한다.
    const rr = s.ui as unknown as { sessions: unknown[] };
    rr.sessions = await agentCli.listSessions();

    s.r.screen = 'sessions';
    s.shown.length = 0;
    await s.r.render();

    const line = s.shown.at(-1)?.items[0] ?? '';
    assert.ok(line.endsWith('…'), `잘림 표시가 있어야 한다: ${line}`);
    assert.ok(
      displayWidth(line) <= COLS,
      `화면 폭을 넘지 않아야 한다: ${displayWidth(line)}칸`,
    );
  } finally {
    s.restore();
  }
});

test('영문 제목은 한글보다 더 많이 들어간다', async () => {
  const s = await boot();
  try {
    // 폭으로 세므로 영문은 칸당 한 글자씩 들어간다. 글자 수로 자르던
    // 예전에는 영문도 38자에서 끊겨 화면을 절반만 썼다.
    agentCli.listSessions = async () =>
      [{ id: 'x', title: 'a'.repeat(100), live: true, status: 'idle' }] as never;

    const rr = s.ui as unknown as { sessions: unknown[] };
    rr.sessions = await agentCli.listSessions();

    s.r.screen = 'sessions';
    s.shown.length = 0;
    await s.r.render();

    const line = s.shown.at(-1)?.items[0] ?? '';
    assert.ok(displayWidth(line) <= COLS, `폭 상한: ${displayWidth(line)}`);
    // 한글 33자보다 확실히 많이 들어가야 의미가 있다.
    assert.ok([...line].length > 50, `영문이 더 들어가야 한다: ${[...line].length}자`);
  } finally {
    s.restore();
  }
});

test('위 MARK 표가 G2 어댑터와 같다', async () => {
  // 복사본이 조용히 낡는 것을 막는다. 어댑터에서 상태→글자 표를
  // 직접 읽어 여기 것과 맞춰 본다.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/adapters/g2.ts', import.meta.url), 'utf8');

  const m = /const MARK: Record<ItemState, string> = \{([\s\S]*?)\};/.exec(src);
  assert.ok(m, 'g2.ts에서 MARK 표를 찾지 못했습니다.');

  const real: Record<string, string> = {};
  for (const [, k, v] of m[1]!.matchAll(/(\w+):\s*'([^']*)'/g)) real[k!] = v!;

  assert.deepEqual(real, MARK, 'g2.ts의 MARK가 바뀌었습니다. 이 파일도 맞추세요.');
});

test('홈 요약 한 줄이 그대로다', async () => {
  const out = await draw('home');
  assert.ok(out);

  // 세션 5개 중 busy 2개(b, d) · 안읽음 1 · 체크 1/2
  assert.match(out.header, /세션/);
  assert.deepEqual(out.items, ['에이전트', '알림 보기', '체크 보기', '설정']);
});
