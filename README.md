## palworld-server-bot

팔월드 전용 Docker 컨테이너(`palworld-server`)를 Discord 봇으로 제어하는 작은 유틸리티입니다.

- **기능**
  - 일정 시간 접속자가 없으면 Discord 채널에 유휴 경고 전송 (자동 강제 `pause` 없음)
  - 디스코드 명령어로 컨테이너 기동/일시중지/재시작/상태/접속자 조회
  - HTTP API (`/v1/api/players`) 를 통해 현재 접속자 수 확인

---

## 필수 요구 사항

- Docker 데몬이 동작 중일 것
- Node.js 20 (이미지는 `node:20-alpine` 사용)
- Discord 봇 토큰
- 팔월드 서버 관리자 API가 활성화된 컨테이너 (`palworld-server`)

---

## 설정 (환경 변수)

컨테이너 실행 시 다음 환경 변수를 설정해야 합니다.

- **DISCORD_BOT_TOKEN**: 디스코드 봇 토큰
- **SERVER_URL**: 팔월드 서버 관리자 API 엔드포인트 (예: `http://172.17.0.1:8212`)
- **ADMIN_PASSWORD**: 관리자 비밀번호 (HTTP Basic Auth용)
- **AUTO_PAUSE_TIMEOUT**: 유휴 경고 기준 시간(초). 기본값 `300`
- **CHECK_INTERVAL**: 접속자 체크 주기(ms). 기본값 `10000`
- **PLAYERS_API_TIMEOUT_MS**: 접속자 API 타임아웃(ms). 기본값 `5000`
- **STABLE_ZERO_REQUIRED_SAMPLES**: 유휴 상태로 판단하기 위한 연속 0명 샘플 수. 기본값 `2`
- **NON_ZERO_GRACE_SECONDS**: 최근 접속자가 있었으면 경고를 보류하는 grace 시간(초). 기본값 `20`
- **IDLE_WARNING_COOLDOWN_SECONDS**: 유휴 경고 재전송 최소 간격(초). 기본값 `300`
- **BUILD_COMMIT_AT**: 빌드된 커밋 시각(ISO-8601). `!버전`과 기동 로그에 표시됨. `build.sh` 사용 시 자동 주입
- **UPDATE_ALLOWED_USER_IDS**: `!업데이트` 권한 허용 Discord 사용자 ID 목록(쉼표 구분). 미설정 시 업데이트 명령 비활성
- **UPDATE_ALLOWED_ROLE_IDS**: `!업데이트` 권한 허용 Discord 역할 ID 목록(쉼표 구분, 선택)
- **UPDATE_DELAY_SECONDS**: `!업데이트` 실행 지연 시간(초). 기본값 `60`
- **UPDATE_COMPOSE_FILE**: 컨테이너 내부에서 접근 가능한 compose 파일 경로. 기본값 `docker-compose.yml`
- **UPDATE_SERVICE_NAME**: `docker compose pull/up` 대상 서비스명. 기본값 `palbot`

`docker-compose.yml` 사용 시 `SERVER_URL`, `ADMIN_PASSWORD`를 추가로 설정해야 `!상태`, `!접속자` 명령이 동작합니다.
RCON 관련 변수는 선택적으로 설정할 수 있습니다.

- **RCON_HOST**: RCON 호스트 (예: `172.17.0.1`)
- **RCON_PORT**: RCON 포트 (예: `25575`)
- **RCON_PASSWORD**: RCON 비밀번호

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
  -e SERVER_URL=http://172.17.0.1:8212 \
  -e ADMIN_PASSWORD=your-password \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --name palworld-monitor \
  ghcr.io/mtgvim/palworld-server-bot:latest
```

운영 환경에서는 이 저장소에 포함된 `docker-compose.yml`을 참고해 palworld 서버와 함께 띄우는 구성을 권장합니다.

`docker-compose.yml`에는 `/var/run/docker.sock` 볼륨을 마운트하여, 봇 컨테이너 내부에서 `docker unpause/pause/restart` 명령으로
`palworld-server` 컨테이너를 제어하도록 구성되어 있습니다.

자동 루프는 컨테이너를 강제 일시중지하지 않고, 유휴 조건 충족 시 경고 메시지만 전송합니다.

`!업데이트`를 사용하려면 봇 컨테이너 내부에서 `UPDATE_COMPOSE_FILE` 경로를 읽을 수 있어야 합니다.
필요하면 compose 파일을 볼륨으로 마운트하세요.

---

## 디스코드 명령어

- `!도움`       : 사용 가능한 명령어 목록 출력
- `!기동`       : `docker unpause palworld-server`
- `!일시중지`   : `docker pause palworld-server`
- `!재시작`     : `docker restart palworld-server`
- `!상태`       : 현재 실행/일시중지 상태와 접속자 수 표시
- `!접속자`     : 현재 접속 중인 플레이어 목록 출력
- `!버전`       : 현재 봇 버전 및 빌드 커밋 시각 표시
- `!업데이트`   : 권한 사용자만 가능. 지연 후 `compose pull` + `up --force-recreate` 실행
- `!업데이트취소`: 예약된 업데이트 취소
