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
- **ADMIN_USER_IDS**: `!봇 업데이트` 실행 권한을 가진 Discord 사용자 ID 목록 (쉼표 구분)
- **BOT_UPDATE_ENABLED**: 봇 업데이트 명령 활성화 여부 (`true`/`false`, 기본 `false`)
- **STATUS_CHANNEL_ID**: 봇 ready 시 버전 정보를 보낼 Discord 채널 ID (선택)
- **WATCHTOWER_IMAGE**: 1회 업데이트 실행 시 사용할 Watchtower 이미지 (기본 `containrrr/watchtower:latest`)
- **BOT_IMAGE_REF**: `!봇 버전` 조회 시 기본 대상 이미지 ref (기본 `ghcr.io/mtgvim/palworld-server-bot:latest`)
- **AUTO_PAUSE_TIMEOUT**: 유휴 경고 기준 시간(초). 기본값 `300`
- **CHECK_INTERVAL**: 접속자 체크 주기(ms). 기본값 `10000`
- **PLAYERS_API_TIMEOUT_MS**: 접속자 API 타임아웃(ms). 기본값 `5000`
- **STABLE_ZERO_REQUIRED_SAMPLES**: 유휴 상태로 판단하기 위한 연속 0명 샘플 수. 기본값 `2`
- **NON_ZERO_GRACE_SECONDS**: 최근 접속자가 있었으면 경고를 보류하는 grace 시간(초). 기본값 `20`

`docker-compose.yml` 사용 시 `SERVER_URL`, `ADMIN_PASSWORD`를 추가로 설정해야 `!상태`, `!접속자` 명령이 동작합니다.
RCON 관련 변수는 선택적으로 설정할 수 있습니다.

- **RCON_HOST**: RCON 호스트 (예: `172.17.0.1`)
- **RCON_PORT**: RCON 포트 (예: `25575`)
- **RCON_PASSWORD**: RCON 비밀번호

---

## Docker 이미지 배포

운영 이미지는 GitHub Container Registry(`ghcr.io/mtgvim/palworld-server-bot:latest`)를 사용합니다.
이 저장소에서는 CI/CD로 이미지가 빌드/배포됩니다.
CI에서 OCI revision 라벨(`org.opencontainers.image.revision`)을 이미지에 포함하므로, 새로 배포된 이미지부터 `!봇 버전`의 `Revision`/`Ref(commit)` 값이 표시됩니다.
과거 이미지나 라벨이 없는 이미지는 해당 값이 `(unknown)`으로 표시될 수 있습니다.

`!봇 업데이트` 명령은 상시 Watchtower 컨테이너를 띄우지 않고, 필요 시 `docker run ... watchtower --run-once --label-enable`를 1회 실행해
Watchtower 라벨이 켜진 컨테이너만 업데이트를 확인/적용합니다.

---

## 실행 예시

단순 실행 예시는 다음과 같습니다.

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
또한 `com.centurylinklabs.watchtower.enable=true` 라벨을 사용해 `!봇 업데이트` 대상 컨테이너를 명시합니다.

자동 루프는 컨테이너를 강제 일시중지하지 않고, 유휴 조건 충족 시 `⚠️ N분동안 접속자가 없습니다.` 경고를 1회만 전송합니다.
경고는 `!기동`으로 서버를 다시 기동하면 초기화됩니다.

---

## 디스코드 명령어

- `!도움`       : 사용 가능한 명령어 목록 출력
- `!기동`       : `docker unpause palworld-server`
- `!일시중지`   : `docker pause palworld-server`
- `!재시작`     : `docker restart palworld-server`
- `!상태`       : 현재 실행/일시중지 상태와 접속자 수 표시
- `!접속자`     : 현재 접속 중인 플레이어 목록 출력
- `!봇 버전`    : 현재 실행 중인 봇 이미지 정보(이미지명/sha/생성시각, Asia/Seoul +09:00 기준) 조회
- `!봇 업데이트`: Watchtower 1회 실행으로 라벨 대상 컨테이너 업데이트 확인/적용 (관리자 전용)
