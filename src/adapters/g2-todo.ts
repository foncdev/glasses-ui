/**
 * G2 할 일 화면 배치. 홈·세션·알림·대화와 같은 규칙.
 *
 *   안 함 □   함 ▣
 * ▣은 폰트에 있고 체크한 칸처럼 보인다. 예전의 [x]·[ ]는 글자라 눈에
 * 덜 들어왔다.
 */
import type { ChecklistView } from '../core/glasses.js';
import { type Box, SCREEN_W, center, gauge, listHeight, spread, spreadItem } from './g2-home.js';
import { type StatusParts, type TextBox, boxHeight, footer, statusParts } from './g2-inbox.js';

export const TODO_GLYPH = { todo: '□', done: '▣' } as const;

const LIST_ITEM_PAD = 12;

export interface ChecklistLayout extends StatusParts {
  footer: TextBox;
  /** 할 일이 있을 때. */
  list?: Box & { items: string[] };
  /** 할 일이 있으면 진행 카드, 없으면 안내. 없을 때는 이 칸이 조작을 받는다. */
  card: TextBox & { capture: boolean };
}

export function layoutChecklist(view: ChecklistView): ChecklistLayout {
  const base = statusParts(view.title, view.status);

  if (view.items.length === 0) {
    const cardW = 420;
    const inner = cardW - 2 * (8 + 1);
    return {
      ...base,
      footer: footer('●● 뒤로', ''),
      card: {
        x: (SCREEN_W - cardW) / 2, y: 70, w: cardW, h: boxHeight(4, 8, 1),
        padding: 8, border: { width: 1, color: 6, radius: 10 }, brightness: 3,
        text: [
          center(TODO_GLYPH.todo, inner),
          center('할 일이 없습니다', inner),
          '',
          center('폰이나 웹에서 추가하면 여기 뜹니다', inner),
        ].join('\n'),
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
  const { done, total } = view.progress;
  const ratio = total > 0 ? done / total : 0;
  const card = [
    spread('진행', `${Math.round(ratio * 100)}%`, inner),
    gauge(ratio, 7),
    spread(`${TODO_GLYPH.todo}  남음`, String(total - done), inner),
    spread(`${TODO_GLYPH.done}  완료`, String(done), inner),
  ];
  const rows = [
    ...view.items.map((i) => spreadItem(`${i.done ? TODO_GLYPH.done : TODO_GLYPH.todo}  ${i.text}`, '', rowW)),
    ...(view.action ? [`»  ${view.action}`] : []),
  ];

  return {
    ...base,
    footer: footer(view.hint, view.note),
    list: { x: 0, y: 38, w: listW, h: listHeight(rows.length, 5, listPad), padding: listPad, items: rows },
    card: {
      x: colX, y: 42, w: colW, h: boxHeight(card.length, 6, 1), padding: 6,
      border: { width: 1, color: 6, radius: 8 }, brightness: 3,
      text: card.join('\n'),
      capture: false,
    },
  };
}
