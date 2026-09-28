/**
 * G2 시스템 화면 배치. 홈·세션·알림·대화·할 일과 같은 규칙.
 *
 *   ┌ $ ~/sys ······································ 읽음 14:05 ┐
 *   ├──────────────────────────── 구분선 ─────────────────────────┤
 *   │ ╭ cpu  ██▒▒▒▒▒     15% ╮  ╭ 프로세스             CPU ╮     │
 *   │ │ mem  ███▒▒▒▒     50% │  │ WindowServer        12.4% │     │
 *   │ │ load  2.3  2.6  2.4  │  │ Google Chrome H…     8.1% │     │
 *   │ │ up      16일 6시간   │  │ node                 6.3% │     │
 *   │ ╰ mem   31.9 / 64 GB   ╯  ╰ claude               4.8% ╯     │
 *   │ ● 새로 읽기    ●● 뒤로 ······························ host │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * 고르는 것이 없어 목록을 쓰지 않는다. 왼쪽 카드가 조작(탭·더블탭)을 받는다.
 * 숫자가 쉬지 않고 흔들리지 않게 스스로 갱신하지 않고, 탭하면 다시 읽는다.
 */
import { getTextWidth, pxTruncate } from '@evenrealities/pretext';
import type { SystemView } from '../core/glasses.js';
import { msg } from '../core/i18n.js';
import { SCREEN_W, center, gauge, spread } from './g2-home.js';
import { type StatusParts, type TextBox, boxHeight, footer, statusParts } from './g2-inbox.js';

/** 오른쪽 카드에 보일 프로세스 수. 왼쪽 카드와 줄 수를 맞춘다. */
const PROC_ROWS = 4;

const SPACE = getTextWidth(' ');

/**
 * 글을 이 폭(px)까지 공백으로 늘린다.
 *
 * 글꼴이 고정폭이 아니라 'cpu'와 'mem'의 폭이 달라, 뒤에 붙는 막대가
 * 서로 다른 자리에서 시작했다. 공백 폭(5px) 단위로 가장 가깝게 맞춘다.
 */
function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(1, Math.round((width - getTextWidth(text)) / SPACE)));
}

export interface SystemLayout extends StatusParts {
  footer: TextBox;
  /** 계기판. 조작을 받는다. 값을 못 읽었으면 안내가 들어간다. */
  gauges: TextBox;
  /** CPU를 많이 쓰는 프로세스. 못 읽었으면 없다. */
  procs?: TextBox;
}

export function layoutSystem(view: SystemView): SystemLayout {
  const base = {
    ...statusParts(view.title, view.status),
    footer: footer(view.hint, view.note),
  };

  const s = view.summary;
  if (!s) {
    const cardW = 420;
    const inner = cardW - 2 * (8 + 1);
    return {
      ...base,
      gauges: {
        x: (SCREEN_W - cardW) / 2, y: 70, w: cardW, h: boxHeight(3, 8, 1),
        padding: 8, border: { width: 1, color: 6, radius: 10 }, brightness: 3,
        text: [
          center('◌', inner),
          center(view.notice ?? msg().reading, inner),
          center(msg().runTerminalAgent, inner),
        ].join('\n'),
      },
    };
  }

  const leftW = 282;
  const leftInner = leftW - 2 * (8 + 1) - 6;
  const cpu = s.cpu === null ? null : s.cpu / 100;
  const mem = s.mem && s.mem.total > 0 ? s.mem.used / s.mem.total : null;
  const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`);
  // 막대가 같은 자리에서 시작하도록 이름 칸 폭을 맞춘다.
  const labelW = Math.max(getTextWidth('cpu'), getTextWidth('mem')) + 2 * SPACE;
  const left = [
    spread(`${padTo('cpu', labelW)}${gauge(cpu ?? 0, 7)}`, pct(cpu), leftInner),
    spread(`${padTo('mem', labelW)}${gauge(mem ?? 0, 7)}`, pct(mem), leftInner),
    spread('load', s.load.length ? s.load.slice(0, 3).map((l) => l.toFixed(1)).join('  ') : '—', leftInner),
    spread('up', s.uptime || '—', leftInner),
    spread('mem', s.mem ? `${s.mem.used.toFixed(1)} / ${Math.round(s.mem.total)} GB` : '—', leftInner),
  ];

  const rightX = 6 + leftW + 6;
  const rightW = SCREEN_W - rightX - 6;
  const rightInner = rightW - 2 * (8 + 1) - 6;
  const rows = view.procs.slice(0, PROC_ROWS).map((p) => {
    const value = p.cpu === null ? '—' : `${p.cpu.toFixed(1)}%`;
    // 사용률 자리를 먼저 빼고 이름을 자른다. 이름을 먼저 자르면 긴 이름에서 숫자가 밀린다.
    return spread(pxTruncate(p.name, rightInner - 64), value, rightInner);
  });
  const right = [
    spread(msg().procHeader, 'CPU', rightInner),
    ...(rows.length ? rows : [msg().readFailed]),
  ];

  return {
    ...base,
    gauges: {
      x: 6, y: 42, w: leftW, h: boxHeight(left.length, 8, 1),
      padding: 8, border: { width: 1, color: 6, radius: 8 }, brightness: 4,
      text: left.join('\n'),
    },
    procs: {
      x: rightX, y: 42, w: rightW, h: boxHeight(right.length, 8, 1),
      padding: 8, border: { width: 1, color: 4, radius: 8 }, brightness: 2,
      text: right.join('\n'),
    },
  };
}
