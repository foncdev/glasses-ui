/**
 * 마지막 답을 끝까지 읽는 화면과 /usage 카드 검증.
 *
 * 대화 화면은 답의 첫 줄만 보여 /usage를 보내면 "You are currently using your subscription…"만
 * 남고 숫자는 다 잘렸다. 위·아래로 결과 읽기를 열어 쪽으로 넘기고, /usage는 막대 카드로 보인다.
 * 한 장은 늘 10줄·화면 폭 안이다(픽셀로 잰다).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext';
import { GlassesUI } from '../src/core/glasses-ui.js';
import { agentCli } from '../src/core/agent-cli.js';
import type { SessionEvent, SessionInfo } from '../src/core/agent-cli.js';
import type { GestureEvent, GlassesAdapter } from '../src/core/glasses.js';
import { MAC_ROWS } from '../src/core/mac.js';
import { paginate, parseUsage, plainText, shortReset, usageBar } from '../src/core/reader.js';
import { GLASSES_LOGO } from '../src/adapters/g2-logo.js';

/** 2026-10-09에 실제 /usage가 돌려준 글(구독 계정). */
const USAGE = `You are currently using your subscription to power your Claude Code usage

Current session: 5% used · resets Oct 9 at 7pm (Asia/Seoul)
Current week (all models): 23% used · resets Oct 15 at 2am (Asia/Seoul)
Current week (Fable): 0% used · resets Oct 15 at 2am (Asia/Seoul)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai. Behaviors are independent characteristics, not a breakdown.

Last 24h · 1173 requests · 81 sessions
  83% of your usage was at >150k context
  64% of your usage came from subagent-heavy sessions
  43% of your usage was while 4+ sessions ran in parallel
  Top subagents: Explore 2%, general-purpose 1%

Last 7d · 9581 requests · 572 sessions
  87% of your usage came from subagent-heavy sessions
  81% of your usage was at >150k context
  60% of your usage came from sessions active for 8+ hours
  33% of your usage was while 4+ sessions ran in parallel
  Top skills: /everything-evenhub:simulator-automation 2%, /claude-in-chrome 1%
  Top subagents: general-purpose 5%, Explore 1%, ios-senior-developer 1%, android-senior-developer 1%
  Top plugins: everything-evenhub 2%`;

function fitsScreen(page: string): void {
  const lines = page.split('\n');
  assert.ok(lines.length <= MAC_ROWS, `${lines.length}줄 > ${MAC_ROWS}줄:\n${page}`);
  for (const line of lines) {
    assert.ok(getTextWidth(line) <= 564 && measureTextWrap(line, 564).lineCount === 1, `넘치는 줄 (${getTextWidth(line)}px): ${line}`);
  }
}

test('/usage 한도 줄을 읽는다. 세션·이번 주·모델별 주간을 가른다', () => {
  const u = parseUsage(USAGE);
  assert.ok(u);
  assert.equal(u.subscription, true);
  assert.deepEqual(
    u.limits.map((k) => [k.kind, k.label, k.percent, k.resets]),
    [
      ['session', '', 5, 'Oct 9 at 7pm'],
      ['week', '', 23, 'Oct 15 at 2am'],
      ['model', 'Fable', 0, 'Oct 15 at 2am'],
    ],
  );
  assert.match(u.details, /^What's contributing/);
  assert.equal(parseUsage('그냥 답입니다'), null, '한도 줄이 없으면 카드로 만들지 않는다');
});

test('초기화 시각은 오늘이면 시각만, 아니면 월/일 시각', () => {
  const now = new Date(2026, 9, 9, 15, 0);
  assert.equal(shortReset('Oct 9 at 7pm', now), '19:00');
  assert.equal(shortReset('Oct 15 at 2am', now), '10/15 02:00');
  assert.equal(shortReset('Oct 15 at 12am', now), '10/15 00:00');
  assert.equal(shortReset('Oct 15 at 12:30pm', now), '10/15 12:30');
  assert.equal(shortReset('곧', now), '곧', '읽지 못하면 그대로');
  assert.equal(usageBar(23, 14), `${'━'.repeat(3)}${'─'.repeat(11)}`);
  assert.equal(usageBar(100, 14), '━'.repeat(14));
});

test('마크다운 기호를 걷고, 폭에 맞춰 접어 쪽으로 나눈다', () => {
  const md = '## 결과\n\n**완료**했습니다. `npm test` 통과.\n\n| 항목 | 값 |\n|---|---|\n| 시험 | 246 |\n\n```ts\nconst a = 1;\n```\n- [링크](https://x.y) 하나';
  assert.equal(plainText(md), '결과\n\n완료했습니다. npm test 통과.\n\n항목  값\n시험  246\n\nconst a = 1;\n· 링크 하나');
  const pages = paginate('가'.repeat(200), 44, 8);
  assert.ok(pages.length >= 2);
  assert.ok(pages.every((p) => p.length <= 8));
});

async function setup(reply: string) {
  const texts: string[] = [];
  let onG: ((e: GestureEvent) => void) | undefined;
  const sessions = [{ id: 'a', title: '빌드', live: true, status: 'idle', pending: [] } as unknown as SessionInfo];
  const glasses = {
    name: 'stub',
    logo: GLASSES_LOGO,
    get isVoiceEnabled() {
      return false;
    },
    async connect() {},
    async disconnect() {},
    async showList() {},
    async showText(t: string) {
      texts.push(t);
    },
    async speak() {},
    setVoiceEnabled() {},
    async saveSetting() {},
    async loadSetting() {
      return '';
    },
    onGesture(cb: (e: GestureEvent) => void) {
      onG = cb;
      return () => {};
    },
  } as unknown as GlassesAdapter;

  const orig = { ...agentCli };
  agentCli.listSessions = async () => sessions;
  agentCli.listNotifications = async () => ({ items: [] as never, unread: 0 });
  agentCli.getGlobalChecklist = async () => [] as never;
  agentCli.listExt = async () => [] as never;
  // 기록의 마지막 턴: /usage를 보냈고 결과가 왔다.
  agentCli.getHistory = async () =>
    [
      { type: 'user', text: '/usage' },
      { type: 'assistant', text: reply },
      { type: 'turn_complete', result: reply },
    ] as unknown as SessionEvent[];
  agentCli.streamEvents = (() => () => undefined) as typeof agentCli.streamEvents;
  agentCli.streamSession = (() => () => undefined) as typeof agentCli.streamSession;

  const ui = new GlassesUI(glasses, { onLog: () => {} });
  await ui.start();
  const r = ui as unknown as { screen: string; screenOff: boolean; refresh(): Promise<void> };
  r.screenOff = false;
  await r.refresh();
  await ui.open('a');
  return {
    r,
    texts,
    fire: (gesture: string) => onG?.({ gesture } as GestureEvent),
    restore: () => Object.assign(agentCli, orig),
  };
}

const settle = (ms = 40) => new Promise((res) => setTimeout(res, ms));

test('대화 화면에서 아래로 넘기면 /usage가 한도 카드로 뜨고, 이어서 사용 분석을 넘겨 본다', async () => {
  const t = await setup(USAGE);
  try {
    t.fire('down');
    await settle();
    assert.equal(t.r.screen, 'reader');
    const card = t.texts.at(-1)!;
    fitsScreen(card);
    const rows = card.split('\n');
    assert.match(rows[0]!, /^사용 한도 · 구독  1\/\d+$/);
    assert.match(rows[1]!, /^세션 +━.* {2}5% {2}\S/);
    assert.match(rows[2]!, /^이번 주 +━.* 23% {2}10\/15 02:00$/);
    assert.match(rows[3]!, /^Fable +─+ {3}0% {2}10\/15 02:00$/);
    assert.ok(card.includes('▼ 사용 분석'));

    t.fire('down');
    await settle();
    const next = t.texts.at(-1)!;
    fitsScreen(next);
    assert.match(next, /What's contributing/);

    t.fire('up');
    await settle();
    assert.equal(t.texts.at(-1), card, '위로 넘기면 앞 쪽');

    t.fire('doubleTap');
    await settle();
    assert.equal(t.r.screen, 'detail');
  } finally {
    t.restore();
  }
});

test('일반 답은 끝까지 쪽으로 나눠 보이고, 마지막 쪽에서 탭하면 대화 화면으로', async () => {
  const long = Array.from({ length: 30 }, (_, i) => `${i + 1}. **바꾼 파일** \`src/core/x${i}.ts\` 의 설명이 꽤 길게 이어진다`).join('\n');
  const t = await setup(long);
  try {
    t.fire('up');
    await settle();
    const first = t.texts.at(-1)!;
    fitsScreen(first);
    assert.match(first, /^마지막 답 {2}1\/\d+/);
    assert.ok(!first.includes('**'), '마크다운 기호가 남았다');
    const total = Number(/1\/(\d+)/.exec(first)![1]);
    for (let i = 1; i < total; i++) {
      t.fire('tap');
      await settle();
      fitsScreen(t.texts.at(-1)!);
    }
    assert.match(t.texts.at(-1)!, /30\. 바꾼 파일/, '마지막 쪽에 끝 줄이 있어야 한다');
    t.fire('tap');
    await settle();
    assert.equal(t.r.screen, 'detail');
  } finally {
    t.restore();
  }
});
