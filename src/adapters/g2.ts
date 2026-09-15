/**
 * Even Realities G2 어댑터.
 *
 * glasses-ui의 GlassesAdapter를 Even Hub SDK로 구현한다.
 * G2 고유의 사정(BLE 직렬화, protobuf 영값 생략, 폰트 제약)은 전부 여기서 흡수해
 * glasses-ui 본체가 기기를 몰라도 되게 한다.
 */

import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk';
import {
  clamp,
  toItem,
  type Caps,
  type Gesture,
  type GestureEvent,
  type GlassesAdapter,
  type ItemLike,
  type ItemState,
} from '../core/glasses.js';
import { G2Display } from './g2-display.js';
import { GLASSES_LOGO } from './g2-logo.js';
import { speaker } from './phone-speaker.js';

/**
 * 상태를 G2 화면의 글자로 옮긴다.
 *
 * 단색에 폰트도 제한적이라 아이콘 대신 문자 하나를 앞에 붙인다.
 * 공백은 펌웨어가 지워버리므로 빈칸 대신 눈에 보이는 문자를 쓴다.
 *
 * waiting과 pending이 같은 '!'인 것은 G2 사정이다. 본체는 둘을 나눠서
 * 보내고, 색을 쓸 수 있는 기기는 다르게 그리면 된다.
 */
const MARK: Record<ItemState, string> = {
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

/**
 * 체크리스트만 '[x]'를 쓴다.
 *
 * 같은 done이라도 세션 목록에서는 '*'이고 체크리스트에서는 '[x]'였다.
 * 화면을 그대로 두려고 이 차이를 남긴다. todo가 '[ ]'로 오는 줄은
 * 체크리스트가 확실하므로, 그 목록에서만 done을 '[x]'로 바꾼다.
 */
function marksFor(items: readonly ItemLike[]): string[] {
  const parsed = items.map(toItem);
  const isChecklist = parsed.some((i) => i.state === 'todo');

  return parsed.map((i) => {
    // 마크가 없는 줄은 액션 안내다. 원래도 자르지 않았다.
    if (!i.state) return i.text;
    const mark = isChecklist && i.state === 'done' ? '[x]' : MARK[i.state];
    // 마크를 뺀 본문만 자른다. 마크까지 세면 제목이 한 글자씩 더 잘린다.
    return `${mark} ${i.max ? clamp(i.text, i.max) : i.text}`;
  });
}

/**
 * 기기 이벤트를 glasses-ui의 제스처로 바꾼다.
 *
 * 이벤트가 어느 필드로 오는지는 활성 컨테이너 종류에 따라 다르다.
 *  - 리스트 활성: 탭은 listEvent(선택 인덱스 포함), 스크롤은 펌웨어가 내부 처리
 *  - 텍스트 활성: 스크롤은 textEvent, 탭/더블탭은 sysEvent
 *
 * 또한 protobuf가 영값을 생략하므로 탭(0)과 첫 항목(index 0)이 undefined로 온다.
 * ?? 0 보정이 없으면 탭이 통째로 무시된다.
 */
export function readGesture(event: EvenHubEvent): GestureEvent | null {
  const { listEvent: list, textEvent: text, sysEvent: sys } = event;

  const toGesture = (t: number): Gesture | null => {
    if (t === OsEventTypeList.CLICK_EVENT) return 'tap';
    if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) return 'doubleTap';
    if (t === OsEventTypeList.SCROLL_TOP_EVENT) return 'up';
    if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) return 'down';
    return null;
  };

  if (list) {
    // 리스트도 eventType을 실어 보낸다. 이걸 안 보고 tap으로 고정하면
    // 더블탭(뒤로가기)이 탭으로 바뀌어 화면에서 빠져나올 수 없다.
    const g = toGesture(list.eventType ?? 0);
    if (!g) return null;
    // 선택 위치는 탭 계열에서만 의미가 있다. 스크롤에 실어 보내면
    // 커서가 펌웨어 값으로 덮여 위아래 이동이 먹지 않는다.
    return g === 'tap' || g === 'doubleTap'
      ? { gesture: g, selectedIndex: list.currentSelectItemIndex ?? 0 }
      : { gesture: g };
  }

  if (text) {
    // 텍스트 화면에서는 스크롤만 이 경로로 온다.
    const g = toGesture(text.eventType ?? 0);
    return g === 'up' || g === 'down' ? { gesture: g } : null;
  }

  if (sys) {
    const g = toGesture(sys.eventType ?? 0);
    // 나머지는 생명주기 이벤트다. 여기서는 다루지 않는다.
    return g ? { gesture: g } : null;
  }

  return null;
}

export class G2Adapter implements GlassesAdapter {
  readonly name = 'Even Realities G2';

  /** 576×288, 4비트 흑백. 리스트는 20줄 × 64자가 상한이다. */
  readonly caps: Caps = {
    cols: 64,
    rows: 20,
    color: 'mono',
    icons: false,
    images: false,
  };

  /** 이 화면과 폰트에 맞춰 그린 로고. 다른 기기에는 맞지 않는다. */
  readonly logo = GLASSES_LOGO;

  private display = new G2Display();
  private bridge?: Awaited<ReturnType<G2Display['init']>>;
  private unsubscribe?: () => void;

  async connect(): Promise<void> {
    this.bridge = await this.display.init();
  }

  async showText(content: string): Promise<void> {
    await this.display.showText(content);
  }

  async showList(
    header: string,
    items: readonly ItemLike[],
    side?: readonly ItemLike[],
  ): Promise<void> {
    // 옆 패널은 로고 같은 장식이라 상태 마크를 붙이지 않는다.
    await this.display.showList(header, marksFor(items), side?.map((s) => toItem(s).text));
  }

  onGesture(handler: (event: GestureEvent) => void): () => void {
    if (!this.bridge) return () => undefined;
    const stop = this.bridge.onEvenHubEvent((event: EvenHubEvent) => {
      const parsed = readGesture(event);
      if (parsed) handler(parsed);
    });
    // SDK가 해제 함수를 주지 않는 경우를 대비해 빈 함수로 채운다.
    this.unsubscribe = stop ?? ((): void => undefined);
    return this.unsubscribe;
  }

  // G2에는 스피커가 없다. 소리는 폰에서 난다.
  speak(text: string): void {
    speaker.speak(text);
  }

  stopSpeaking(): void {
    speaker.stop();
  }

  setVoiceEnabled(on: boolean): void {
    speaker.setEnabled(on);
  }

  get isVoiceEnabled(): boolean {
    return speaker.isEnabled;
  }

  /**
   * 설정을 기기 쪽 저장소에 남긴다. 앱을 다시 열어도 유지된다.
   *
   * 브리지 저장소는 컴패니언 앱이 들고 있어 아직 연결 전이거나
   * 시뮬레이터를 다시 띄우면 비어 있다. 그때는 WebView 자체
   * localStorage가 남아 있으므로 양쪽에 써두고 양쪽에서 찾는다.
   */
  async saveSetting(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(key, value);
    } catch {
      // 저장소가 막혀 있어도 브리지 쪽은 시도한다.
    }
    await this.bridge?.setLocalStorage(key, value);
  }

  async loadSetting(key: string): Promise<string> {
    const fromBridge = (await this.bridge?.getLocalStorage(key)) ?? '';
    if (fromBridge) return fromBridge;
    try {
      return localStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  }

  async disconnect(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await this.display.shutdown();
  }
}
