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
- Discord Developer Portal에서 `SERVER MEMBERS INTENT`, `PRESENCE INTENT` 활성화 (`!추첨`용)
- 팔월드 서버 관리자 API가 활성화된 컨테이너 (`palworld-server`)

---

## 설정 (환경 변수)

컨테이너 실행 시 다음 환경 변수를 설정해야 합니다.

| 변수 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `DISCORD_BOT_TOKEN` | 예 | - | 디스코드 봇 토큰 |
| `SERVER_URL` | 예 | - | 팔월드 서버 관리자 API 엔드포인트 (예: `http://172.17.0.1:8212`) |
| `ADMIN_PASSWORD` | 예 | - | 관리자 비밀번호 (HTTP Basic Auth용) |
| `ADMIN_USER_IDS` | 아니오 | `""` | `!봇 업데이트` 실행 권한을 가진 Discord 사용자 ID 목록 (쉼표 구분) |
| `BOT_UPDATE_ENABLED` | 아니오 | `false` | 봇 업데이트 명령 활성화 여부 (`true`/`false`) |
| `STATUS_CHANNEL_ID` | 아니오 | `""` | 봇 ready 시 버전 정보 요약(Created/Revision)을 보낼 Discord 채널 ID |
| `WATCHTOWER_IMAGE` | 아니오 | `containrrr/watchtower:latest` | 1회 업데이트 실행 시 사용할 Watchtower 이미지 |
| `BOT_IMAGE_REF` | 아니오 | `ghcr.io/mtgvim/palworld-server-bot:latest` | `!봇 버전` 조회 시 기본 대상 이미지 ref |
| `RPS_STATS_PATH` | 아니오 | `/app/data/rps-stats.json` | `!가위바위보` 전적 저장 파일 경로 |
| `AUTO_PAUSE_TIMEOUT` | 아니오 | `300` | 유휴 경고 기준 시간(초) |
| `CHECK_INTERVAL` | 아니오 | `10000` | 접속자 체크 주기(ms) |
| `PLAYERS_API_TIMEOUT_MS` | 아니오 | `5000` | 접속자 API 타임아웃(ms) |
| `STABLE_ZERO_REQUIRED_SAMPLES` | 아니오 | `2` | 유휴 상태로 판단하기 위한 연속 0명 샘플 수 |
| `NON_ZERO_GRACE_SECONDS` | 아니오 | `20` | 최근 접속자가 있었으면 경고를 보류하는 grace 시간(초) |

`docker-compose.yml` 사용 시 `SERVER_URL`, `ADMIN_PASSWORD`를 추가로 설정해야 `!상태`, `!접속자` 명령이 동작합니다.
RCON 관련 변수는 선택적으로 설정할 수 있습니다.

| 변수 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `RCON_HOST` | 아니오 | - | RCON 호스트 (예: `172.17.0.1`) |
| `RCON_PORT` | 아니오 | - | RCON 포트 (예: `25575`) |
| `RCON_PASSWORD` | 아니오 | - | RCON 비밀번호 |

---

## Docker 이미지 배포

운영 이미지는 GitHub Container Registry(`ghcr.io/mtgvim/palworld-server-bot:latest`)를 사용합니다.
이 저장소에서는 CI/CD로 이미지가 빌드/배포됩니다.
CI에서 OCI revision 라벨(`org.opencontainers.image.revision`)을 이미지에 포함하므로, 새로 배포된 이미지부터 `!봇 버전`의 `Revision`/`Ref(commit)` 값이 표시됩니다.
과거 이미지나 라벨이 없는 이미지는 해당 값이 `(unknown)`으로 표시될 수 있습니다.
또한 GitHub Actions는 이미지 push 이후 `docker buildx imagetools inspect`로 최대 30초(5초 간격, 6회) 전파 확인을 수행한 뒤, digest가 변경된 경우에만 Discord Webhook으로 성공 알림을 보냅니다(실패 알림은 항상 전송). 알림 메시지에는 해당 배포 구간의 GitHub compare 링크가 포함됩니다.
알림을 쓰려면 저장소 `Settings > Secrets and variables > Actions`에 `DISCORD_WEBHOOK_URL` 시크릿을 추가하세요.

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
또한 `./data:/app/data` 볼륨을 사용해 `!가위바위보` 전적 파일을 재시작 후에도 유지합니다.
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
- `!추첨 [N]`   : 온라인 Discord 유저(봇 제외) 중 1명 또는 N명 랜덤 추첨
- `!가위바위보 <가위|바위|보>` : 봇과 가위바위보 1회 진행 (`✌️/✊/✋`, `💃/🥹/🤝` 결과 표시)
- `!가위바위보 전적` : 내 누적 전적(승/패/무/승률) 조회
- `!가위바위보 랭킹 [N]` : 승수 기준 상위 랭킹 조회 (기본 10명)
- `!봇 버전`    : 현재 실행 중인 봇 이미지 정보(이미지명/sha/생성시각 + GHCR 링크, 링크 미리보기 없음) 조회
- `!봇 업데이트`: Watchtower 1회 실행으로 라벨 대상 컨테이너 업데이트 확인/적용 후 Created/Revision 요약 표시 (관리자 전용)
