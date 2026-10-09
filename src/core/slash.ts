/**
 * 안경에서 고르는 Claude Code / 명령.
 *
 * 세션의 CLI는 시작할 때 쓸 수 있는 명령 목록(기본 명령·스킬)을 알려 준다. 안경은 글을
 * 적을 수 없으므로, 값이 따로 있어야 하는 명령과 터미널 화면에서만 뜻이 있는 명령은 뺀다.
 * 자주 쓰는 것을 앞에 두고, 나머지는 CLI가 알려 준 순서를 따르되 플러그인 스킬(이름:이름)을 뒤로 민다.
 */

export type SlashKey = 'compact' | 'context' | 'usage' | 'clear' | 'code-review' | 'simplify' | 'init';

export interface SlashItem {
  /** / 없는 이름 */
  name: string;
  /** 자주 쓰는 명령이면 설명 글의 키 */
  key?: SlashKey;
  /** 대화가 지워지는 등 되돌리기 어려워 한 번 더 탭해야 보낸다 */
  confirm?: boolean;
}

/** 자주 쓰는 명령. 세션 목록이 아직 없을 때(첫 입력 전)도 이것만은 보인다. */
const COMMON: readonly SlashItem[] = [
  { name: 'compact', key: 'compact' },
  { name: 'context', key: 'context' },
  { name: 'usage', key: 'usage' },
  { name: 'clear', key: 'clear', confirm: true },
  { name: 'code-review', key: 'code-review' },
  { name: 'simplify', key: 'simplify' },
  { name: 'init', key: 'init' },
];

/**
 * 뺄 명령. 값을 적어야 하는 것(model·effort·rename·loop·goal·schedule·batch),
 * 터미널 화면에서만 뜻이 있는 것(config·mcp·agents·color …), 따로 과금되는 것(ultrareview·extra-usage).
 */
const HIDDEN = new Set([
  'model', 'effort', 'rename', 'loop', 'goal', 'schedule', 'batch',
  'config', 'mcp', 'agents', 'list-agents', 'color', 'output-style', 'focus', 'fast', 'autocompact',
  'heapdump', 'import', 'reload-plugins', 'reload-skills', 'auto-mode-setup', 'advisor', 'team-onboarding',
  'design-consent', 'design-revoke', 'workflow-launch-exec',
  'ultrareview', 'extra-usage', 'usage-credits',
]);

/** 고를 수 있는 명령. available은 세션이 알려 준 목록(없으면 자주 쓰는 것만). max칸을 넘지 않는다. */
export function slashItems(available: readonly string[] | undefined, max: number): SlashItem[] {
  const names = (available ?? []).map((n) => n.replace(/^\//, '').trim()).filter(Boolean);
  const known = new Set(names);
  // 목록을 아직 모르면 자주 쓰는 것을 다 보인다. 알면 그 세션에 있는 것만.
  const common = names.length === 0 ? [...COMMON] : COMMON.filter((c) => known.has(c.name));
  const taken = new Set(common.map((c) => c.name));
  const rest = names.filter((n) => !taken.has(n) && !HIDDEN.has(n) && !n.startsWith('_'));
  const plain = rest.filter((n) => !n.includes(':'));
  const plugin = rest.filter((n) => n.includes(':'));
  return [...common, ...plain.map((name) => ({ name })), ...plugin.map((name) => ({ name }))].slice(0, max);
}
