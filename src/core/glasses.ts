/**
 * 스마트 안경 어댑터 인터페이스.
 *
 * glasses-ui는 이 인터페이스만 알고 동작한다. G2든 Ray-Ban Display든
 * 커스텀 기기든, 여기에 맞추면 같은 UI 로직을 그대로 쓴다.
 *
 * 나누는 기준은 하나다.
 *   본체는 **무엇을** 보여줄지 정한다.
 *   어댑터는 **어떻게** 그릴지 정한다.
 *
 * 그래서 본체는 글자가 아니라 뜻을 넘긴다. 완료를 '[x]'로 쓸지 초록
 * 체크 아이콘으로 그릴지는 어댑터가 자기 화면 사정을 보고 정한다.
 */

/** 사용자가 취한 동작. 기기별 이벤트를 이 넷으로 환원한다. */
export type Gesture = 'tap' | 'doubleTap' | 'up' | 'down';

export interface GestureEvent {
  gesture: Gesture;
  /**
   * 목록에서 선택된 항목의 위치.
   * 기기가 자체적으로 커서를 관리하면 그 값이 들어오고,
   * 아니면 undefined가 와서 glasses-ui가 직접 센다.
   */
  selectedIndex?: number;
}

/**
 * 항목이 놓인 상태.
 *
 * 본체는 이 값만 정하고 글자를 고르지 않는다. 단색 기기는 글자로,
 * 풀컬러 기기는 아이콘과 색으로 옮긴다.
 *
 * waiting과 pending은 일부러 나눠 뒀다. G2에서는 둘 다 '!'로 보이지만
 * 뜻이 달라서, 합쳐 버리면 색을 쓸 수 있는 기기에서 되돌릴 수 없다.
 */
export type ItemState =
  | 'done' // 끝남
  | 'todo' // 아직 안 함
  | 'running' // 작업 중
  | 'waiting' // 사용자 응답을 기다리는 중
  | 'pending' // 권한 요청이 쌓여 있음
  | 'offline' // 연결이 끊김
  | 'idle' // 붙어는 있고 노는 중
  | 'unread' // 안 읽음
  | 'read'; // 읽음

/**
 * 화면에 뜨는 한 줄.
 *
 * 문자열 대신 이걸 넘기면 어댑터가 자기 방식으로 그릴 수 있다.
 * 상태가 없는 줄(액션 항목 등)은 text만 채운다.
 */
export interface Item {
  text: string;
  state?: ItemState;
  /** 눈에 띄게 하거나 죽인다. 기기에 따라 굵기·밝기·색으로 나타난다. */
  emphasis?: 'normal' | 'strong' | 'dim';
}

/** 문자열이나 Item 중 아무거나 받는다. 옮겨가는 동안 둘 다 쓴다. */
export type ItemLike = string | Item;

/** 어떤 형태로 왔든 Item으로 맞춘다. */
export function toItem(v: ItemLike): Item {
  return typeof v === 'string' ? { text: v } : v;
}

/**
 * 기기가 신고하는 화면 규격.
 *
 * 본체는 이 값을 보고 몇 줄을 보낼지 정도만 정한다. 글자를 자르는 일은
 * 어댑터가 한다. 화면 폭을 아는 쪽이 자르는 게 맞다.
 */
export interface Caps {
  /** 텍스트 격자 기기의 칸 수. 픽셀 기반 기기는 비운다. */
  cols?: number;
  rows?: number;
  /** 단색인지 풀컬러인지. */
  color: 'mono' | 'full';
  /** 아이콘을 그릴 수 있나. */
  icons: boolean;
  /** 이미지를 띄울 수 있나. */
  images: boolean;
}

/** 안경 한 대를 다루는 어댑터. */
export interface GlassesAdapter {
  /** 사람이 읽을 기기 이름. 로그와 화면에 쓴다. */
  readonly name: string;

  /**
   * 화면 규격. 없으면 G2와 같다고 본다.
   * 기존 어댑터를 안 고쳐도 되게 선택 사항으로 둔다.
   */
  readonly caps?: Caps;

  /**
   * 홈 옆에 띄울 로고. 기기마다 화면 크기와 폰트가 달라 어댑터가 갖는다.
   * 없으면 로고 없이 목록이 화면을 다 쓴다.
   */
  readonly logo?: readonly string[];

  /** 연결하고 화면을 쓸 준비를 한다. 실패하면 throw한다. */
  connect(): Promise<void>;

  /** 전체 화면 텍스트를 보여준다. */
  showText(content: string): Promise<void>;

  /**
   * 목록 화면.
   *
   * 항목 수와 길이 제한은 기기마다 다르므로 어댑터가 알아서 자른다.
   * side를 주면 목록을 좁히고 오른쪽에 그 내용을 함께 띄운다.
   *
   * 항목은 Item으로 오지만, 예전처럼 문자열을 받아도 동작한다.
   */
  showList(
    header: string,
    items: readonly ItemLike[],
    side?: readonly ItemLike[],
  ): Promise<void>;

  /** 제스처를 구독한다. 반환값을 호출하면 끊는다. */
  onGesture(handler: (event: GestureEvent) => void): () => void;

  /** 읽어준다. 기기에 스피커가 없으면 폰 등 다른 경로를 쓴다. */
  speak(text: string): void;

  /** 읽기를 멈춘다. */
  stopSpeaking(): void;

  /** 음성 알림을 켜고 끈다. */
  setVoiceEnabled(on: boolean): void;
  readonly isVoiceEnabled: boolean;

  /** 연결을 끊고 자원을 정리한다. */
  disconnect(): Promise<void>;
}

/** 문자열을 최대 길이로 자른다. 잘렸으면 표시한다. */
export function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * 한글·한자·전각 문자는 좁은 폰트에서 두 칸을 먹는다.
 * 글자 수로만 세면 한글 목록이 화면 밖으로 밀린다.
 */
function charWidth(c: string): number {
  const code = c.codePointAt(0) ?? 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f) || // 한글 자모
    (code >= 0x2e80 && code <= 0xa4cf) || // 한중일 부수·한자
    (code >= 0xac00 && code <= 0xd7a3) || // 한글 음절
    (code >= 0xf900 && code <= 0xfaff) || // 한자 호환
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) || // 전각
    (code >= 0xffe0 && code <= 0xffe6);
  return wide ? 2 : 1;
}

/** 화면에서 차지하는 칸 수. */
export function displayWidth(s: string): number {
  let n = 0;
  for (const c of s) n += charWidth(c);
  return n;
}

/**
 * 화면 칸 수에 맞춰 자른다. 잘리면 끝에 …를 붙인다.
 *
 * clamp와 달리 글자 수가 아니라 폭을 센다. 격자 화면을 쓰는 기기가
 * 자기 cols에 맞출 때 쓴다.
 */
export function clampWidth(s: string, maxWidth: number): string {
  if (displayWidth(s) <= maxWidth) return s;

  // …도 한 칸을 먹으므로 자리를 남겨 둔다.
  const budget = maxWidth - 1;
  let out = '';
  let n = 0;
  for (const c of s) {
    const w = charWidth(c);
    if (n + w > budget) break;
    out += c;
    n += w;
  }
  return `${out}…`;
}
