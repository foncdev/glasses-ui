/**
 * G2 대화 화면 배치(대화 목록·진행 중 대화·권한 요청). 홈·세션·알림과 같은 규칙.
 *
 *   나 ▷   AI ◆   도구 └   오류 ◇   알림 ─
 * 폰트에 ❯·↳·⚙가 없어서 있는 기호로 고른다. 도는 기호도 ◐·◑ 둘뿐이다.
 */
import { pxTruncate } from '@evenrealities/pretext';
import type { HistoryView, LineKind, LiveView, PermissionView } from '../core/glasses.js';
import { type Box, SCREEN_W, listHeight, spread, spreadItem } from './g2-home.js';
import { SESSION_GLYPH } from './g2-sessions.js';
import { type StatusParts, type TextBox, boxHeight, footer, statusParts } from './g2-inbox.js';

export const LINE_GLYPH: Record<LineKind, string> = {
  me: '▷',
  ai: '◆',
  tool: '└',
  error: '◇',
  info: '─',
};

/** 도는 기호. ◓·◒는 이 폰트에 없다. */
const SPINNER = ['◐', '◑'];

const LIST_ITEM_PAD = 12;

// --- 대화 목록 ---

export interface HistoryLayout extends StatusParts {
  footer: TextBox;
  list: Box & { items: string[] };
  /** 세션 정보. */
  card: TextBox;
}

export function layoutHistory(view: HistoryView): HistoryLayout {
  const listW = 390;
  const listPad = 4;
  const rowW = listW - 2 * listPad - 2 * LIST_ITEM_PAD - 12;
  const colX = listW + 6;
  const colW = SCREEN_W - colX - 6;
  const inner = colW - 2 * (6 + 1) - 6;
  const info = [
    `${SESSION_GLYPH[view.info.state]}  ${view.info.label}`,
    ...view.info.rows.filter((r) => r.value).map((r) => spread(r.label, r.value, inner)),
  ];
  return {
    ...statusParts(view.title, view.status),
    footer: footer(view.hint, ''),
    list: {
      x: 0, y: 38, w: listW, h: listHeight(view.rows.length + 1, 5, listPad), padding: listPad,
      items: [
        ...view.rows.map((r) => spreadItem(`${LINE_GLYPH[r.kind]}  ${r.text}`, '', rowW)),
        `»  ${view.action}`,
      ],
    },
    card: {
      x: colX, y: 42, w: colW, h: boxHeight(info.length, 6, 1), padding: 6,
      border: { width: 1, color: 6, radius: 8 }, brightness: 3,
      text: info.join('\n'),
    },
  };
}

// --- 진행 중 대화 ---

export interface LiveLayout extends StatusParts {
  footer: TextBox;
  /** 최근에 오간 것. 한 단계 흐리게. 이 칸이 조작을 받는다. */
  log: TextBox;
  /** 지금 하는 일. 밝게, 도는 기호로. 쉴 때는 흐리게 쉬는 말을. */
  activity: TextBox;
}

export function layoutLive(view: LiveView): LiveLayout {
  const logW = SCREEN_W - 16;
  const logPad = 4;
  const lineW = logW - 2 * logPad - 6;
  const cardW = SCREEN_W - 12;
  const busy = Boolean(view.activity);
  return {
    ...statusParts(view.title, view.status),
    footer: footer(view.hint, view.meta),
    log: {
      x: 8, y: 40, w: logW, h: boxHeight(6, logPad), padding: logPad, brightness: 2,
      // 빈 글은 기기가 거부할 수 있어 공백 한 칸.
      text: view.lines.map((l) => pxTruncate(`${LINE_GLYPH[l.kind]} ${l.text}`, lineW)).join('\n') || ' ',
    },
    activity: {
      x: 6, y: 216, w: cardW, h: 36, padding: 3,
      border: { width: 1, color: busy ? 6 : 3, radius: 8 },
      brightness: busy ? 4 : 2,
      text: view.activity
        ? spread(
            `${SPINNER[view.activity.tick % SPINNER.length]}  ${view.activity.text}`,
            view.activity.elapsed,
            cardW - 2 * (3 + 1) - 12,
          )
        : `○  ${view.idle}`,
    },
  };
}

// --- 권한 요청 ---

export interface PermissionLayout extends StatusParts {
  /** 무엇을 하려는지. 가장 밝게, 굵은 테두리. */
  card: TextBox;
  /** 선택지. 거부가 맨 위. */
  list: Box & { items: string[] };
}

const CHOICE_GLYPH = { deny: '○', once: '●', always: '◎' } as const;

export function layoutPermission(view: PermissionView): PermissionLayout {
  const cardW = SCREEN_W - 12;
  const pad = 10;
  const border = 2;
  const inner = cardW - 2 * (pad + border) - 6;
  const cardH = boxHeight(2, pad, border);
  return {
    ...statusParts(view.title, view.status),
    card: {
      x: 6, y: 42, w: cardW, h: cardH, padding: pad,
      border: { width: border, color: 8, radius: 10 }, brightness: 4,
      text: [
        spread(`◆  ${view.tool}`, view.hint, inner - 12),
        pxTruncate(view.summary ? `$ ${view.summary}` : '(내용 없음)', inner - 6),
      ].join('\n'),
    },
    list: {
      x: 0, y: 42 + cardH + 6, w: SCREEN_W, h: view.choices.length * 40 + 8, padding: 4,
      items: view.choices.map((c) => `${CHOICE_GLYPH[c.kind]}  ${c.label}`),
    },
  };
}
