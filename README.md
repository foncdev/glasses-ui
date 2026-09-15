# @foncdev/glasses-ui

스마트 안경용 UI 상태머신. 화면 전환, 제스처 매핑, 서버 통신을 담는다.

## glasses-ui와 glasses의 차이

이름이 비슷하지만 역할이 다르다.

| | `glasses-ui/` (여기) | `glasses/` |
|---|---|---|
| 정체 | 라이브러리 | Even Hub 앱 `Relay` |
| 담당 | 화면 상태머신, 제스처→명령, 서버 통신, 어댑터 | 부팅, 서버 주소 탐색, DOM/CSS, 빌드 |
| 산출물 | 없음. 소스째 쓰인다 | `dist/` → `.ehpk` |

**로직은 전부 여기 있다.** `glasses/`는 이걸 실행 가능한 앱으로 포장하는 껍데기다.
의존은 `glasses` → `glasses-ui` 한 방향뿐이다.

`relay-service`와도 헷갈리기 쉬운데 그쪽은 **서버**다. 이 라이브러리가 붙는 상대지
같은 계층이 아니다. iOS 앱 이름도 `Relay`라 문서에서 "Relay 앱"이라고 하면 폰 앱을
가리킨다.

## 구조

```
src/
  index.ts              공개 API
  core/
    glasses-ui.ts       GlassesUI — 화면 전환 전체
    agent-cli.ts        relay-service와의 HTTP + SSE
    glasses.ts          GlassesAdapter 인터페이스
    logo.ts             로고 아트
  adapters/
    g2.ts               G2 구현 (BLE 직렬화, protobuf 영값 처리)
    g2-display.ts       G2 화면 렌더링
    phone-speaker.ts    폰 음성 알림
```

## GlassesAdapter

기기를 갈아끼우는 지점이다. 본체는 이 인터페이스만 알고, G2의 사정은 어댑터가
전부 흡수한다. 다른 안경을 붙이려면 여기만 구현하면 된다.

```ts
import { GlassesUI, type GlassesAdapter } from '@foncdev/glasses-ui';

const ui = new GlassesUI(myAdapter, { onLog: console.log });
await ui.start();
```

## 화면

```
home ─ 상단 요약 + 메뉴 4개
  ├ 에이전트  sessions → history → detail
  ├ 알림 보기 notifications → notification
  ├ 체크 보기 checklist
  └ 설정      settings
```

제스처는 `tap`·`doubleTap`·`up`·`down` 넷뿐이고, **더블탭은 언제나 한 단계 위**로 간다.

권한 화면은 **거부가 맨 앞**이다. 잘못 탭해도 승인되지 않게 하려는 것이고, 화면을
그린 직후 1.2초 동안은 펌웨어가 보내는 헛 선택 이벤트를 무시한다.

## 테스트

```bash
npm test
```

안경 없이 돈다. 어댑터를 스텁으로 갈아끼워 화면 전환 그래프와 제스처 매핑을
검사한다.
