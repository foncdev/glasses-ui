/**
 * G2 화면 렌더링. G2 어댑터 전용이며 glasses-ui 본체는 이 파일을 알지 못한다.
 *
 * 화면은 576x288, 4비트 흑백이고 한 화면에 400~500자쯤 들어간다.
 * 리스트는 제자리 갱신이 안 되므로 화면 전환 시에는 rebuild를,
 * 같은 화면에서 내용만 바뀔 때는 textContainerUpgrade를 쓴다.
 */

import { clamp, type HomeView } from '../core/glasses.js';
import { layoutHome, type Box } from './g2-home.js';
import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk';

type Bridge = Awaited<ReturnType<typeof waitForEvenAppBridge>>;

const MAIN_ID = 1;
const MAIN_NAME = 'main';
const LIST_ID = 2;
const LIST_NAME = 'list';
const SIDE_ID = 3;
const SIDE_NAME = 'side';
// 홈 화면에만 있는 칸. 목록·옆 패널과 번호가 겹치지 않게 뒤에 둔다.
const STATUS_ID = 4;
const STATUS_NAME = 'status';
const DIVIDER_ID = 5;
const DIVIDER_NAME = 'divider';
const STATS_ID = 6;
const STATS_NAME = 'stats';

/** 화면 크기. 옆 패널을 붙일 때 목록 폭을 여기서 나눈다. */
const SCREEN_W = 576;
/**
 * 옆 패널 폭.
 *
 * 14자짜리 로고가 잘리지 않아야 한다. 메뉴는 글자가 짧아
 * 남는 쪽을 줄여도 괜찮다.
 */
const SIDE_W = 300;

/** BLE 한 번 호출이 30초씩 매달리는 걸 막는다. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 응답 없음 (${ms}ms)`)), ms),
    ),
  ]);
}

export class G2Display {
  private bridge?: Bridge;
  /** 지금 화면이 리스트인지 텍스트인지. 갱신 방법이 달라진다. */
  /**
   * 지금 화면에 세워둔 컨테이너 종류.
   *
   * 'none'은 컨테이너가 없다는 뜻이다. 앱이 뒤로 물러나면 기기가
   * 화면을 걷어가므로, 돌아온 뒤에는 갱신(upgrade)이 아니라 처음부터
   * 다시 세워야(rebuild) 한다. 이 구분이 없으면 갱신이 조용히 실패해
   * 화면이 영영 안 바뀐다.
   */
  private mode: 'text' | 'list' | 'home' | 'none' = 'text';
  /**
   * 지금 세워둔 홈의 구조. 목록 글자·로고·게이지 줄 수가 같으면 다시
   * 세우지 않고, 바뀐 글자 칸만 고친다. 목록을 다시 세우면 선택이 첫
   * 항목으로 돌아가기 때문이다(listKey와 같은 이유).
   */
  private homeKey = '';
  /** 홈의 글자 칸별 지금 내용. 바뀐 칸만 고치는 데 쓴다. */
  private homeTexts = new Map<number, string>();
  /** 브리지 호출을 직렬화한다. 동시 호출은 연결을 끊을 수 있다. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * 지금 세워둔 리스트의 내용. mode가 'list'일 때만 뜻이 있다.
   *
   * 리스트를 rebuild하면 선택이 첫 항목으로 돌아간다. SDK에는 선택 위치를
   * 정해주는 값이 없어 되돌릴 방법도 없다. 주기 갱신이 같은 내용을 다시
   * 그릴 때마다 스크롤해 둔 자리가 맨 위로 튀었다 — 링으로 내려가다
   * 5초마다 처음으로 돌아가는 증상이 이것이었다. 그래서 같은 목록이면
   * 다시 세우지 않는다.
   */
  private listKey = '';
  private listHeader = '';

  async init(): Promise<Bridge> {
    this.bridge = await waitForEvenAppBridge();

    // 시작 페이지는 딱 한 번만 만들 수 있다. 이후는 rebuild를 쓴다.
    const main = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 0,
      borderColor: 0,
      paddingLength: 8,
      containerID: MAIN_ID,
      containerName: MAIN_NAME,
      content: '연결 중…',
      isEventCapture: 1,
    });

    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [main] }),
    );

    // createStartUpPageContainer는 한 번만 통한다.
    // 개발 중 HMR로 코드가 다시 실행되면 실패하는데, 페이지 자체는 이미 살아 있다.
    // 이때는 rebuild로 화면을 되찾고 계속 진행한다.
    if (result !== 0) {
      const rebuilt = await this.bridge.rebuildPageContainer(
        new RebuildPageContainer({ containerTotalNum: 1, textObject: [main] }),
      );
      if (!rebuilt) throw new Error(`시작 페이지 생성 실패 (코드 ${result})`);
    }
    this.mode = 'text';
    return this.bridge;
  }

  /**
   * 뒤로 물러난 사이 사라진 화면을 다시 세운다.
   *
   * 실제로 다시 만드는 일은 다음 그리기가 한다. 여기서는 "지금 세워둔
   * 것이 없다"고만 표시한다. 그러면 showText·showList가 갱신 대신
   * rebuild 경로를 타 화면을 되찾는다.
   *
   * 여기서 직접 rebuild하지 않는 이유는, 무엇을 그릴지는 본체가 알기
   * 때문이다. 빈 화면을 세워두면 한 번 깜빡인다.
   */
  async reattach(): Promise<void> {
    this.mode = 'none';
  }

  /** 브리지 호출을 순서대로 흘려보낸다. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    // 실패해도 큐가 막히지 않게 한다.
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** 전체 화면 텍스트. 같은 모드면 깜빡임 없이 갱신한다. */
  async showText(content: string): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return;
    const text = clamp(content, 1800);

    await this.enqueue(async () => {
      if (this.mode === 'text') {
        await withTimeout(
          bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: MAIN_ID,
              containerName: MAIN_NAME,
              contentOffset: 0,
              contentLength: 0,
              content: text,
            }),
          ),
          6000,
          '텍스트 갱신',
        );
        return;
      }

      // 리스트 화면이었으면 구조가 다르므로 다시 그린다.
      await withTimeout(
        bridge.rebuildPageContainer(
          new RebuildPageContainer({
            containerTotalNum: 1,
            textObject: [
              new TextContainerProperty({
                xPosition: 0,
                yPosition: 0,
                width: 576,
                height: 288,
                borderWidth: 0,
                borderColor: 0,
                paddingLength: 8,
                containerID: MAIN_ID,
                containerName: MAIN_NAME,
                content: clamp(text, 1000),
                isEventCapture: 1,
              }),
            ],
          }),
        ),
        8000,
        '화면 전환',
      );
      this.mode = 'text';
    });
  }

  /**
   * 선택 가능한 목록. 헤더 한 줄과 리스트를 같이 보여준다.
   * 리스트는 제자리 갱신이 안 되므로 항상 rebuild다.
   */
  async showList(header: string, items: string[], side?: string[]): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return;

    // 리스트는 최대 20개, 항목당 64자다.
    const names = items.slice(0, 20).map((s) => clamp(s.replace(/\n/g, ' '), 64));
    if (names.length === 0) names.push('(비어 있음)');

    const key = JSON.stringify([names, side ?? []]);
    const headerText = clamp(header, 60);

    await this.enqueue(async () => {
      if (this.mode === 'list' && this.listKey === key) {
        if (this.listHeader === headerText) return;
        // 목록은 그대로고 윗줄 요약만 바뀌었다. 윗줄만 제자리에서 고친다.
        const ok = await withTimeout(
          bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: MAIN_ID,
              containerName: MAIN_NAME,
              contentOffset: 0,
              contentLength: 0,
              content: headerText,
            }),
          ),
          6000,
          '머리줄 갱신',
        ).catch(() => false);
        if (ok) {
          this.listHeader = headerText;
          return;
        }
        // 고치지 못했으면 아래에서 통째로 다시 세운다.
      }

      // 다시 세우다 실패하면 화면에 무엇이 남았는지 모른다. 다음에는 꼭 다시 세운다.
      this.listKey = '';

      const headerBox = new TextContainerProperty({
        xPosition: 0,
        yPosition: 0,
        width: SCREEN_W,
        height: 40,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 6,
        containerID: MAIN_ID,
        containerName: MAIN_NAME,
        content: headerText,
        isEventCapture: 0,
      });

      // 옆 패널이 있으면 목록을 좁히고 오른쪽 자리를 비운다.
      const hasSide = Boolean(side && side.length > 0);
      const listWidth = hasSide ? SCREEN_W - SIDE_W : SCREEN_W;

      const list = new ListContainerProperty({
        xPosition: 0,
        yPosition: 42,
        width: listWidth,
        height: 246,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: 4,
        containerID: LIST_ID,
        containerName: LIST_NAME,
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: names.length,
          itemWidth: 0,
          isItemSelectBorderEn: 1,
          itemName: names,
        }),
      });

      const texts = [headerBox];
      if (hasSide) {
        texts.push(
          new TextContainerProperty({
            xPosition: listWidth,
            yPosition: 42,
            width: SIDE_W,
            height: 246,
            borderWidth: 0,
            borderColor: 0,
            paddingLength: 6,
            containerID: SIDE_ID,
            containerName: SIDE_NAME,
            content: side!.map((l) => clamp(l.replace(/\n/g, ' '), 38)).join('\n'),
            // 옆 패널은 읽기만 하는 자리다. 조작은 목록이 받는다.
            isEventCapture: 0,
          }),
        );
      }

      await withTimeout(
        bridge.rebuildPageContainer(
          new RebuildPageContainer({
            containerTotalNum: texts.length + 1,
            textObject: texts,
            listObject: [list],
          }),
        ),
        8000,
        '목록 표시',
      );
      this.mode = 'list';
      this.listKey = key;
      this.listHeader = headerText;
    });
  }

  /**
   * 꾸민 홈 화면. 배치는 g2-home.ts가 정한다.
   *
   * 상태 표시줄·게이지처럼 자주 바뀌는 칸은 글자만 고치고, 목록 글자나
   * 구조가 바뀔 때만 다시 세운다.
   */
  async showHome(view: HomeView): Promise<void> {
    const bridge = this.bridge;
    if (!bridge) return;
    const layout = layoutHome(view);

    const key = JSON.stringify([
      layout.list.items,
      layout.card?.text ?? null,
      layout.stats ? layout.stats.h : null,
    ]);
    const texts = new Map<number, [string, string]>([
      [MAIN_ID, [MAIN_NAME, layout.statusLeft.text]],
      [STATUS_ID, [STATUS_NAME, layout.statusRight.text]],
    ]);
    if (layout.stats) texts.set(STATS_ID, [STATS_NAME, layout.stats.text]);

    await this.enqueue(async () => {
      if (this.mode === 'home' && this.homeKey === key) {
        let ok = true;
        for (const [id, [name, text]] of texts) {
          if (this.homeTexts.get(id) === text) continue;
          const done = await withTimeout(
            bridge.textContainerUpgrade(
              new TextContainerUpgrade({
                containerID: id,
                containerName: name,
                contentOffset: 0,
                contentLength: 0,
                content: text,
              }),
            ),
            6000,
            '홈 갱신',
          ).catch(() => false);
          if (!done) {
            ok = false;
            break;
          }
          this.homeTexts.set(id, text);
        }
        if (ok) return;
        // 고치지 못했으면 아래에서 통째로 다시 세운다.
      }

      this.homeKey = '';
      const textBox = (id: number, name: string, b: Box, content: string) =>
        new TextContainerProperty({
          xPosition: b.x,
          yPosition: b.y,
          width: b.w,
          height: b.h,
          paddingLength: b.padding,
          borderWidth: b.border?.width ?? 0,
          borderColor: b.border?.color ?? 0,
          ...(b.border?.radius ? { borderRadius: b.border.radius } : {}),
          ...(b.brightness !== undefined ? { textColor: b.brightness } : {}),
          containerID: id,
          containerName: name,
          content,
          isEventCapture: 0,
        });

      const textObject = [
        textBox(MAIN_ID, MAIN_NAME, layout.statusLeft, layout.statusLeft.text),
        textBox(STATUS_ID, STATUS_NAME, layout.statusRight, layout.statusRight.text),
        // 빈 글은 기기가 거부할 수 있어 공백 한 칸을 넣는다.
        textBox(DIVIDER_ID, DIVIDER_NAME, layout.divider, ' '),
      ];
      if (layout.card) textObject.push(textBox(SIDE_ID, SIDE_NAME, layout.card, layout.card.text));
      if (layout.stats) textObject.push(textBox(STATS_ID, STATS_NAME, layout.stats, layout.stats.text));

      const l = layout.list;
      const list = new ListContainerProperty({
        xPosition: l.x,
        yPosition: l.y,
        width: l.w,
        height: l.h,
        borderWidth: 0,
        borderColor: 0,
        paddingLength: l.padding,
        containerID: LIST_ID,
        containerName: LIST_NAME,
        isEventCapture: 1,
        itemContainer: new ListItemContainerProperty({
          itemCount: l.items.length,
          itemWidth: 0,
          isItemSelectBorderEn: 1,
          itemName: l.items,
        }),
      });

      await withTimeout(
        bridge.rebuildPageContainer(
          new RebuildPageContainer({
            containerTotalNum: textObject.length + 1,
            textObject,
            listObject: [list],
          }),
        ),
        8000,
        '홈 표시',
      );
      this.mode = 'home';
      this.homeKey = key;
      this.homeTexts = new Map([...texts].map(([id, [, text]]) => [id, text]));
    });
  }

  async shutdown(): Promise<void> {
    await this.bridge?.shutDownPageContainer(0);
  }
}

export const LIST_CONTAINER_NAME = LIST_NAME;
