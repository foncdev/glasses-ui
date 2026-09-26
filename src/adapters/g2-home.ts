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

const SCREEN_W = 576;
const SPACE = getTextWidth(' ');

/** 이 폭(px)에 맞춰 왼쪽 글과 오른쪽 글 사이를 공백으로 채운다. */
export function spread(left: string, right: string, width: number): string {
  if (!right) return pxTruncate(left, width);
  const r = pxTruncate(right, Math.floor(width / 3));
  const l = pxTruncate(left, width - getTextWidth(r) - SPACE);
  // 이어 붙이면 사이 커닝으로 1~2px이 더 나온다. 딱 맞추면 접히므로 여유를 둔다.
  const gap = width - getTextWidth(l) - getTextWidth(r) - 3;
  return l + ' '.repeat(Math.max(1, Math.floor(gap / SPACE))) + r;
}

function alignRight(text: string, width: number): string {
  const t = pxTruncate(text, width);
  return ' '.repeat(Math.max(0, Math.floor((width - getTextWidth(t)) / SPACE))) + t;
}

function center(text: string, width: number): string {
  return ' '.repeat(Math.max(0, Math.floor((width - getTextWidth(text)) / 2 / SPACE))) + text;
}

/** 막대 게이지. 이 폰트에 █·▒는 있고 ▓·░·▰는 없다. ━·─는 굵기가 같아 쓰지 않는다. */
export function gauge(ratio: number, cells: number): string {
  const n = Math.round(Math.min(Math.max(ratio, 0), 1) * cells);
  return '█'.repeat(n) + '▒'.repeat(cells - n);
}

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
      items: view.items.map((i) => spread(i.label, i.meta ?? '', itemTextW)),
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
