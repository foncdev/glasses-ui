/**
 * 홈 메뉴 구성: 순서와 숨김.
 *
 * 안경 설정이나 폰 Relay 앱(설정 > 안경 메뉴)에서 바꾼다. 폰은 GET /phone/status의 menu로
 * 알려 주고, 안경에서 바꾼 것은 POST /phone/menu로 폰에 맞춘다. iOS·Android 앱과 같은 규칙이다.
 */
import { msg } from './i18n.js';

/** 홈 메뉴 항목. id는 그 항목이 여는 화면 이름이다. */
export const MENU_ITEMS = [
  { id: 'sessions', label: 'menuAgents' },
  { id: 'phone', label: 'menuPhone' },
  { id: 'notifications', label: 'menuNotifications' },
  { id: 'checklist', label: 'menuChecklist' },
  { id: 'system', label: 'menuSystem' },
  { id: 'mac', label: 'menuMac' },
  { id: 'commands', label: 'menuCommands' },
  { id: 'settings', label: 'menuSettings' },
] as const;

export type MenuId = (typeof MENU_ITEMS)[number]['id'];

export interface MenuConfig {
  order: MenuId[];
  hidden: MenuId[];
}

/** 기본 순서. 명령은 기본으로 숨긴다. */
export const DEFAULT_MENU: MenuConfig = {
  order: ['sessions', 'phone', 'notifications', 'checklist', 'system', 'mac', 'settings', 'commands'],
  hidden: ['commands'],
};

const KNOWN = new Set<string>(MENU_ITEMS.map((i) => i.id));

/**
 * 받은 값을 규칙에 맞춘다. 모르는 id·겹친 id는 빼고, 빠진 id는 기본 순서대로 끝에 붙인다
 * (빠진 것은 기본에서 숨긴 것만 숨긴다). 설정은 숨길 수 없다 — 숨기면 되돌릴 길이 없다.
 */
export function normalizeMenu(raw: unknown): MenuConfig {
  const value = (raw ?? {}) as { order?: unknown; hidden?: unknown };
  const order: MenuId[] = [];
  for (const id of Array.isArray(value.order) ? value.order : []) {
    if (typeof id === 'string' && KNOWN.has(id) && !order.includes(id as MenuId)) order.push(id as MenuId);
  }
  const missing = DEFAULT_MENU.order.filter((id) => !order.includes(id));
  order.push(...missing);
  const hiddenIn = Array.isArray(value.hidden) ? value.hidden : [];
  // 빠졌던 id는 받은 hidden과 상관없이 기본값이 정한다(iOS·Android와 같다).
  const hidden = order.filter(
    (id) =>
      id !== 'settings' &&
      (missing.includes(id) ? DEFAULT_MENU.hidden.includes(id) : hiddenIn.includes(id)),
  );
  return { order, hidden };
}

export function sameMenu(a: MenuConfig, b: MenuConfig): boolean {
  return a.order.join() === b.order.join() && a.hidden.join() === b.hidden.join();
}

/** 홈에 보일 항목. 컴퓨터는 맥·PC가 연결됐을 때만 보인다. */
export function visibleMenu(config: MenuConfig, computerLinked: boolean): MenuId[] {
  return config.order.filter((id) => !config.hidden.includes(id) && (id !== 'mac' || computerLinked));
}

export function menuLabel(id: MenuId): string {
  const item = MENU_ITEMS.find((i) => i.id === id);
  return item ? msg()[item.label] : id;
}

/** id 하나를 한 칸 옮긴다. 끝이면 그대로다. */
export function moveMenu(config: MenuConfig, id: MenuId, step: -1 | 1): MenuConfig {
  const order = [...config.order];
  const from = order.indexOf(id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= order.length) return config;
  [order[from], order[to]] = [order[to], order[from]];
  return { order, hidden: config.hidden };
}

/** 보이기·숨기기를 바꾼다. 설정은 바꾸지 않는다. */
export function toggleMenu(config: MenuConfig, id: MenuId): MenuConfig {
  if (id === 'settings') return config;
  const hidden = config.hidden.includes(id) ? config.hidden.filter((h) => h !== id) : [...config.hidden, id];
  return normalizeMenu({ order: config.order, hidden });
}
