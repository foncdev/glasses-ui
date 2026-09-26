/**
 * G2 알림 화면 배치(목록·내용·새 알림 팝업). 홈·세션과 같은 규칙을 쓴다.
 *
 * 모양은 갈래, 채움은 안 읽음이다.
 *   완료 ●/○   오류 ◆/◇   권한 ◐/◑   정보 ■/□
 * 목록 칸에는 밝기를 따로 줄 수 없어서 안 읽은 것을 채움으로 가른다.
 */
import { getTextWidth, pxTruncate } from '@evenrealities/pretext';
import type {
  NoticeKind,
  NoticeView,
  NotificationView,
  NotificationsView,
} from '../core/glasses.js';
import { type Box, SCREEN_W, alignRight, center, listHeight, spread, spreadItem } from './g2-home.js';

export const NOTICE_SHAPE: Record<NoticeKind, readonly [unread: string, read: string]> = {
  done: ['●', '○'],
  error: ['◆', '◇'],
  permission: ['◐', '◑'],
  info: ['■', '□'],
};

const LINE = 27;

/**
 * 줄 수에 맞는 칸 높이.
 *
 * 안쪽 높이(높이 - 2×(여백 + 테두리))가 줄 수 × 27보다 작으면 스크롤바가
 * 생긴다. 시안에서 2px 모자라 실제로 생겼다. 반올림 몫으로 2px을 더 둔다.
 */
export function boxHeight(lines: number, padding: number, border = 0): number {
  return lines * LINE + 2 * (padding + border) + 2;
}

/**
 * 글을 폭에 맞춰 낱말 단위로 줄을 나눈다. rows를 넘으면 마지막 줄을 …로 끝낸다.
 *
 * 기기에 맡기면 낱말 한가운데서 끊긴다(DOCKERHUB_ / TOKEN). 몇 줄이 될지도
 * 몰라 아래 안내가 밀린다.
 */
export function wrapText(text: string, width: number, rows: number): string[] {
  const lines: string[] = [];
  for (const para of text.replace(/\r/g, '').split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (getTextWidth(next) <= width || !line.trim()) {
        line = next;
        continue;
      }
      lines.push(line.trimEnd());
      line = word.trimStart();
    }
    lines.push(line.trimEnd());
  }
  // 한 낱말이 폭보다 길면 그 줄만 자른다.
  const fitted = lines.map((l) => (getTextWidth(l) > width ? pxTruncate(l, width) : l));
  while (fitted.length > 0 && fitted.at(-1) === '') fitted.pop();
  if (fitted.length <= rows) return fitted;
  // 잘리는 자리가 빈 줄이면 …이 홀로 남는다. relay 훅이 본문 끝에 빈 줄과
  // '— 보낸 곳'을 붙여서 실제로 그랬다. 빈 줄을 걷고 글이 있는 줄에 붙인다.
  const cut = fitted.slice(0, rows);
  while (cut.length > 1 && cut.at(-1)!.trim() === '') cut.pop();
  cut[cut.length - 1] = pxTruncate(`${cut.at(-1)} …`, width);
  return cut;
}

export type TextBox = Box & { text: string };

export interface StatusParts {
  statusLeft: TextBox;
  statusRight: TextBox;
  divider: Box;
}

export function statusParts(title: string, status: string): StatusParts {
  const rightW = 246;
  return {
    statusLeft: { x: 0, y: 0, w: SCREEN_W - rightW, h: 32, padding: 2, brightness: 4, text: title },
    statusRight: {
      x: SCREEN_W - rightW, y: 0, w: rightW, h: 32, padding: 2, brightness: 2,
      text: alignRight(status, rightW - 4 - 6),
    },
    divider: { x: 6, y: 33, w: SCREEN_W - 12, h: 2, padding: 0, border: { width: 1, color: 5 } },
  };
}

export function footer(left: string, right: string): TextBox {
  return {
    x: 0, y: 256, w: SCREEN_W, h: 32, padding: 2, brightness: 1,
    text: spread(left, right, SCREEN_W - 4 - 12),
  };
}

// --- 목록 ---

export interface NotificationsLayout extends StatusParts {
  footer: TextBox;
  list?: Box & { items: string[] };
  /** 알림이 있으면 갈래별 개수, 없으면 안내. 없을 때는 이 칸이 조작을 받는다. */
  card: TextBox & { capture: boolean };
}

const LIST_ITEM_PAD = 12;

export function layoutNotifications(view: NotificationsView): NotificationsLayout {
  const base = statusParts(view.title, view.status);

  if (view.rows.length === 0) {
    const cardW = 420;
    const inset = 8 + 1;
    const inner = cardW - 2 * inset;
    return {
      ...base,
      footer: footer('●● 뒤로', ''),
      card: {
        x: (SCREEN_W - cardW) / 2, y: 70, w: cardW, h: boxHeight(4, 8, 1),
        padding: 8, border: { width: 1, color: 6, radius: 10 }, brightness: 3,
        text: [
          center('○', inner),
          center('알림이 없습니다', inner),
          '',
          center('새 알림은 여기와 홈에 뜹니다', inner),
        ].join('\n'),
        capture: true,
      },
    };
  }

  const listW = 360;
  const listPad = 4;
  const rowW = listW - 2 * listPad - 2 * LIST_ITEM_PAD - 12;
  const colX = listW + 6;
  const colW = SCREEN_W - colX - 6;
  const inner = colW - 2 * (6 + 1) - 6;
  const card = [
    spread('새 알림', String(view.unread), inner),
    ...view.counts.map((c) => spread(`${NOTICE_SHAPE[c.kind][0]}  ${c.label}`, String(c.count), inner)),
  ];

  return {
    ...base,
    footer: footer(view.hint, view.legend),
    list: {
      x: 0, y: 38, w: listW, h: listHeight(view.rows.length + (view.action ? 1 : 0), 5, listPad), padding: listPad,
      items: [
        ...view.rows.map((r) =>
          spreadItem(`${NOTICE_SHAPE[r.kind][r.read ? 1 : 0]}  ${r.title}`, r.meta, rowW),
        ),
        ...(view.action ? [`»  ${view.action}`] : []),
      ],
    },
    card: {
      x: colX, y: 42, w: colW, h: boxHeight(card.length, 6, 1), padding: 6,
      border: { width: 1, color: 6, radius: 8 }, brightness: 3,
      text: card.join('\n'),
      capture: false,
    },
  };
}

// --- 내용 ---

export interface NotificationLayout extends StatusParts {
  footer: TextBox;
  /** 갈래와 제목. 밝게. */
  head: TextBox;
  /** 본문. 한 단계 흐리게. 이 칸이 조작을 받는다. */
  body: TextBox;
}

export function layoutNotification(view: NotificationView): NotificationLayout {
  const base = statusParts(view.title, view.status);
  const cardX = 6;
  const cardW = SCREEN_W - 12;
  const headInset = 10 + 1;
  const bodyW = cardW - 16;
  const bodyPad = 4;
  return {
    ...base,
    footer: footer(view.hint, ''),
    head: {
      x: cardX, y: 42, w: cardW, h: boxHeight(2, 10, 1), padding: 10,
      border: { width: 1, color: 6, radius: 10 }, brightness: 4,
      text: [
        `${NOTICE_SHAPE[view.kind][0]}  ${view.label}`,
        pxTruncate(view.heading, cardW - 2 * headInset - 6),
      ].join('\n'),
    },
    body: {
      x: cardX + 8, y: 42 + boxHeight(2, 10, 1) + 4, w: bodyW, h: boxHeight(4, bodyPad), padding: bodyPad,
      brightness: 2,
      text: wrapText(view.body, bodyW - 2 * bodyPad - 6, 4).join('\n'),
    },
  };
}

// --- 새 알림 팝업 ---

export interface NoticeLayout {
  /** 갈래·제목 카드. 토스트처럼 가운데에. */
  card: TextBox;
  /** 본문. 조작(탭으로 닫기)을 받는다. */
  body: TextBox;
  /** 닫히는 때. 가장 흐리게. */
  hint: TextBox;
}

export function layoutNotice(view: NoticeView): NoticeLayout {
  const cardW = 480;
  const cardX = (SCREEN_W - cardW) / 2;
  const pad = 12;
  const border = 2;
  const inner = cardW - 2 * (pad + border);
  const cardH = boxHeight(2, pad, border);
  const bodyW = cardW - 28;
  const bodyPad = 4;
  return {
    card: {
      x: cardX, y: 30, w: cardW, h: cardH, padding: pad,
      border: { width: border, color: 8, radius: 12 }, brightness: 4,
      text: [
        // 딱 맞추면 반올림으로 넘쳐 스크롤바가 생긴다. 여유를 둔다.
        spread(`${NOTICE_SHAPE[view.kind][0]}  ${view.label}`, '새 알림', inner - 24),
        pxTruncate(view.title || view.body, inner - 12),
      ].join('\n'),
    },
    body: {
      x: cardX + 14, y: 30 + cardH + 4, w: bodyW, h: boxHeight(3, bodyPad), padding: bodyPad,
      brightness: 2,
      // 본문이 없으면 비워 둔다. 빈 글은 기기가 거부할 수 있어 공백 한 칸.
      text: view.title && view.body ? wrapText(view.body, bodyW - 2 * bodyPad - 6, 3).join('\n') : ' ',
    },
    hint: {
      x: 0, y: 256, w: SCREEN_W, h: 32, padding: 2, brightness: 1,
      text: center(view.closeHint, SCREEN_W - 16),
    },
  };
}
