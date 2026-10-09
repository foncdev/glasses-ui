/**
 * Claude의 답을 안경에서 끝까지 읽게 하는 일.
 *
 * 대화 화면은 답의 첫 줄만 보여 준다(진행 상황이 묻히지 않게). 끝까지 볼 때는 이 쪽 나누기로
 * 한 장씩 넘긴다. 마크다운 기호는 안경에서 그대로 보이므로 걷어낸다.
 *
 * /usage는 한도 줄을 읽어 막대 카드로 바꾼다. CLI 문구가 바뀌어 읽지 못하면 null — 그때는
 * 일반 결과처럼 보인다.
 */
import { wrapLines } from './mac.js';
import { displayWidth } from './glasses.js';

/** 마크다운 기호를 걷어 안경에서 읽을 글로 바꾼다. */
export function plainText(md: string): string {
  const out: string[] = [];
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    let line = raw.replace(/\s+$/, '');
    // 코드 울타리와 표 구분선은 버린다.
    if (/^\s*(```|~~~)/.test(line)) continue;
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue;
    // 표의 칸 구분은 띄어쓰기 둘로.
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).join('  ');
    line = line
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^(\s*)[-*+]\s+/, '$1· ')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
    out.push(line);
  }
  // 빈 줄은 하나만 남긴다.
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 글을 폭에 맞춰 접고 rows줄씩 쪽으로 나눈다. 빈 글이면 빈 쪽 하나. */
export function paginate(text: string, cols: number, rows: number): string[][] {
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) {
      // 쪽 첫 줄이 빈 줄이면 버린다.
      if (lines.length % rows !== 0) lines.push('');
      continue;
    }
    lines.push(...wrapLines(para, cols, Number.MAX_SAFE_INTEGER));
  }
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += rows) pages.push(lines.slice(i, i + rows));
  return pages.length > 0 ? pages : [[]];
}

export interface UsageLimit {
  /** session · week · 그 밖(모델 이름 등은 label에) */
  kind: 'session' | 'week' | 'model';
  label: string;
  percent: number;
  /** 초기화 시각(CLI 글 그대로, 예: "Oct 9 at 7pm") */
  resets: string;
}

export interface Usage {
  subscription: boolean;
  limits: UsageLimit[];
  /** 한도 줄 뒤의 사용 분석(영어 그대로) */
  details: string;
}

/** /usage 결과를 읽는다. 한도 줄이 하나도 없으면 null. */
export function parseUsage(text: string): Usage | null {
  const limits: UsageLimit[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let last = -1;
  lines.forEach((line, i) => {
    const m = /^\s*Current (session|week)(?: \(([^)]+)\))?:\s*(\d+(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.+?))?(?:\s*\([^)]*\))?\s*$/.exec(line);
    if (!m) return;
    const scope = m[1];
    const which = m[2];
    const kind: UsageLimit['kind'] = scope === 'session' ? 'session' : !which || /all models/i.test(which) ? 'week' : 'model';
    limits.push({ kind, label: kind === 'model' ? which! : '', percent: Number(m[3]), resets: (m[4] ?? '').trim() });
    last = i;
  });
  if (limits.length === 0) return null;
  return {
    subscription: /subscription/i.test(text),
    limits,
    details: lines.slice(last + 1).join('\n').trim(),
  };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * "Oct 9 at 7pm" → 오늘이면 "19:00", 아니면 "10/15 02:00". 읽지 못하면 그대로.
 * CLI가 이미 이 기기의 시간대로 적어 주므로 시간대는 바꾸지 않는다.
 */
export function shortReset(resets: string, now: Date): string {
  const m = /^([A-Za-z]{3})[a-z]*\s+(\d{1,2})(?:\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm))?/i.exec(resets.trim());
  if (!m) return resets;
  const month = MONTHS.indexOf(m[1]!.toLowerCase()) + 1;
  if (month === 0) return resets;
  const day = Number(m[2]);
  let hour = m[3] ? Number(m[3]) % 12 : 0;
  if (m[5]?.toLowerCase() === 'pm') hour += 12;
  const time = m[3] ? `${String(hour).padStart(2, '0')}:${m[4] ?? '00'}` : '';
  const today = now.getMonth() + 1 === month && now.getDate() === day;
  return today && time ? time : `${month}/${day}${time ? ` ${time}` : ''}`;
}

/** 칸 수만큼의 막대. 홈 게이지와 같은 기호(━ 찬 칸, ─ 빈 칸). */
export function usageBar(percent: number, cells: number): string {
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
  return '━'.repeat(filled) + '─'.repeat(cells - filled);
}

/** 이름 칸을 폭에 맞춰 채운다(한글은 두 칸). */
export function padWidth(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)));
}
