## palworld-server-bot

팔월드 전용 Docker 컨테이너(`palworld-server`)를 Discord 봇으로 제어하는 작은 유틸리티입니다.

- **기능**
  - 일정 시간 접속자가 없으면 자동으로 `palworld-server` 컨테이너를 `pause` (AUTO_PAUSE)
  - 디스코드 명령어로 컨테이너 기동/일시중지/재시작/상태/접속자 조회
  - HTTP API (`/v1/api/players`) 를 통해 현재 접속자 수 확인

---

## 필수 요구 사항

- Docker 데몬이 동작 중일 것
- Node.js 20 (이미지는 `node:20-alpine` 사용)
- Discord 봇 토큰
- 팔월드 서버 관리자 API가 활성화된 컨테이너 (`palworld-server`)
- (옵션) Watchtower 컨테이너를 통한 자동 업데이트

---

## 설정 (환경 변수)

컨테이너 실행 시 다음 환경 변수를 설정해야 합니다.

- **DISCORD_BOT_TOKEN**: 디스코드 봇 토큰
- **SERVER_URL**: 팔월드 서버 관리자 API 엔드포인트 (예: `http://palworld-server:8080`)
- **ADMIN_PASSWORD**: 관리자 비밀번호 (HTTP Basic Auth용)
- **AUTO_PAUSE_TIMEOUT**: 자동 일시중지까지 대기 시간(초). 기본값 `300`
- **CHECK_INTERVAL**: 접속자 체크 주기(ms). 기본값 `10000`
- **WAKE_PROTECTION_MINUTES**: 기동 후 자동 일시중지 보호 시간(분). 기본값 `30`
- **ANNOUNCE_CHANNEL_ID**: 봇이 재시작될 때 알림을 보낼 디스코드 채널 ID (선택)

docker-compose를 사용하는 경우에는 `docker-compose.yml`의 `environment` 섹션을 참고하세요.

이 저장소의 기본 `docker-compose.yml`은 다음 환경 변수를 예시로 포함합니다.

- **DISCORD_BOT_TOKEN**
- **RCON_HOST**
- **RCON_PORT**
- **RCON_PASSWORD**
- **ANNOUNCE_CHANNEL_ID**

---

## Docker 이미지 빌드

로컬에서 다음 스크립트로 이미지를 빌드합니다.

```bash
bash build.sh
```

내부적으로 다음 명령과 동일합니다.

```bash
docker build -t palworld-monitor:latest .
```

Dockerfile은 Yarn을 사용하여 `package.json` / `yarn.lock` 기반으로 의존성을 설치합니다.

---

## 실행 예시

이미지 빌드 후 단순 실행 예시는 다음과 같습니다.

```bash
docker run --rm \
  -e DISCORD_BOT_TOKEN=xxx \
  -e SERVER_URL=http://palworld-server:8080 \
  -e ADMIN_PASSWORD=your-password \
  --name palworld-monitor \
  palworld-monitor:latest
```

운영 환경에서는 이 저장소에 포함된 `docker-compose.yml`을 참고해 palworld 서버와 함께 띄우는 구성을 권장합니다.

`docker-compose.yml`에는 `/var/run/docker.sock` 볼륨을 마운트하여, 봇 컨테이너 내부에서 `docker pause/unpause/restart` 명령으로
`palworld-server` 컨테이너를 제어하도록 구성되어 있습니다.

---

## 디스코드 명령어

- `!도움`       : 사용 가능한 명령어 목록 출력
- `!기동`       : `docker unpause palworld-server`
- `!일시중지`   : `docker pause palworld-server`
- `!재시작`     : `docker restart palworld-server`
- `!상태`       : 현재 실행/일시중지 상태와 접속자 수 표시
- `!접속자`     : 현재 접속 중인 플레이어 목록 출력

봇이 컨테이너 재시작 등으로 다시 켜질 때, `ANNOUNCE_CHANNEL_ID`가 설정되어 있다면 해당 채널에
`"🔄 palbot가 재시작되었습니다."` 메시지를 자동으로 남깁니다.

