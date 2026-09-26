/**
 * G2 세션 화면 배치. 홈(g2-home)과 같은 규칙을 쓴다.
 *
 *   ┌ $ relay ~/agents ················· 작업 1   ◆ 승인 1   14:05 ┐
 *   ├────────────────────────── 구분선 ──────────────────────────────┤
 *   │ ● agent-cli 테스트 보강       방금 │ ╭ ● 작업 중        1 ╮     │
 *   │ ◆ relay 보안 점검              1분 │ │ ◆ 승인 요청      1 │     │
 *   │ ○ 안경 홈 화면 개편           12분 │ │ ○ 대기           2 │     │
 *   │ (5칸, 스크롤)                      │ ╰ ◌ 종료           3 ╯     │
 *   │ ● 열기    ●● 뒤로 ····································· 세션 7개 │
 *   └────────────────────────────────────────────────────────────────┘
 *
 * 목록 한 칸은 63바이트뿐이라 한글 제목에 오른쪽 정렬까지 넣으면 넘친다.
 * 그래서 목록을 360px로 좁혀 제목·경과 시간만 두고, 넘치면 제목을 줄인다.
 * 상태별 개수는 글자 칸(바이트 한도 없음)인 오른쪽 카드에 둔다.
 */
import type { ItemState, SessionsView } from '../core/glasses.js';
import { type Box, SCREEN_W, alignRight, center, listHeight, spread, spreadItem } from './g2-home.js';

/**
 * 상태 기호. 이 폰트에 있는 것만 쓴다(✓·◉·▸는 없다).
 * 점선 원(◌)은 끝난 세션이다.
 */
export const SESSION_GLYPH: Record<ItemState, string> = {
  running: '●',
  pending: '◆',
  waiting: '◐',
  idle: '○',
  done: '◎',
  offline: '◌',
  todo: '○',
  unread: '●',
  read: '○',
};

export interface SessionsLayout {
  statusLeft: Box & { text: string };
  statusRight: Box & { text: string };
  divider: Box;
  footer: Box & { text: string };
  /** 세션이 있을 때. */
  list?: Box & { items: string[] };
  /** 세션이 있으면 상태별 개수, 없으면 안내. empty면 이 칸이 조작을 받는다. */
  card: Box & { text: string; capture: boolean };
}

const LIST_ITEM_PAD = 12;

export function layoutSessions(view: SessionsView): SessionsLayout {
  const rightW = 246;
  const base = {
    statusLeft: {
      x: 0, y: 0, w: SCREEN_W - rightW, h: 32, padding: 2, brightness: 4,
      text: view.title,
    },
    statusRight: {
      x: SCREEN_W - rightW, y: 0, w: rightW, h: 32, padding: 2, brightness: 2,
      text: alignRight(view.status, rightW - 4 - 6),
    },
    divider: { x: 6, y: 33, w: SCREEN_W - 12, h: 2, padding: 0, border: { width: 1, color: 5 } },
    footer: {
      x: 0, y: 256, w: SCREEN_W, h: 32, padding: 2, brightness: 1,
      text: spread(view.hint, view.rows.length ? view.total : '', SCREEN_W - 4 - 12),
    },
  };

  if (view.rows.length === 0) {
    const cardW = 420;
    const inset = 8 + 1;
    const inner = cardW - 2 * inset;
    return {
      ...base,
      footer: { ...base.footer, text: '●● 뒤로' },
      card: {
        x: (SCREEN_W - cardW) / 2, y: 70, w: cardW, h: 27 * 4 + 2 * inset,
        padding: 8, border: { width: 1, color: 6, radius: 10 }, brightness: 3,
        text: [
          center('◌', inner),
          center('연결된 세션이 없습니다', inner),
          '',
          center('맥에서 claude를 시작하면 여기 뜹니다', inner),
        ].join('\n'),
        // 목록이 없으니 이 칸이 조작(더블탭 뒤로)을 받는다.
        capture: true,
      },
    };
  }

  const listW = 360;
  const listPad = 4;
  const rowW = listW - 2 * listPad - 2 * LIST_ITEM_PAD - 12;
  const colX = listW + 6;
  const colW = SCREEN_W - colX - 6;
  const inset = 6 + 1;

  return {
    ...base,
    list: {
      // 5칸(200px) + 여백. 아래 안내 줄 자리를 남긴다.
      x: 0, y: 38, w: listW, h: listHeight(view.rows.length, 5, listPad), padding: listPad,
      items: view.rows.map((r) => spreadItem(`${SESSION_GLYPH[r.state]}  ${r.title}`, r.meta, rowW)),
    },
    card: {
      x: colX, y: 42, w: colW, h: 27 * view.counts.length + 2 * inset, padding: 6,
      border: { width: 1, color: 6, radius: 8 }, brightness: 3,
      text: view.counts
        .map((c) => spread(`${SESSION_GLYPH[c.state]}  ${c.label}`, String(c.count), colW - 2 * inset - 6))
        .join('\n'),
      capture: false,
    },
  };
}
