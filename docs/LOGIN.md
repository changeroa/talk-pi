# 카카오톡 계정 연결 절차

이 문서는 에이전트용 카카오톡 계정이 생긴 뒤, 브리지가 그 계정으로 메시지를 받고 답하게 만드는 순서다. 기기 구성은 세 자리로 나뉜다. 휴대폰 자리는 주인 폰의 카카오톡(듀얼 메신저 등), PC 자리는 Mac의 KakaoTalk 데스크톱 앱, 태블릿 자리는 브리지(agent-kakaotalk)가 쓴다. 브리지가 태블릿 자리를 쓰므로 휴대폰과 데스크톱 앱은 끊기지 않는다.

아래에서 `$CONF`는 브리지 설정 폴더(`${TALK_PI_CONFIG:-$HOME/.config/talk-pi}`), `$REPO`는 이 저장소를 받은 위치, `$LABEL`은 `bridge.env`의 `BRIDGE_LABEL`(기본 `talk-pi-bridge`)이다.

카카오 비밀번호는 채팅(Slack 등)으로 절대 주고받지 않는다. 비밀번호는 Mac 터미널의 CLI 입력창에 직접 치거나, 주인이 직접 만든 비밀번호 파일로만 넘긴다.

## 1. 계정 준비 (주인)

휴대폰 카카오톡에서 에이전트 계정을 활성화하고 카카오계정 이메일과 비밀번호를 정한다. 필요하면 Mac의 KakaoTalk 데스크톱 앱에도 그 계정으로 로그인한다(PC 자리). 이 단계는 브리지와 무관하므로 건드리지 않아도 된다.

## 2. 태블릿 자리 로그인 (Mac 터미널)

먼저 `bridge/bridge.env.example`을 `$CONF/bridge.env`로 복사해 값을 채우고 `chmod 600`으로 잠근다. 그다음 아래 명령을 실행한다. 자격 정보는 `$CONF/agent-messenger/`에만 저장되어 다른 카카오 계정과 섞이지 않는다.

```sh
$REPO/bridge/deploy/login.sh login
```

CLI가 이메일과 비밀번호를 묻는다. 주인이 직접 입력하거나, 미리 만든 비밀번호 파일을 쓴다. 파일은 읽은 직후 CLI가 지운다.

```sh
# 주인이 직접: 파일 만들고 권한 잠그기
umask 077; read -rs "?카카오 비밀번호: " P; print -r -- "$P" > $CONF/kakao-pass; unset P
$REPO/bridge/deploy/login.sh login --email <에이전트 카카오계정 이메일> --password-file $CONF/kakao-pass
```

기본값은 태블릿 자리다. `--device-type pc`나 `--force`는 쓰지 않는다. 쓰면 데스크톱 앱이나 다른 태블릿 세션이 끊긴다.

## 3. 인증번호 확인 (주인 폰)

처음 로그인하면 CLI가 숫자 인증번호를 터미널에 띄운다. 이 번호를 주인에게 전달하면, 주인은 휴대폰 카카오톡에 뜨는 기기 등록 요청에 그 번호를 입력해 승인한다. CLI가 승인을 감지하면 로그인이 끝나고 `kakaotalk-credentials.json`이 생긴다.

로그인 상태는 이렇게 확인한다.

```sh
$REPO/bridge/deploy/login.sh status
```

## 4. 브리지 시작 (자동)

`$REPO/bridge/deploy/install.sh`로 설치한 launchd 에이전트 `$LABEL`은 자격 파일이 생기면 저절로 시작한다(KeepAlive PathState). 상태와 로그는 이렇게 본다. 로그에는 메시지 본문과 자격 정보가 남지 않고 chatId, messageId 같은 메타데이터만 남는다.

```sh
launchctl print gui/$(id -u)/$LABEL | grep state
tail -f ~/Library/Logs/$LABEL.log
```

바로 띄우고 싶으면 `launchctl kickstart -k gui/$(id -u)/$LABEL`를 쓴다. 설치를 다시 하려면 `install.sh`를 다시 실행한다.

## 5. 주인의 카카오 사용자 ID 등록

에이전트는 누가 주인인지를 문맥으로 받고, 누구의 어떤 부탁을 들어줄지는 프롬프트에 따라 스스로 정한다. 주인이 에이전트에게 카톡을 한 번 보낸 뒤 Worker 로그에서 주인의 사용자 ID를 찾는다.

```sh
cd $REPO/agent && npx wrangler tail talk-pi --format json | grep '"senderId"'
```

나온 `senderId`를 `agent/.deploy.vars`의 `OWNER_KAKAO_IDS`에 쉼표로 덧붙이고 다시 배포한다. `e2e-owner`는 e2e 하네스용이므로 남겨 둔다(브리지 토큰이 있어야만 그 ID로 메시지를 넣을 수 있다).

```sh
cd $REPO/agent && ./scripts/deploy.sh
```

그다음부터 주인이 "OO도 답해 줘"라고 하면 에이전트가 그 허락을 메모로 남기고 다음부터 참고한다.

## 6. 확인

주인이 에이전트에게 1:1로 "안녕"을 보내 답장이 오는지 본다. 단체방의 메시지는 모두 에이전트에게 가고, 끼어들지 말지는 에이전트가 정한다(답하지 않기로 하면 아무것도 보내지 않는다).

## 문제가 생기면

- 로그에 `kakao_error`가 반복되면 `login.sh status`로 토큰 상태를 보고, 만료되었으면 2~3단계를 다시 한다.
- `agent_disconnected`가 계속되면 Worker 상태(`npx wrangler deployments list --name talk-pi`)와 `$CONF/bridge.env`의 BRIDGE_TOKEN이 Worker secret과 같은지 확인한다. 토큰을 바꿀 때는 파일을 고친 뒤 `sed -n 's/^BRIDGE_TOKEN=//p' $CONF/bridge.env | npx wrangler secret put BRIDGE_TOKEN --name talk-pi`로 secret도 함께 바꾼다.
- 브리지를 멈추려면 `launchctl bootout gui/$(id -u)/$LABEL`.
