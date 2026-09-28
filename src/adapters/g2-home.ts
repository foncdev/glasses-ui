/**
 * G2 홈 화면 배치. 컨테이너 위치와 글자만 정하고, 그리는 일은 g2-display가 한다.
 *
 * 576×288 한 화면을 이렇게 나눈다.
 *
 *   ┌ 상태 표시줄: 제목(밝게) ·························· 상태(흐리게) ┐
 *   ├──────────────────────────── 구분선 ─────────────────────────────┤
 *   │ 메뉴 (오른쪽에 숫자)           │ ╭ 로고 카드 ─────────────╮      │
 *   │                                │ ╰────────────────────────╯      │
 *   │                                │ cpu ████▒▒▒▒         42%        │
 *   └────────────────────────────────┴─────────────────────────────────┘
 *
 * 폰트가 고정폭이 아니라 공백 개수로는 열이 맞지 않는다. 글자 폭을 픽셀로
 * 재서(@evenrealities/pretext) 공백을 채운다. 폭은 펌웨어 폰트와 같다.
 *
 * 크기는 시뮬레이터로 맞춘 값이다. 줄 높이는 27px, 목록 한 칸은 40px라
 * 메뉴 6칸(240px)과 상태 표시줄이 288px에 겨우 들어간다.
 */
import { getTextWidth, pxTruncate } from '@evenrealities/pretext';
import type { HomeView } from '../core/glasses.js';
import { ITEM_MAX_BYTES, utf8Bytes } from './g2-bytes.js';

export const SCREEN_W = 576;
const SPACE = getTextWidth(' ');
/**
 * 넓은 공백(U+3000, 20px·3바이트). 보통 공백은 5px·1바이트라, 같은 폭을
 * 채우는 데 바이트가 더 든다. 목록 한 칸은 63바이트뿐이라 넓은 공백부터 쓴다.
 */
const WIDE = '\u3000';
const WIDE_W = getTextWidth(WIDE);

/** gap(px)을 넓은 공백과 보통 공백으로 채운다. */
function fill(gap: number): string {
  const wide = Math.max(0, Math.floor(gap / WIDE_W));
  return WIDE.repeat(wide) + ' '.repeat(Math.max(1, Math.floor((gap - wide * WIDE_W) / SPACE)));
}

/** 이 폭(px)에 맞춰 왼쪽 글과 오른쪽 글 사이를 공백으로 채운다. */
export function spread(left: string, right: string, width: number): string {
  if (!right) return pxTruncate(left, width);
  // 오른쪽 값은 왼쪽 글이 쓰고 남은 만큼 쓴다. 폭의 일부로 못 박으면 짧은
  // 라벨 옆의 긴 값(폴더 이름)이 쓸데없이 잘렸다.
  const r = pxTruncate(right, Math.max(Math.floor(width / 2.5), width - getTextWidth(left) - 3 * SPACE));
  const l = pxTruncate(left, width - getTextWidth(r) - SPACE);
  // 이어 붙이면 사이 커닝으로 1~2px이 더 나온다. 딱 맞추면 접히므로 여유를 둔다.
  return l + fill(width - getTextWidth(l) - getTextWidth(r) - 3) + r;
}

/**
 * 목록 한 칸용 spread. 63바이트를 넘으면 왼쪽 글을 줄여 맞춘다.
 *
 * 한글 제목은 한 글자 3바이트라, 긴 제목에 오른쪽 정렬 공백까지 넣으면
 * 한도를 넘는다. 넘치면 목록 전체가 그려지지 않는다(g2-bytes 참고).
 */
export function spreadItem(left: string, right: string, width: number): string {
  let w = width;
  for (;;) {
    const row = spread(pxTruncate(left, w), right, width);
    if (utf8Bytes(row) <= ITEM_MAX_BYTES || w <= 20) return row;
    w -= 10;
  }
}

export function alignRight(text: string, width: number): string {
  const t = pxTruncate(fitStatus(text, width), width);
  return ' '.repeat(Math.max(0, Math.floor((width - getTextWidth(t)) / SPACE))) + t;
}

/**
 * 상태 표시줄 글을 칸에 맞춘다. 넘치면 왼쪽 항목부터 뺀다.
 *
 * 항목은 빈칸 두 개 이상으로 나뉘고 맨 끝이 시각이다. 예전에는 끝을 잘라
 * 가장 중요한 시각이 먼저 사라졌다(작업 중 세션·타이머·물이 함께 있을 때).
 * 그래서 덜 중요한 것을 왼쪽에 둔다. 마지막 항목은 빼지 않는다.
 */
export function fitStatus(text: string, width: number): string {
  if (getTextWidth(text) <= width) return text;
  const parts = text.split(/( {2,})/);
  // parts = [항목, 빈칸, 항목, 빈칸, …, 항목]. 앞에서 항목과 뒤따르는 빈칸을 함께 뺀다.
  while (parts.length > 1) {
    parts.splice(0, 2);
    const next = parts.join('');
    if (getTextWidth(next) <= width) return next;
  }
  return parts.join('');
}

export function center(text: string, width: number): string {
  return ' '.repeat(Math.max(0, Math.floor((width - getTextWidth(text)) / 2 / SPACE))) + text;
}

/** 막대 게이지. 이 폰트에 █·▒는 있고 ▓·░·▰는 없다. ━·─는 굵기가 같아 쓰지 않는다. */
export function gauge(ratio: number, cells: number): string {
  const n = Math.round(Math.min(Math.max(ratio, 0), 1) * cells);
  return '█'.repeat(n) + '▒'.repeat(cells - n);
}

/**
 * 상단 진행바(폰의 타이머). 지나간 만큼 굵은 선(━), 남은 만큼 가는 선(─).
 *
 * 원래 선은 높이 2짜리 칸의 테두리다. 칸의 크기는 다시 세우지 않고는 못
 * 바꾸므로(목록 선택이 풀린다) 진행바는 글자로 그리고 글자만 고친다.
 * 두 선은 폭이 같아(20px) 칸 수가 늘 같다.
 */
export const TOP_BAR_W = SCREEN_W - 12;

export function progressLine(ratio: number, width = TOP_BAR_W): string {
  const cell = Math.max(getTextWidth('━'), getTextWidth('─'));
  const cells = Math.floor(width / cell);
  const n = Math.round(Math.min(Math.max(ratio, 0), 1) * cells);
  return '━'.repeat(n) + '─'.repeat(cells - n);
}

/**
 * 진행바 칸. 글자 한 줄(27px)의 가운데가 원래 선 자리(y=33)에 오게 둔다.
 * 위아래 칸(상태줄·목록)과 겹치지만 칸에는 바탕이 없어 글자끼리만 안 닿으면 된다.
 */
export const TOP_BAR_BOX: Box = { x: 6, y: 20, w: TOP_BAR_W, h: 27, padding: 0, brightness: 3 };

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  padding: number;
  border?: { width: number; color: number; radius?: number };
  /** 글자 밝기 0~4. */
  brightness?: number;
}

export interface HomeLayout {
  statusLeft: Box & { text: string };
  statusRight: Box & { text: string };
  divider: Box;
  list: Box & { items: string[] };
  card?: Box & { text: string };
  stats?: Box & { text: string };
}

/**
 * 목록 높이. 보이는 줄 수만큼만 잡는다.
 *
 * 항목이 높이보다 적으면 펌웨어가 목록을 세로 가운데로 내려 그린다.
 * 3줄짜리 대화 목록이 한 줄 아래에서 시작해 맨 위가 비어 보였다.
 */
export function listHeight(items: number, maxRows: number, padding: number): number {
  return Math.max(1, Math.min(items, maxRows)) * 40 + 2 * padding;
}

/** 목록 칸의 좌우 여백. 펌웨어가 칸마다 12px씩 둔다. */
const LIST_ITEM_PAD = 12;

export function layoutHome(view: HomeView): HomeLayout {
  const listW = 282;
  const listPad = 4;
  // 선택 테두리와 반올림 몫으로 12px을 더 뺀다. 딱 맞추면 넘친다.
  const itemTextW = listW - 2 * listPad - 2 * LIST_ITEM_PAD - 12;

  const rightW = 246;
  const layout: HomeLayout = {
    statusLeft: {
      x: 0, y: 0, w: SCREEN_W - rightW, h: 32, padding: 2, brightness: 4,
      text: pxTruncate(view.title, SCREEN_W - rightW - 4),
    },
    statusRight: {
      x: SCREEN_W - rightW, y: 0, w: rightW, h: 32, padding: 2, brightness: 2,
      text: alignRight(view.status, rightW - 4 - 6),
    },
    // 높이 2짜리 칸의 테두리를 가로선으로 쓴다.
    divider: { x: 6, y: 33, w: SCREEN_W - 12, h: 2, padding: 0, border: { width: 1, color: 5 } },
    list: {
      x: 0, y: 38, w: listW, h: 248, padding: listPad,
      items: view.items.map((i) => spreadItem(i.label, i.meta ?? '', itemTextW)),
    },
  };

  const colX = listW + 6;
  const colW = SCREEN_W - colX;

  if (view.logo?.length) {
    // 로고 한 줄이 280px다. 안쪽 폭이 그보다 좁으면 접혀서 깨진다.
    const inset = 2 + 1;
    layout.card = {
      x: colX, y: 42, w: colW, h: view.logo.length * 27 + 2 * inset, padding: 2,
      border: { width: 1, color: 6, radius: 8 },
      brightness: 3,
      text: view.logo.map((l) => center(l, colW - 2 * inset)).join('\n'),
    };
  }

  if (view.gauges?.length) {
    const lines = view.gauges.slice(0, 2);
    // 라벨 폭이 제각각이라 막대 시작점이 어긋난다. 가장 넓은 라벨에 맞춘다.
    const labelW = Math.max(...lines.map((g) => getTextWidth(g.label))) + 2 * SPACE;
    const pad = (s: string) => s + ' '.repeat(Math.max(1, Math.round((labelW - getTextWidth(s)) / SPACE)));
    layout.stats = {
      x: colX, y: 218, w: colW, h: 27 * lines.length + 8, padding: 4, brightness: 2,
      text: lines.map((g) => spread(pad(g.label) + gauge(g.ratio, 8), g.text, colW - 8 - 12)).join('\n'),
    };
  }

  return layout;
}
