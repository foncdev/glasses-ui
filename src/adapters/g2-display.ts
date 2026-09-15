/**
 * G2 화면 렌더링. G2 어댑터 전용이며 glasses-ui 본체는 이 파일을 알지 못한다.
 *
 * 화면은 576x288, 4비트 흑백이고 한 화면에 400~500자쯤 들어간다.
 * 리스트는 제자리 갱신이 안 되므로 화면 전환 시에는 rebuild를,
 * 같은 화면에서 내용만 바뀔 때는 textContainerUpgrade를 쓴다.
 */

import { clamp } from '../core/glasses.js';
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
  private mode: 'text' | 'list' = 'text';
  /** 브리지 호출을 직렬화한다. 동시 호출은 연결을 끊을 수 있다. */
  private queue: Promise<unknown> = Promise.resolve();

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

    await this.enqueue(async () => {
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
        content: clamp(header, 60),
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
    });
  }

  async shutdown(): Promise<void> {
    await this.bridge?.shutDownPageContainer(0);
  }
}

export const LIST_CONTAINER_NAME = LIST_NAME;
