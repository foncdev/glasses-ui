/**
 * G2 명령 화면 배치(명령 목록·실행 결과). 홈·세션·알림·대화·할 일·시스템과 같은 규칙.
 *
 *   직접 실행 ▷   예약 ∞   성공 ◎   실패 ◇   확인 필요 ▲   실행 중 ◐
 * 폰트에 ✓·↻·⏱·⚠가 없어서 있는 기호로 고른다.
 *
 * 목록은 스크롤해도 이벤트가 오지 않아 '고른 명령'의 자세한 내용을 옆에
 * 띄울 수 없다. 그래서 오른쪽 카드는 고른 것과 상관없는 요약(갈래별 수,
 * 마지막 실행)을 둔다.
 */
import { getTextWidth, pxTruncate } from '@evenrealities/pretext';
import type { CommandResultView, CommandsView } from '../core/glasses.js';
import { type Box, SCREEN_W, center, listHeight, spread, spreadItem } from './g2-home.js';
import { type StatusParts, type TextBox, boxHeight, footer, statusParts } from './g2-inbox.js';

export const CMD_GLYPH = { once: '▷', cron: '∞', ok: '◎', fail: '◇', confirm: '▲', running: '◐' } as const;

const LIST_ITEM_PAD = 12;

/** '90분', '2시간'처럼 짧게. */
export function every(minutes: number): string {
  return minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}시간` : `${minutes}분`;
}

/** 가운데 안내 카드. 목록이 없을 때와 실행 중일 때 쓴다. 조작을 받는다. */
function noticeCard(lines: string[], bright = false): TextBox {
  const cardW = 420;
  const inner = cardW - 2 * (8 + 1);
  return {
    x: (SCREEN_W - cardW) / 2, y: 70, w: cardW, h: boxHeight(lines.length, 8, 1),
    padding: 8, border: { width: 1, color: 6, radius: 10 }, brightness: bright ? 4 : 3,
    text: lines.map((l) => (l ? center(pxTruncate(l, inner - 6), inner) : '')).join('\n'),
  };
}

// --- 명령 목록 ---

export interface CommandsLayout extends StatusParts {
  footer: TextBox;
  /** 명령이 있을 때. */
  list?: Box & { items: string[] };
  /** 명령이 있으면 요약 카드, 없으면 안내. 없을 때는 이 칸이 조작을 받는다. */
  card: TextBox & { capture: boolean };
}

export function layoutCommands(view: CommandsView): CommandsLayout {
  const base = statusParts(view.title, view.status);

  if (view.rows.length === 0) {
    return {
      ...base,
      footer: footer('●● 뒤로', ''),
      card: {
        ...noticeCard([CMD_GLYPH.once, '등록한 명령이 없습니다', '', '폰이나 웹에서 등록하면 여기 뜹니다']),
        capture: true,
      },
    };
  }

  const listW = 390;
  const listPad = 4;
  const rowW = listW - 2 * listPad - 2 * LIST_ITEM_PAD - 12;
  const colX = listW + 6;
  const colW = SCREEN_W - colX - 6;
  const inner = colW - 2 * (6 + 1) - 6;
  const card = [
    spread(`${CMD_GLYPH.once}  직접`, String(view.counts.once), inner),
    spread(`${CMD_GLYPH.cron}  예약`, String(view.counts.cron), inner),
  ];
  if (view.last) {
    const ok = view.last.exitCode === 0;
    card.push(
      '',
      pxTruncate(view.last.label, inner),
      spread(`${ok ? CMD_GLYPH.ok : CMD_GLYPH.fail}  종료 ${view.last.exitCode}`, view.last.ago, inner),
    );
  }

  return {
    ...base,
    footer: footer(view.hint, view.note),
    list: {
      x: 0, y: 38, w: listW, h: listHeight(view.rows.length, 5, listPad), padding: listPad,
      items: view.rows.map((r) =>
        spreadItem(`${r.cron ? CMD_GLYPH.cron : CMD_GLYPH.once}  ${r.label}`, r.cron ? every(r.cron) : '', rowW),
      ),
    },
    card: {
      x: colX, y: 42, w: colW, h: boxHeight(card.length, 6, 1), padding: 6,
      border: { width: 1, color: 6, radius: 8 }, brightness: 3,
      text: card.join('\n'),
      capture: false,
    },
  };
}

// --- 실행 결과 ---

export interface CommandResultLayout extends StatusParts {
  footer: TextBox;
  /** 출력·안내·확인 카드. 목록이 없어 이 칸이 조작을 받는다. */
  card: TextBox;
}

/**
 * 결과 카드에 넣을 줄 수. 카드는 구분선 아래(42)부터 안내 줄 위(256)까지
 * 214px이라 일곱 줄이 든다. 넘치면 여섯 줄에 '… N줄 더'를 붙인다.
 */
const RESULT_ROWS = 7;

export function layoutCommandResult(view: CommandResultView): CommandResultLayout {
  const base = {
    ...statusParts(view.title, view.status),
    footer: footer(view.hint, view.note),
  };

  if (view.state === 'running') {
    return { ...base, card: noticeCard([CMD_GLYPH.running, '실행 중…', `$ ${view.command}`], true) };
  }

  const cardW = SCREEN_W - 12;

  if (view.state === 'confirm') {
    // 권한 요청처럼 가장 밝고 굵은 테두리로 눈에 띄게 한다.
    const pad = 10;
    const border = 2;
    const inner = cardW - 2 * (pad + border) - 6;
    const lines = [
      `${CMD_GLYPH.confirm}  되돌릴 수 없는 명령입니다`,
      pxTruncate(`$ ${view.command}`, inner),
      ...view.lines.slice(0, 3).map((l) => pxTruncate(`· ${l}`, inner)),
    ];
    return {
      ...base,
      card: {
        x: 6, y: 42, w: cardW, h: boxHeight(lines.length, pad, border),
        padding: pad, border: { width: border, color: 8, radius: 10 }, brightness: 4,
        text: lines.join('\n'),
      },
    };
  }

  // 출력은 폭을 모른다(ps는 전체 경로를 뱉는다). 기기 줄바꿈에 맡기면 몇 줄이
  // 될지 몰라 안내 줄이 밀리므로 줄마다 폭에 맞춰 자른다. 원래 줄바꿈은
  // 살린다 — 표 꼴 출력(ps·df)은 줄이 곧 뜻이다.
  const inner = cardW - 2 * (8 + 1) - 6;
  const all = view.lines.length ? view.lines : ['(출력 없음)'];
  const fitsAll = all.length <= RESULT_ROWS;
  const shown = all.slice(0, fitsAll ? RESULT_ROWS : RESULT_ROWS - 1);
  const body = shown.map((l) => pxTruncate(l.replace(/\t/g, '  '), inner) || ' ');
  if (!fitsAll) {
    const more = `… ${all.length - shown.length}줄 더 · 폰에서 보기`;
    body.push(' '.repeat(Math.max(0, Math.floor((inner - getTextWidth(more)) / getTextWidth(' ')))) + more);
  }
  const failed = view.state === 'failed';
  return {
    ...base,
    card: {
      x: 6, y: 42, w: cardW, h: boxHeight(body.length, 8, 1),
      padding: 8, border: { width: 1, color: failed ? 6 : 4, radius: 8 }, brightness: failed ? 3 : 2,
      text: body.join('\n'),
    },
  };
}
