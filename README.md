# talk-pi

개인 카카오톡 계정을 Cloudflare 위의 pi 에이전트에 잇는 프로젝트다. 두 부분으로 나뉜다.

`bridge/`는 macOS에서 launchd 에이전트로 도는 Bun 서비스다. [agent-messenger](https://github.com/agent-messenger/agent-messenger)의 `KakaoTalkClient`와 `KakaoTalkListener`로 태블릿 자리에 로그인해 LOCO로 메시지를 받는다. 1:1 대화와, 단체방에서 에이전트 이름을 부르거나 멘션한 메시지만 골라 Worker로 보낸다. 연결은 브리지가 먼저 거는 인증된 WebSocket 하나이고, 답장도 같은 소켓으로 받아 카카오톡으로 보낸다. 끊기면 1초에서 60초까지 늘려 가며 다시 붙고, messageId로 중복을 거르며, 메시지 본문과 자격 정보는 로그에 남기지 않는다.

`agent/`는 Cloudflare Worker `talk-pi`다. Agents SDK의 Durable Object `TalkPi` 하나가 `agents/harness/pi`(pi-durable)를 품고, 대화방마다 pi 세션을 하나씩 연다. 모델은 LiteLLM을 OpenAI 호환 공급자로 붙였다. 코드는 동작만 보장하고 판단은 모델이 한다. 브리지는 자기 메시지를 뺀 모든 메시지(단체방 포함)를 넘기고, 에이전트는 보낸 사람이 누구인지(주인 여부 포함)를 문맥으로 받아 답할지, 무엇을 들어줄지 프롬프트대로 정한다. 답하지 않기로 하면 `<no-reply>`만 내고 아무것도 보내지 않는다. 보낸 답장은 브리지가 전달을 확인할 때까지 outbox에 남아 있다가 재연결 때 다시 보낸다.

## 기억: 메모 저장소와 키비처

기억은 OMO의 메모리 구조를 그대로 옮겼다. 메모는 YAML frontmatter(`description`, `source: user|agent|inferred`)가 붙은 마크다운이고, 경로는 `people/<사용자 id>/…`, `chats/<대화방 id>/…`, `topics/…` 셋 중 하나다. 메모는 DO의 SQLite(`kk_notes`)에 저장한다. 대화 상태와 같은 트랜잭션 저장소라 쓰기와 조회가 동기적으로 일관되고, R2처럼 본문과 색인을 따로 맞출 필요가 없으며, 에이전트 하나가 쌓는 메모는 전부 훑어도 될 만큼 작기 때문이다. 검색은 글자 바이그램 겹침으로 순위를 매기는 키워드 검색이라 "고양이는/고양이를"처럼 조사가 붙은 한국어도 맞는다.

주 에이전트는 `memory` 도구(`view`, `create`, `str_replace`, `insert`)로 오래 쓸 사실을 알게 된 그 순간 메모를 남기고, 출처를 꼭 적는다. 시스템 프롬프트에는 볼 수 있는 메모의 경로만 들어가고 본문은 들어가지 않는다.

키비처는 대화방마다 하나씩 붙는 두 번째 pi 세션이다. 주 에이전트의 사건(prompt, assistant, tool_call)을 커서와 함께 `kk_events`에 쌓고, 새 메시지가 오면 아직 판정하지 않은 후보 메모가 있을 때만 키비처를 깨운다. 첫 턴은 `<kibitzer-seed>`, 이후는 `<kibitzer-wake>`, 누적 입력이 문맥 예산을 넘으면 새 세션을 `<kibitzer-reseed>`(전달·거절 경로, 요약, 마지막 커서 포함)로 띄운다. 키비처의 도구는 읽기 전용인 `session_entries`, `memory(search|read)`와 유일한 출력인 `nudge(path, hint)`뿐이다. 받아들여진 nudge는 다음 주 에이전트 턴 앞에 참고용 `<recalled-memory source="[[path]]">` 블록으로 붙고, 전달한 경로는 그 대화방에서 다시 나가지 않는다. 거절한 경로는 메모가 고쳐지기 전까지 다시 후보가 되지 않는다. 대화방은 말하는 사람의 메모, 그 대화방의 메모, `topics/`만 볼 수 있어 다른 사람의 메모가 섞이지 않는다.

## 설정

공개 저장소에는 배포·사람별 값이 들어 있지 않다. 실제 값은 추적하지 않는 파일과 Cloudflare secret에만 둔다.

Worker(`agent/.deploy.vars`, 예시는 `agent/.deploy.vars.example`; `scripts/deploy.sh`가 배포 뒤 secret으로 올린다):

- `CLOUDFLARE_ACCOUNT_ID`: 배포할 Cloudflare 계정. secret으로 올리지 않고 wrangler에만 넘긴다.
- `LITELLM_BASE_URL`: LiteLLM의 OpenAI 호환 주소(`https://<host>/v1`).
- `OWNER_KAKAO_IDS`: 주인 카카오 사용자 id, 쉼표로 구분. `e2e-owner`는 e2e 하네스용이다.
- `AGENT_NAME`: 에이전트가 스스로를 부르는 이름.
- `OWNER_HONORIFIC`: 에이전트가 주인을 부르는 호칭.

`LITELLM_KEY`(서비스 전용 LiteLLM 가상 키)와 `BRIDGE_TOKEN`(브리지 인증 토큰)은 파일에 두지 않고 `npx wrangler secret put <이름>`에 stdin으로 넣는다. `MODEL_ID`와 `KIBITZER_MODEL_ID`는 `wrangler.jsonc`의 vars에 있다.

브리지(`~/.config/talk-pi/bridge.env`, 예시는 `bridge/bridge.env.example`): `BRIDGE_TOKEN`, `AGENT_WS_URL`(`wss://<worker host>/agents/talk-pi/main`), `BRIDGE_LABEL`(launchd 라벨, 기본 `talk-pi-bridge`). 설정 폴더는 `TALK_PI_CONFIG`로 바꿀 수 있다.

## 명령

```sh
cd agent && npx tsc --noEmit && bun test     # 타입검사, 단위 테스트
cd agent && ./scripts/deploy.sh              # 배포 + 설정 secret 업로드
cd agent && AGENT_WS_URL=wss://<worker host>/agents/talk-pi/main CLOUDFLARE_ACCOUNT_ID=<id> bun e2e/harness.ts
cd bridge && bun test && npx tsc --noEmit    # 브리지 단위 테스트, 타입검사
cd bridge && ./deploy/install.sh             # launchd 에이전트 설치
```

e2e 하네스는 카카오 계정 없이 브리지 역할을 대신하고, `wrangler tail`로 Worker의 구조화 로그를 함께 읽는다. 대화방 A에서 주인이 알레르기와 좋아하는 색을 말하면 메모가 써지는지, DO를 재시작한 뒤 대화방 B에서 알레르기를 언급하지 않는 요리 질문을 했을 때 키비처가 알레르기 메모를 짚고 답이 그것을 쓰는지, 상관없는 색 메모는 짚지 않는지, 다음 턴에 같은 메모가 다시 나가지 않는지 확인한다. 잘못된 토큰 거부, 중복 messageId, 모르는 사람의 메시지도 받아서 오류 없이 처리되는지도 함께 본다.

계정 연결 절차는 [docs/LOGIN.md](docs/LOGIN.md)에 있다.
