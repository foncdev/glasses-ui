/**
 * 테스트용 G2 렌더링.
 *
 * 본체는 뜻(Item)을 넘기고 글자는 어댑터가 만든다. 그런데 어댑터는
 * Even SDK를 import해서 node에서 그대로 부를 수 없다. 그래서 글자를 만드는
 * 규칙만 여기 옮겨 두고, 테스트는 이걸 거쳐 화면에 뜰 문자열을 본다.
 *
 * 복사본이 낡으면 의미가 없으므로, render-snapshot 테스트가 g2.ts의 MARK 표를
 * 직접 읽어 아래와 같은지 검사한다.
 */
import { clampWidth, displayWidth, toItem, type ItemLike, type ItemState } from '../src/core/glasses.js';

/** G2 목록 한 줄의 칸 수. 어댑터의 caps.cols와 같아야 한다. */
export const COLS = 64;

export const MARK: Record<ItemState, string> = {
  done: '*',
  todo: '[ ]',
  running: '>',
  waiting: '!',
  pending: '!',
  offline: '·',
  idle: '○',
  unread: '*',
  read: '-',
};

/** 항목을 G2 화면에 뜨는 글자로 바꾼다. */
export function asText(items: readonly ItemLike[], cols: number = COLS): string[] {
  const parsed = items.map(toItem);
  const isChecklist = parsed.some((i) => i.state === 'todo');

  return parsed.map((i) => {
    if (!i.state) return clampWidth(i.text, cols);
    const mark = isChecklist && i.state === 'done' ? '[x]' : MARK[i.state];
    const prefix = `${mark} `;
    return prefix + clampWidth(i.text, cols - displayWidth(prefix));
  });
}
