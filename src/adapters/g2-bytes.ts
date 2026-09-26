/**
 * G2 목록 한 칸의 바이트 한도.
 *
 * 목록 한 칸은 64자가 아니라 UTF-8 63바이트까지다. 시뮬레이터로 쟀다 —
 * ASCII 63자는 그려지고 64자는 목록 전체가 그려지지 않는다. 한글·기호는
 * 한 글자에 3바이트라 21자(63바이트)까지만 된다.
 *
 * 한 칸이라도 넘으면 rebuild가 실패해 화면이 그대로 멈춘다. SDK 검사는
 * 통과하므로 오류도 없이 조용히 멈춘다. 한글 제목이 긴 세션이나 알림
 * 하나로도 일어난다.
 */
export const ITEM_MAX_BYTES = 63;

const encoder = new TextEncoder();

export function utf8Bytes(s: string): number {
  return encoder.encode(s).length;
}

/** 바이트 한도에 맞춰 뒤를 자르고 …을 붙인다. 이미 맞으면 그대로 돌려준다. */
export function fitBytes(s: string, max = ITEM_MAX_BYTES): string {
  if (utf8Bytes(s) <= max) return s;
  const ellipsis = '…';
  const budget = max - utf8Bytes(ellipsis);
  let out = '';
  let used = 0;
  // 코드 포인트 단위로 센다. 서로게이트 쌍을 반으로 가르지 않게.
  for (const ch of s) {
    const n = utf8Bytes(ch);
    if (used + n > budget) break;
    out += ch;
    used += n;
  }
  return out.trimEnd() + ellipsis;
}
