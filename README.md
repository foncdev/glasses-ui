# @foncdev/glasses-ui

스마트 안경용 UI 상태머신. 화면 전환, 제스처 매핑, 서버 통신을 담는다.

## glasses-ui와 glasses-g2의 차이

이름이 비슷하지만 역할이 다르다.

| | `glasses-ui/` (여기) | `glasses-g2/` |
|---|---|---|
| 정체 | 라이브러리 | Even Hub 앱 `Relay` (G2 전용) |
| 담당 | 화면 상태머신, 제스처→명령, 서버 통신, 어댑터 | 부팅, 서버 주소 탐색, DOM/CSS, 빌드 |
| 산출물 | 없음. 소스째 쓰인다 | `dist/` → `.ehpk` |

**로직은 전부 여기 있다.** `glasses-g2`는 이걸 실행 가능한 앱으로 포장하는
껍데기다. 의존은 `glasses-g2` → `glasses-ui` 한 방향뿐이다.

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
    i18n.ts             화면 글의 한국어·영어 판
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
home ─ 상단 요약 + 메뉴
  ├ 에이전트  sessions → history → detail → slash(Claude 명령, 맨 끝에 할 일)
  ├ 알림 보기 notifications → notification
  ├ 체크 보기 checklist
  ├ 시스템    system
  ├ 명령      commands → command-result
  ├ 맥        mac → mac-present · mac-captions · mac-meeting · mac-shortcuts → mac-result
  ├ 타이머·물 phone
  └ 설정      settings
```

### Claude 명령

대화 화면에서 탭하면 그 세션에 보낼 `/` 명령 목록이 뜬다. 고르면 "`/usage` 보낼까요?"를 묻는 글 화면이
뜨고, 탭하면 보내고 더블탭하면 취소한다. 보낸 뒤에는 '실행 중' 화면에 머물다가 턴이 끝나면 결과를
결과 읽기로 바로 보인다. 맨 끝 칸은 할 일 목록이다.

- 목록의 선택은 펌웨어가 쥔다(반지도 같다). 앱은 탭할 때 고른 위치만 받는다. 고른 칸에 표시를 붙여
  목록을 다시 세우면 선택이 맨 위로 돌아가, 다음 탭이 첫 칸으로 읽혔다. 그래서 명령 목록은 커서에 따라
  바뀌지 않고, 묻는 화면은 목록이 아닌 글 화면이다. 화면이 바뀐 직후 펌웨어가 흘리는 탭은 1.2초 동안 거른다.

- 목록은 세션의 CLI가 시작할 때 알려 준 것(`slashCommands`, agent-cli가 넘긴다)이다. 첫 입력 전에는
  아직 없어서 자주 쓰는 명령(compact·context·usage·clear·code-review·simplify·init)만 보인다.
- 값을 적어야 하는 명령(model·effort·rename·loop …), 터미널 화면에서만 뜻이 있는 명령(config·mcp·agents …),
  따로 과금되는 명령(ultrareview·extra-usage)은 뺀다. 규칙은 `src/core/slash.ts`.
- `/clear`는 묻는 화면에 대화가 지워진다고 함께 알린다.

### 결과 읽기

대화 화면은 답의 첫 줄만 보인다(진행 상황이 묻히지 않게). 위·아래로 넘기면 마지막 답을 끝까지 읽는
화면이 뜬다. 폭에 맞춰 접어 한 장(8줄)씩 위·아래로 넘기고, 마지막 쪽에서 탭하거나 더블탭하면 돌아간다.
마크다운 기호(`##`·`**`·코드 울타리·표 구분선)는 걷어낸다. 규칙은 `src/core/reader.ts`.

`/usage` 결과면 첫 쪽을 한도 카드로 바꾼다 — 세션·이번 주·모델별 주간을 막대(━ 찬 칸, ─ 빈 칸)와 %,
초기화 시각(오늘이면 시각만)으로. 사용 분석은 다음 쪽부터 CLI 글 그대로다. 한도 줄을 읽지 못하면 일반 답처럼 보인다.

### 맥

[mac-agent](../mac-agent)가 relay-service의 확장 통로(`/ext/mac-agent`)로 붙어 있을 때 쓴다.
메뉴는 `GET /ext`의 기능 목록을 보고, 못 쓰는 기능에는 사유(라이선스 필요, 권한 필요 등)를 붙인다.
누르면 고칠 곳을 알려 준다 — 고치는 일은 맥에서 한다.

| 화면 | 조작 | 내용 |
|---|---|---|
| 발표 리모컨 | ● 다음 쪽(발표 전이면 시작), 위·아래 이전·다음 쪽 | 상태·쪽·경과 분, 발표자 노트, 다음 쪽 노트 한 줄 |
| 회의 자막 | ● 켜기·끄기 | 맨 아래가 지금 하는 말. 같은 줄이 고쳐지다 굳는다 |
| 다음 회의 | ● 새로고침 | 제목, 시각, 남은 시간, 장소, 회의 링크 유무 |
| 단축어 | ● 실행 | 맥의 Relay 폴더 단축어. 결과 글을 보여 준다 |
| 텔레프롬프터 | ● 말 따라가기 켜고 끄기(원고가 없으면 맥 클립보드에서 불러오기), 위·아래 줄 | 지금 줄에 ▷, 앞 줄 하나와 뒤 줄들 |

- 발표·자막·회의는 텍스트 한 장으로 그린다. 같은 모드면 기기가 깜빡임 없이 글자만 바꾼다.
  한 장은 늘 10줄·화면 폭 안이다(`test/mac-view.test.ts`가 픽셀로 잰다).
- 발표·텔레프롬프터 화면에서는 무조작으로 꺼지지 않는다 — 보며 말하는 동안 손을 대지 않는다.
  자막은 말이 들릴 때마다 화면을 켜고, 조용하면 평소처럼 꺼진다.
- 발표·자막·텔레프롬프터 중에는 새 알림을 팝업으로 띄우지 않는다. 노트가 가려지고 팝업 동안은 위·아래도 먹힌다.
- 메시지 알림(`[메시지] 이름`)을 펼친 화면에서 탭하면 답장 목록이 뜬다. 짧은 답장 넷 중 하나를 고르면
  맥의 mac-agent가 그 대화에 보낸다. 다른 알림은 예전처럼 탭이 닫기다.
- 상태는 SSE(`/present/stream`, `/captions/stream`)로 받고, 막히면 2초 폴링으로 물러선다. 화면을 떠나면 끊는다.

제스처는 `tap`·`doubleTap`·`up`·`down` 넷뿐이고, **더블탭은 언제나 한 단계 위**로 간다. 맨 위인 홈에서는 기기의 종료 확인 창을 띄운다(어댑터의 `requestExit`, 지금 안경은 `shutDownPageContainer(1)`). 나갈지는 사용자가 그 창에서 정한다. 종료 창이 없는 기기는 화면 꺼짐·종료하기·취소 메뉴를 띄운다.

권한 화면은 **거부가 맨 앞**이다. 잘못 탭해도 승인되지 않게 하려는 것이고, 화면을
그린 직후 1.2초 동안은 펌웨어가 보내는 헛 선택 이벤트를 무시한다.

## 언어

한국어와 영어를 지원한다. 언어는 폰 언어를 따른다 — Even 앱 웹뷰의
`navigator.languages` 첫 항목이 `ko`로 시작하면 한국어, 그 밖의 언어는 모두 영어다.

글은 `src/core/i18n.ts`의 `ko`·`en` 판에 키별로 있고, 코드는 `msg().screenOff`,
`msg().sessionsTotal(3)`처럼 부른다. 서버·폰에서 온 자료(할 일, 알림 제목·본문,
세션 이름, 명령 출력)는 옮기지 않는다. 테스트나 개발 중에는 `setLocale('en')`으로
덮어쓴다.

G2 화면은 칸 폭이 고정이라 영어는 짧게 쓴다. `test/i18n.test.ts`가 메뉴·머리줄·
안내 줄·카드 글이 두 언어 모두 칸에 들어가는지 픽셀로 잰다(`@evenrealities/pretext`).

언어를 더하려면:

1. `i18n.ts`의 `Locale`에 코드를 더한다.
2. `Messages` 타입을 만족하는 판을 만들어 `CATALOGS`에 넣는다. 키가 빠지거나 남으면 타입 검사에서 걸린다.
3. `detectLocale`에 그 언어를 고르는 규칙을 더한다.
4. 호스트 앱(glasses-g2)의 폰 화면 글(`src/strings.ts`)에도 판을 넣는다.
5. `npm test`로 폭을 확인한다.

## 테스트

```bash
npm test
```

안경 없이 돈다. 어댑터를 스텁으로 갈아끼워 화면 전환 그래프와 제스처 매핑을
검사한다. 기존 테스트는 한국어 화면 기준이라 `test/setup-locale.ts`가 언어를
한국어로 고정한다.

## 관련

- [glasses-g2](https://github.com/foncdev/glasses-g2) — G2 호스트 앱
- [relay-service](https://github.com/foncdev/relay-service) — 중계 서버
- [claudeAgent](https://github.com/foncdev/claudeAgent) — CLI 제어 매니저
- [notify-agent](https://github.com/foncdev/notify-agent) — 맥 알림을 relay-service로 넘겨 안경 팝업으로 띄운다

## 라이선스

MIT
