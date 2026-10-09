/**
 * G2 모니터링 화면 배치. 홈·시스템·명령과 같은 규칙.
 *
 *   그룹 목록·대상 목록
 *   ┌ $ ~/mon ······································ 12:03 기준 ┐
 *   ├──────────────────────────── 구분선 ─────────────────────────┤
 *   │ ■  web                  DOWN 1 │ ╭ ■ 문제          1 ╮       │
 *   │ ▲  쇼핑몰               주의 1 │ │ ▲ 주의          2 │       │
 *   │ ●  staging              정상 2 │ │ ● 정상          5 │       │
 *   │                                │ │ 서비스      13/14 │       │
 *   │                                │ ╰ CPU          89% ╯       │
 *   │ ● 열기    ●● 뒤로 ·································· demo │
 *
 *   대상 한 장
 *   ┌ ■ web-03 ································ web · DOWN · 12:03 ┐
 *   │ ╭ CPU      ████████████▒▒▒▒                    89%  ▲ ╮ │
 *   │ │ 디스크   ███████▒▒▒▒▒▒▒▒▒                    44%    │ │
 *   │ │ 주문                                        1,248건   │ │
 *   │ ╰ 서비스   ■ worker　● api　● nginx                    ╯ │
 *   │ ● 새로 읽기  ▲▼ 다른 대상  ●● 뒤로 ······················ 1/4 │
 *
 * 목록은 스크롤해도 이벤트가 오지 않아 오른쪽 카드가 고른 줄을 따라갈 수 없다.
 * 카드는 보고 있는 범위(전체·그룹)의 요약이다. 카드 글은 제자리에서 고친다(live) —
 * 값이 바뀔 때마다 화면을 다시 세우면 목록 선택이 첫 줄로 돌아간다.
 *
 * ━·─는 굵기가 같아 막대로 읽히지 않는다. 시스템 화면처럼 █·▒로 그린다.
 */
import { getTextWidth, pxTruncate } from '@evenrealities/pretext';
import type { MonitorItemView, MonitorLevel, MonitorListView } from '../core/glasses.js';
import { msg } from '../core/i18n.js';
import { type Box, SCREEN_W, center, gauge, listHeight, spread, spreadItem } from './g2-home.js';
import { type StatusParts, type TextBox, boxHeight, footer, statusParts } from './g2-inbox.js';

/** ✕는 글꼴에 없다. */
export const MON_GLYPH: Record<MonitorLevel, string> = { down: '■', crit: '■', warn: '▲', ok: '●', unknown: '○' };

const SPACE = getTextWidth(' ');
/** 기호와 이름 사이. 보통 공백 하나(5px). 기기에서 20px은 너무 벌어지고 10px도 넓어 보였다. */
const GAP = ' ';
/** 서비스끼리(20px). 기호·이름 사이보다 넓어야 어느 기호가 어느 이름 것인지 읽힌다. */
const SEP = '\u3000';
const LIST_ITEM_PAD = 12;
/** 구분선 아래(42)부터 안내 줄 위(256)까지 든다. */
const CARD_ROWS = 7;
const GAUGE_CELLS = 12;
/** 상태 표시줄 왼쪽 칸 안 폭(statusParts). 그룹·서버 이름이 길면 자른다. */
const TITLE_W = SCREEN_W - 246 - 4 - 6;

function padTo(text: string, width: number): string {
  return text + ' '.repeat(Math.max(1, Math.round((width - getTextWidth(text)) / SPACE)));
}

function noticeCard(lines: string[]): TextBox {
  const cardW = 420;
  const inner = cardW - 2 * (8 + 1);
  return {
    x: (SCREEN_W - cardW) / 2, y: 70, w: cardW, h: boxHeight(lines.length, 8, 1),
    padding: 8, border: { width: 1, color: 6, radius: 10 }, brightness: 3,
    text: lines.map((l) => (l ? center(pxTruncate(l, inner - 6), inner) : '')).join('\n'),
  };
}

// --- 목록 ---

export interface MonitorListLayout extends StatusParts {
  footer: TextBox;
  list?: Box & { items: string[] };
  /** 줄이 있으면 요약 카드, 없으면 안내. 안내일 때는 이 칸이 조작을 받는다. */
  card: TextBox & { capture: boolean };
}

export function layoutMonitorList(view: MonitorListView): MonitorListLayout {
  const m = msg();
  const base = { ...statusParts(pxTruncate(view.title, TITLE_W), view.status), footer: footer(view.hint, view.note) };

  if (view.rows.length === 0) {
    return { ...base, card: { ...noticeCard([MON_GLYPH.unknown, view.notice ?? m.monitorLoading]), capture: true } };
  }

  const listW = 390;
  const listPad = 4;
  const rowW = listW - 2 * listPad - 2 * LIST_ITEM_PAD - 12;
  const colX = listW + 6;
  const colW = SCREEN_W - colX - 6;
  const inner = colW - 2 * (6 + 1) - 6;

  const s = view.summary;
  const card: string[] = [];
  if (s.heading) card.push(pxTruncate(s.heading, inner));
  card.push(
    spread(`${MON_GLYPH.down}${GAP}${m.monitorProblem}`, String(s.counts.down + s.counts.crit), inner),
    spread(`${MON_GLYPH.warn}${GAP}${m.monitorWarnWord}`, String(s.counts.warn), inner),
    spread(`${MON_GLYPH.ok}${GAP}${m.monitorOk}`, String(s.counts.ok), inner),
  );
  if (s.services && s.services.total > 0) card.push(spread(m.monitorServiceLabel, `${s.services.up}/${s.services.total}`, inner));
  for (const x of s.metrics) {
    if (card.length >= CARD_ROWS) break;
    const mark = x.state === 'ok' ? '' : ` ${MON_GLYPH[x.state]}`;
    card.push(spread(x.label, `${x.value}${mark}`, inner));
  }

  return {
    ...base,
    list: {
      x: 0, y: 38, w: listW, h: listHeight(view.rows.length, 5, listPad), padding: listPad,
      items: view.rows.map((r) => spreadItem(`${MON_GLYPH[r.state]}${GAP}${r.name}`, r.meta, rowW)),
    },
    card: {
      x: colX, y: 42, w: colW, h: boxHeight(card.length, 6, 1), padding: 6,
      border: { width: 1, color: 6, radius: 8 }, brightness: 3,
      text: card.join('\n'),
      capture: false,
    },
  };
}

// --- 대상 한 장 ---

export interface MonitorItemLayout extends StatusParts {
  footer: TextBox;
  /** 목록이 없어 이 칸이 조작을 받는다. */
  card: TextBox;
}

export function layoutMonitorItem(view: MonitorItemView): MonitorItemLayout {
  const m = msg();
  const base = {
    ...statusParts(pxTruncate(`${MON_GLYPH[view.state]}${GAP}${view.title}`, TITLE_W), view.status),
    footer: footer(view.hint, view.note),
  };
  if (view.metrics.length === 0 && view.services.length === 0) {
    return { ...base, card: noticeCard([MON_GLYPH.unknown, view.notice ?? m.monitorNoData]) };
  }

  // DOWN·위험이면 권한 요청처럼 굵고 밝은 테두리로 눈에 띄게 한다.
  const bad = view.state === 'down' || view.state === 'crit';
  const pad = 8;
  const border = bad ? 2 : 1;
  const cardW = SCREEN_W - 12;
  const inner = cardW - 2 * (pad + border) - 6;

  // 막대가 같은 자리에서 시작하도록 이름 칸 폭을 맞춘다. 긴 이름은 자른다.
  const names = [...view.metrics.map((x) => x.label), ...(view.services.length ? [m.monitorServiceLabel] : [])];
  const labelW = Math.min(170, Math.max(...names.map((n) => getTextWidth(n)))) + 3 * SPACE;
  const label = (t: string) => padTo(pxTruncate(t, labelW - 3 * SPACE), labelW);

  // 자리가 모자라면 나쁜 지표부터 남긴다.
  const room = CARD_ROWS - (view.services.length ? 1 : 0);
  const rank = { down: 4, crit: 3, warn: 2, unknown: 1, ok: 0 } as const;
  const metrics =
    view.metrics.length > room
      ? [...view.metrics].sort((a, b) => rank[b.state] - rank[a.state]).slice(0, room - 1)
      : view.metrics;

  const lines = metrics.map((x) => {
    const right = `${x.value}  ${x.state === 'ok' ? '　' : MON_GLYPH[x.state]}`;
    const left = x.ratio === undefined ? label(x.label) : `${label(x.label)}${gauge(x.ratio, GAUGE_CELLS)}`;
    return spread(left, right, inner);
  });
  if (metrics.length < view.metrics.length) lines.push(m.monitorMore(view.metrics.length - metrics.length));
  if (view.services.length) {
    // 내려간 것이 먼저.
    const svc = [...view.services].sort((a, b) => Number(a.up) - Number(b.up));
    lines.push(pxTruncate(`${label(m.monitorServiceLabel)}${svc.map((x) => `${x.up ? '●' : '■'}${GAP}${x.name}`).join(SEP)}`, inner));
  }

  return {
    ...base,
    card: {
      x: 6, y: 42, w: cardW, h: boxHeight(lines.length, pad, border),
      padding: pad, border: { width: border, color: bad ? 8 : 6, radius: 10 }, brightness: 4,
      text: lines.join('\n'),
    },
  };
}
