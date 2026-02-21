const { Client, GatewayIntentBits } = require("discord.js");
const { exec } = require("child_process");
const { constants: FS_CONSTANTS } = require("fs");
const fs = require("fs/promises");
const path = require("path");
const { evaluateIdleWarningDecision } = require("./idle-warning-decision");
const {
  createRpsPersistence,
  evaluateRps,
  getOrCreateRpsRecord,
  normalizeRpsChoice,
} = require("./rps-core");

const bootTime = Date.now();

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const SERVER_URL = process.env.SERVER_URL;
const PASSWORD = process.env.ADMIN_PASSWORD;

const AUTO_PAUSE_TIMEOUT = parseInt(process.env.AUTO_PAUSE_TIMEOUT || "300", 10);
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "10000", 10);
const STABLE_ZERO_REQUIRED_SAMPLES = parseInt(
  process.env.STABLE_ZERO_REQUIRED_SAMPLES || "2",
  10
);
const NON_ZERO_GRACE_SECONDS = parseInt(
  process.env.NON_ZERO_GRACE_SECONDS || "20",
  10
);
const PLAYERS_API_TIMEOUT_MS = parseInt(
  process.env.PLAYERS_API_TIMEOUT_MS || "5000",
  10
);
const BOT_UPDATE_ENABLED =
  String(process.env.BOT_UPDATE_ENABLED || "false").toLowerCase() === "true";
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const STATUS_CHANNEL_ID = (process.env.STATUS_CHANNEL_ID || "").trim();
const WATCHTOWER_IMAGE = (process.env.WATCHTOWER_IMAGE || "containrrr/watchtower:latest").trim();
const BOT_IMAGE_REF = (process.env.BOT_IMAGE_REF || "ghcr.io/mtgvim/palworld-server-bot:latest").trim();
const RPS_STATS_PATH = (
  process.env.RPS_STATS_PATH || "/app/data/rps-stats.json"
).trim();
const RPS_PERSIST_LOG_INTERVAL = parseInt(
  process.env.RPS_PERSIST_LOG_INTERVAL || "20",
  10
);
const RPS_RANKING_MIN_GAMES_FOR_WIN_RATE = parseInt(
  process.env.RPS_RANKING_MIN_GAMES_FOR_WIN_RATE || "10",
  10
);
const LEETCODE_GRAPHQL_URL = (
  process.env.LEETCODE_GRAPHQL_URL || "https://leetcode.com/graphql"
).trim();
const LEETCODE_FETCH_TIMEOUT_MS = parseInt(
  process.env.LEETCODE_FETCH_TIMEOUT_MS || "5000",
  10
);
const LEETCODE_TODAY_CACHE_PATH = (
  process.env.LEETCODE_TODAY_CACHE_PATH || "/app/data/leetcode-today.json"
).trim();
const LEETCODE_TODAY_TIMEZONE = (
  process.env.LEETCODE_TODAY_TIMEZONE || "Asia/Seoul"
).trim();

const AUTH =
  "Basic " + Buffer.from("admin:" + PASSWORD).toString("base64");

let lastActive = Date.now();
let botChannel = null;
let lastNonZeroSeenAt = null;
const recentPlayerCounts = [];
let idleWarningSentSinceStartup = false;
let updateInProgress = false;
let rpsStats = {};
let rpsStatsLoaded = false;
let loopPausedNoticeShown = false;
let leetTodayLoaded = false;
let leetTodayCache = { byDate: {} };
let leetTodayQueue = Promise.resolve();
const rpsPersistence = createRpsPersistence({
  fs,
  statsPath: RPS_STATS_PATH,
  logInterval: RPS_PERSIST_LOG_INTERVAL,
  logger: (line) => console.log(line),
});

function docker(cmd) {
  console.log("[docker] executing command:", cmd);
  return new Promise((resolve, reject) => {
    exec(cmd, (err) => {
      if (err) {
        console.log("[docker] command failed:", cmd, "| error:", err.message);
        reject(err);
      } else {
        console.log("[docker] command succeeded:", cmd);
        resolve();
      }
    });
  });
}

function dockerWithOutput(cmd) {
  console.log("[docker] executing command with output:", cmd);
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) {
        console.log(
          "[docker] command with output failed:",
          cmd,
          "| error:",
          err.message,
          "| stderr:",
          (stderr || "").trim()
        );
        reject(err);
      } else {
        resolve((stdout || "").trim());
      }
    });
  });
}

function isSafeDockerRef(value) {
  return /^[A-Za-z0-9._:@/-]+$/.test(value);
}

function isAuthorizedUpdater(userId) {
  if (!BOT_UPDATE_ENABLED) {
    return {
      ok: false,
      message:
        "⚠️ 봇 업데이트 기능이 비활성화되어 있습니다. `BOT_UPDATE_ENABLED=true`로 설정해주세요.",
    };
  }

  if (ADMIN_USER_IDS.length === 0) {
    return {
      ok: false,
      message:
        "⚠️ 업데이트 권한자가 설정되지 않았습니다. `ADMIN_USER_IDS`에 Discord 사용자 ID를 지정해주세요.",
    };
  }

  if (!ADMIN_USER_IDS.includes(userId)) {
    return {
      ok: false,
      message: "⛔ 이 명령은 관리자만 실행할 수 있습니다.",
    };
  }

  return { ok: true };
}

async function getBotVersionInfo() {
  const containerId = (process.env.HOSTNAME || "").trim();
  try {
    let configuredImage = "";
    let imageId = "";

    if (containerId && isSafeDockerRef(containerId)) {
      try {
        const imagePair = await dockerWithOutput(
          `docker inspect -f '{{.Config.Image}}|{{.Image}}' ${containerId}`
        );
        [configuredImage, imageId] = imagePair
          .split("|")
          .map((value) => value.trim());
      } catch (err) {
        if (isDockerNoSuchObjectError(err)) {
          console.log(
            "[version] self container inspect skipped (HOSTNAME으로 컨테이너를 조회할 수 없음), BOT_IMAGE_REF로 대체합니다."
          );
        } else {
          console.log(
            "[version] self container inspect failed, fallback to BOT_IMAGE_REF:",
            err.message
          );
        }
      }
    }

    if (!configuredImage && isSafeDockerRef(BOT_IMAGE_REF)) {
      configuredImage = BOT_IMAGE_REF;
    }

    const inspectTarget = imageId || configuredImage;
    if (!inspectTarget || !isSafeDockerRef(inspectTarget)) {
      return {
        ok: false,
        message: "이미지 식별자를 확인할 수 없어 버전 정보를 조회하지 못했습니다.",
      };
    }

    let imageMeta;
    try {
      imageMeta = await dockerWithOutput(
        `docker image inspect -f '{{.Id}}|{{.Created}}|{{json .Config.Labels}}|{{json .RepoDigests}}' ${inspectTarget}`
      );
    } catch (err) {
      if (!configuredImage || inspectTarget === configuredImage) {
        throw err;
      }

      imageMeta = await dockerWithOutput(
        `docker image inspect -f '{{.Id}}|{{.Created}}|{{json .Config.Labels}}|{{json .RepoDigests}}' ${configuredImage}`
      );
    }
    const [resolvedImageId, createdAt, labelsRaw, repoDigestsRaw] = imageMeta
      .split("|")
      .map((value) => value.trim());
    const labels = safeJsonParse(labelsRaw, {});
    const repoDigests = safeJsonParse(repoDigestsRaw, []);
    const labeledRevision = (
      labels["org.opencontainers.image.revision"] || ""
    ).trim();
    const revision = labeledRevision || extractRevisionFromImageRef(configuredImage);
    const digestRef = Array.isArray(repoDigests) && repoDigests.length > 0
      ? String(repoDigests[0]).trim()
      : "";
    const commitRef = buildCommitRef(configuredImage, revision);

    return {
      ok: true,
      configuredImage: configuredImage || "(unknown)",
      imageId: resolvedImageId || imageId || "(unknown)",
      createdAt: createdAt || "(unknown)",
      revision: revision || "(unknown)",
      digestRef: digestRef || "(unknown)",
      commitRef: commitRef || "(unknown)",
    };
  } catch (err) {
    return {
      ok: false,
      message: `버전 정보 조회 실패: ${err.message}`,
    };
  }
}

function formatVersionMessage(versionInfo) {
  if (!versionInfo.ok) {
    return `정보: ${versionInfo.message}`;
  }

  const ghcrUrl = getImageRepositoryUrl(versionInfo.configuredImage);

  return (
    "봇 버전 정보\n" +
    `- Image: ${versionInfo.configuredImage}\n` +
    `- Image ID: ${versionInfo.imageId}\n` +
    `- Created: ${formatCreatedAtSeoul(versionInfo.createdAt)}\n` +
    `- Revision: ${versionInfo.revision}\n` +
    `- Ref(commit): ${versionInfo.commitRef}\n` +
    `- Ref(digest): ${versionInfo.digestRef}\n` +
    `- GHCR: [이미지 링크](${ghcrUrl})`
  );
}

function formatBootVersionMessage(versionInfo) {
  if (!versionInfo.ok) {
    return `정보: ${versionInfo.message}`;
  }

  return (
    "ℹ️ 봇이 재시작되었습니다.\n" +
    `- Created: ${formatCreatedAtSeoul(versionInfo.createdAt)}\n` +
    `- Revision: ${versionInfo.revision}\n` +
    "- 가이드: `!도움`으로 명령어 목록 확인"
  );
}

function formatUpdateSummaryMessage(versionInfo) {
  if (!versionInfo.ok) {
    return `업데이트 확인이 완료되었습니다.\n정보: ${versionInfo.message}`;
  }

  return (
    "업데이트 확인이 완료되었습니다.\n" +
    `- Created: ${formatCreatedAtSeoul(versionInfo.createdAt)}\n` +
    `- Revision: ${versionInfo.revision}`
  );
}

function formatCreatedAtSeoul(createdAt) {
  if (!createdAt || createdAt === "(unknown)") {
    return createdAt || "(unknown)";
  }

  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) {
    return createdAt;
  }

  const formatted = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);

  return `${formatted} (Asia/Seoul, +09:00)`;
}

function getImageRepositoryUrl(imageRef) {
  const fallback = "https://ghcr.io/mtgvim/palworld-server-bot";
  if (!imageRef) {
    return fallback;
  }

  const normalized = String(imageRef).trim().split("@")[0];
  const lastSlash = normalized.lastIndexOf("/");
  const lastColon = normalized.lastIndexOf(":");
  const withoutTag = lastColon > lastSlash
    ? normalized.slice(0, lastColon)
    : normalized;
  const repository = withoutTag.replace(/^https?:\/\//, "");
  if (!repository) {
    return fallback;
  }

  return `https://${repository}`;
}

function safeJsonParse(value, fallback) {
  if (!value || value === "null" || value === "<no value>") {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function isDockerNoSuchObjectError(errorLike) {
  const message = String(errorLike && errorLike.message ? errorLike.message : errorLike || "");
  return message.includes("no such object");
}

function normalizeLeetDifficulty(input) {
  const value = String(input || "").trim().toLowerCase();
  const compact = value.replace(/\s+/g, "");
  if (!value) return "MEDIUM";
  if (["easy", "e"].includes(value)) return "EASY";
  if (["medium", "m"].includes(value)) return "MEDIUM";
  if (["hard", "h"].includes(value)) return "HARD";
  if (compact.includes("쉬움") || compact.includes("초급")) return "EASY";
  if (compact.includes("중간") || compact.includes("보통") || compact.includes("중급")) return "MEDIUM";
  if (compact.includes("어려움") || compact.includes("고급")) return "HARD";
  return null;
}

function formatLeetDifficultyLabel(difficulty) {
  if (difficulty === "EASY") return "쉬움";
  if (difficulty === "HARD") return "어려움";
  return "중간";
}

function resolveLeetTodayTimeZone() {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: LEETCODE_TODAY_TIMEZONE }).format(new Date());
    return LEETCODE_TODAY_TIMEZONE;
  } catch {
    return "Asia/Seoul";
  }
}

function getDateKeyInTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    return date.toISOString().slice(0, 10);
  }
  return `${year}-${month}-${day}`;
}

async function ensureLeetTodayLoaded() {
  if (leetTodayLoaded) {
    return;
  }

  const dir = path.dirname(LEETCODE_TODAY_CACHE_PATH);
  let loadMode = "empty";

  try {
    await fs.mkdir(dir, { recursive: true });
    const raw = await fs.readFile(LEETCODE_TODAY_CACHE_PATH, "utf8");
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.byDate && typeof parsed.byDate === "object") {
        leetTodayCache = parsed;
        loadMode = "file";
      } else {
        leetTodayCache = { byDate: {} };
        loadMode = "invalid-reset";
      }
    } catch {
      leetTodayCache = { byDate: {} };
      loadMode = "invalid-reset";
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.log("[leet][WARN] 오늘의문제 캐시 로드 실패:", err.message, "| path:", LEETCODE_TODAY_CACHE_PATH);
    }
    leetTodayCache = { byDate: {} };
  }

  leetTodayLoaded = true;
  console.log(`[leet][INFO] 오늘의문제 캐시 준비 완료: mode=${loadMode} path=${LEETCODE_TODAY_CACHE_PATH}`);
}

function pruneLeetTodayCache(maxDays) {
  if (!leetTodayCache.byDate || typeof leetTodayCache.byDate !== "object") {
    leetTodayCache.byDate = {};
    return;
  }
  const keys = Object.keys(leetTodayCache.byDate).sort();
  while (keys.length > maxDays) {
    const oldest = keys.shift();
    if (!oldest) break;
    delete leetTodayCache.byDate[oldest];
  }
}

async function persistLeetTodayCache() {
  await ensureLeetTodayLoaded();
  pruneLeetTodayCache(14);
  const payload = JSON.stringify(leetTodayCache, null, 2);
  await fs.writeFile(LEETCODE_TODAY_CACHE_PATH, payload, "utf8");
}

function enqueueLeetTodayTask(task) {
  const scheduled = leetTodayQueue.then(task, task);
  leetTodayQueue = scheduled.catch(() => {});
  return scheduled;
}

async function fetchLeetRandomQuestion(difficulty) {
  const query = [
    "query randomQ($categorySlug: String, $filters: QuestionListFilterInput) {",
    "  randomQuestion(categorySlug: $categorySlug, filters: $filters) {",
    "    title",
    "    titleSlug",
    "    difficulty",
    "    isPaidOnly",
    "  }",
    "}",
  ].join("\n");

  const response = await fetchWithTimeout(
    LEETCODE_GRAPHQL_URL,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        variables: {
          categorySlug: "",
          filters: {
            difficulty,
          },
        },
      }),
    },
    LEETCODE_FETCH_TIMEOUT_MS
  );

  if (!response.ok) {
    throw new Error(`LeetCode API HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    const firstError = payload.errors[0]?.message || "unknown error";
    throw new Error(`LeetCode API 오류: ${firstError}`);
  }

  const question = payload?.data?.randomQuestion;
  if (!question || !question.titleSlug) {
    throw new Error("랜덤 문제를 찾지 못했습니다.");
  }

  return {
    title: String(question.title || question.titleSlug),
    titleSlug: String(question.titleSlug),
    difficulty: String(question.difficulty || difficulty).toUpperCase(),
    isPaidOnly: Boolean(question.isPaidOnly),
  };
}

async function pickLeetRandomQuestion(difficulty) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const question = await fetchLeetRandomQuestion(difficulty);
    if (!question.isPaidOnly) {
      return question;
    }
  }
  throw new Error("무료 문제를 찾지 못했습니다. 잠시 후 다시 시도해주세요.");
}

function formatLeetQuestionLine(prefix, difficulty, question) {
  const label = formatLeetDifficultyLabel(difficulty);
  const url = `https://leetcode.com/problems/${question.titleSlug}/`;
  return (
    `${prefix} (${label})\n` +
    `- 제목: ${question.title}\n` +
    `- 링크: ${url}`
  );
}

function normalizeContainerPath(value) {
  const normalized = path.posix.normalize(String(value || "").trim());
  if (!normalized) return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function isPathCoveredByMount(targetPath, mountDestination) {
  const target = normalizeContainerPath(targetPath);
  const destination = normalizeContainerPath(mountDestination);
  return target === destination || target.startsWith(`${destination}/`);
}

async function warnRpsPersistenceMisconfigOnReady() {
  if (!process.env.RPS_STATS_PATH) {
    console.log(
      "[rps][WARN] RPS_STATS_PATH 환경변수가 없어 기본 경로를 사용합니다:",
      RPS_STATS_PATH
    );
    console.log(
      "[rps][ACTION] 런타임 환경변수에 RPS_STATS_PATH=/app/data/rps-stats.json 를 명시하세요."
    );
  }

  const containerId = (process.env.HOSTNAME || "").trim();
  if (!containerId || !isSafeDockerRef(containerId)) {
    console.log(
      "[rps][WARN] 컨테이너 마운트를 검사할 수 없습니다. HOSTNAME 값이 없거나 안전하지 않습니다."
    );
    console.log(
      "[rps][ACTION] docker.sock 접근 가능 상태인지 확인하고 다음 명령으로 마운트를 점검하세요: docker inspect <container> --format '{{json .Mounts}}'"
    );
    return;
  }

  try {
    const mountsRaw = await dockerWithOutput(
      `docker inspect -f '{{json .Mounts}}' ${containerId}`
    );
    const mounts = safeJsonParse(mountsRaw, []);
    const coveringMount = Array.isArray(mounts)
      ? mounts.find((mount) => (
        mount &&
        typeof mount.Destination === "string" &&
        isPathCoveredByMount(RPS_STATS_PATH, mount.Destination)
      ))
      : null;

    if (!coveringMount) {
      console.log(
        "[rps][WARN] RPS_STATS_PATH를 포함하는 컨테이너 마운트가 없습니다. 전적은 재시작/업데이트 시 초기화됩니다.",
        "| path:",
        RPS_STATS_PATH
      );
      console.log(
        `[rps][ACTION] ${RPS_STATS_PATH} 경로를 포함하는 쓰기 가능한 볼륨을 추가하세요. (예: ./data:/app/data)`
      );
      return;
    }

    if (coveringMount.RW !== true) {
      console.log(
        "[rps][WARN] 전적 저장 마운트가 읽기 전용입니다. 전적을 기록할 수 없습니다.",
        `| dst: ${coveringMount.Destination || "(unknown)"}`
      );
      console.log(
        "[rps][ACTION] RPS 전적 볼륨을 쓰기 가능(rw) 모드로 변경하세요."
      );
    }

    console.log(
      "[rps][OK] 전적 저장 마운트를 확인했습니다:",
      `type=${coveringMount.Type || "(unknown)"}`,
      `src=${coveringMount.Source || "(unknown)"}`,
      `dst=${coveringMount.Destination || "(unknown)"}`,
      `rw=${coveringMount.RW === true ? "true" : "false"}`
    );
  } catch (err) {
    if (isDockerNoSuchObjectError(err)) {
      console.log(
        "[rps][INFO] 현재 런타임에서는 HOSTNAME으로 자기 컨테이너를 조회할 수 없습니다. 마운트 자동 점검 로그를 생략합니다.",
        `| hostname: ${containerId}`
      );
      console.log(
        "[rps][ACTION] 필요하면 운영 환경에서 docker inspect <실제 컨테이너명> --format '{{json .Mounts}}' 로 직접 점검하세요."
      );
      return;
    }
    console.log(
      "[rps][WARN] 전적 영속화 점검을 위한 마운트 조회에 실패했습니다:",
      err.message
    );
    console.log(
      "[rps][ACTION] docker.sock 접근/권한을 확인하고, 필요하면 docker inspect <실제 컨테이너명> --format '{{json .Mounts}}' 로 직접 점검하세요."
    );
  }
}

function buildCommitRef(configuredImage, revision) {
  if (!configuredImage || !revision) {
    return "";
  }

  if (!/^[a-f0-9]{7,64}$/i.test(revision)) {
    return "";
  }

  const withoutDigest = configuredImage.split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  const repository = hasTag ? withoutDigest.slice(0, lastColon) : withoutDigest;

  return `${repository}:${revision}`;
}

function extractRevisionFromImageRef(imageRef) {
  if (!imageRef) {
    return "";
  }

  const withoutDigest = String(imageRef).split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  const hasTag = lastColon > lastSlash;
  if (!hasTag) {
    return "";
  }

  const tag = withoutDigest.slice(lastColon + 1).trim();
  if (!/^[a-f0-9]{7,64}$/i.test(tag)) {
    return "";
  }

  return tag;
}

async function getOnlineHumanMembers(guild) {
  if (!guild) {
    return {
      ok: false,
      message: "⚠️ 이 명령은 서버(길드) 채널에서만 사용할 수 있습니다.",
      members: [],
    };
  }

  try {
    await guild.members.fetch({ withPresences: true });
  } catch (err) {
    console.log("[raffle] failed to fetch guild members/presences:", err.message);
  }

  const members = guild.members.cache.filter((member) => {
    if (!member || member.user.bot) return false;
    const status = member.presence && member.presence.status;
    return Boolean(status) && status !== "offline";
  });

  if (members.size === 0) {
    return {
      ok: false,
      message:
        "⚠️ 온라인 유저를 찾지 못했습니다. 서버 멤버 프레즌스 인텐트(Guild Presences)를 켜고, 현재 온라인 멤버가 있는지 확인해주세요.",
      members: [],
    };
  }

  return { ok: true, members: Array.from(members.values()) };
}

function pickRandomMembers(members, count) {
  const pool = members.slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

function rpsChoiceEmoji(choice) {
  if (choice === "가위") return "✌️";
  if (choice === "바위") return "✊";
  if (choice === "보") return "✋";
  return "❓";
}

function rpsResultEmoji(result) {
  if (result === "승리") return "🎉";
  if (result === "패배") return "🥹";
  return "🤝";
}

async function ensureRpsStatsLoaded() {
  if (rpsStatsLoaded) {
    return;
  }

  const dir = path.dirname(RPS_STATS_PATH);
  let loadMode = "empty";

  try {
    await fs.mkdir(dir, { recursive: true });
    const raw = await fs.readFile(RPS_STATS_PATH, "utf8");
    try {
      const parsed = JSON.parse(raw);
      rpsStats = parsed && typeof parsed === "object" ? parsed : {};
      loadMode = "file";
    } catch (parseErr) {
      const brokenPath = `${RPS_STATS_PATH}.broken-${Date.now()}`;
      console.log(
        "[rps][WARN] 전적 파일 JSON이 손상되어 백업 후 초기화합니다:",
        brokenPath
      );
      try {
        await fs.rename(RPS_STATS_PATH, brokenPath);
      } catch (renameErr) {
        console.log(
          "[rps][WARN] 손상된 전적 파일 백업에 실패했습니다:",
          renameErr.message,
          "| path:",
          RPS_STATS_PATH
        );
      }
      rpsStats = {};
      loadMode = "recovered-empty";
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.log(
        "[rps][WARN] 전적 파일 로드에 실패했습니다:",
        err.message,
        "| path:",
        RPS_STATS_PATH
      );
    }
    rpsStats = {};
  }

  rpsStatsLoaded = true;
  const users = Object.keys(rpsStats).length;
  const totalGames = Object.values(rpsStats).reduce((sum, row) => (
    sum + (Number.isFinite(row && row.games) ? row.games : 0)
  ), 0);
  let writable = true;
  let fileExists = false;
  let fileSize = 0;
  try {
    await fs.access(dir, FS_CONSTANTS.W_OK);
  } catch {
    writable = false;
  }
  try {
    const stat = await fs.stat(RPS_STATS_PATH);
    fileExists = stat.isFile();
    fileSize = stat.size;
  } catch {
    fileExists = false;
  }
  console.log(
    `[rps][INFO] 전적 저장소 준비 완료: mode=${loadMode} path=${RPS_STATS_PATH} dir=${dir} writable=${writable} fileExists=${fileExists} fileSize=${fileSize} users=${users} games=${totalGames}`
  );
  if (!RPS_STATS_PATH.startsWith("/app/data/")) {
    console.log(
      "[rps][WARN] RPS_STATS_PATH가 /app/data 밖에 있습니다. 전적 영속화가 보장되지 않습니다:",
      RPS_STATS_PATH
    );
    console.log(
      "[rps][ACTION] /app/data/* 경로를 사용하고, 호스트 볼륨을 /app/data로 마운트하세요."
    );
  }
}

async function persistRpsStats() {
  await rpsPersistence.persist(rpsStats);
}

async function updateRpsStatsForUser(userId, result) {
  await ensureRpsStatsLoaded();
  const record = getOrCreateRpsRecord(rpsStats, userId);
  record.games += 1;
  if (result === "승리") record.wins += 1;
  if (result === "패배") record.losses += 1;
  if (result === "무승부") record.draws += 1;
  record.updatedAt = new Date().toISOString();
  await persistRpsStats();
  return record;
}

function formatRpsRecord(record) {
  const wins = record.wins || 0;
  const losses = record.losses || 0;
  const draws = record.draws || 0;
  const games = record.games || 0;
  const winRate = games > 0 ? ((wins / games) * 100).toFixed(1) : "0.0";
  return `승 ${wins} | 패 ${losses} | 무 ${draws} | ${games}전 | 승률 ${winRate}%`;
}

function getRpsRanking(limit) {
  const minGames = Number.isInteger(RPS_RANKING_MIN_GAMES_FOR_WIN_RATE)
    ? Math.max(1, RPS_RANKING_MIN_GAMES_FOR_WIN_RATE)
    : 10;
  return Object.entries(rpsStats)
    .map(([userId, record]) => ({
      userId,
      wins: Number.isFinite(record.wins) ? record.wins : 0,
      losses: Number.isFinite(record.losses) ? record.losses : 0,
      draws: Number.isFinite(record.draws) ? record.draws : 0,
      games: Number.isFinite(record.games) ? record.games : 0,
    }))
    .filter((row) => row.games > 0)
    .sort((a, b) => {
      const aWinRate = a.games >= minGames ? a.wins / a.games : -1;
      const bWinRate = b.games >= minGames ? b.wins / b.games : -1;
      if (bWinRate !== aWinRate) return bWinRate - aWinRate;
      if (b.wins !== a.wins) return b.wins - a.wins;
      if (b.games !== a.games) return b.games - a.games;
      return a.losses - b.losses;
    })
    .slice(0, limit);
}

function formatRankingWinRate(row) {
  const minGames = Number.isInteger(RPS_RANKING_MIN_GAMES_FOR_WIN_RATE)
    ? Math.max(1, RPS_RANKING_MIN_GAMES_FOR_WIN_RATE)
    : 10;
  if (row.games < minGames) return `${minGames}판 미만 🐥`;
  return `${((row.wins / row.games) * 100).toFixed(1)}%`;
}

function getWatchtowerRunOnceCommand() {
  if (!isSafeDockerRef(WATCHTOWER_IMAGE)) {
    throw new Error(
      "WATCHTOWER_IMAGE 값이 안전하지 않습니다. 영문/숫자/._:@/- 문자만 사용해주세요."
    );
  }

  return (
    "docker run --rm " +
    "-v /var/run/docker.sock:/var/run/docker.sock " +
    `${WATCHTOWER_IMAGE} ` +
    "--run-once --cleanup --label-enable"
  );
}

async function fetchWithTimeout(url, options = {}, timeout = 3000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch {
    clearTimeout(id);
    throw new Error("timeout");
  }
}

async function isPaused(options = {}) {
  const { verbose = true } = options;
  return new Promise((resolve) => {
    exec(
      "docker inspect -f '{{.State.Paused}}' palworld-server",
      (err, out) => {
        if (err) {
          console.log(
            "[status] failed to inspect palworld-server pause state:",
            err.message
          );
          resolve(false);
        } else {
          const paused = out.trim() === "true";
          if (verbose) {
            console.log(
              "[status] palworld-server paused state:",
              paused ? "true" : "false"
            );
          }
          resolve(paused);
        }
      }
    );
  });
}

async function getPlayers() {
  const snapshot = await getPlayersSnapshot("players");
  return snapshot.players;
}

function toPlayersArray(value) {
  return Array.isArray(value) ? value : [];
}

function parsePlayersSnapshot(payload) {
  const directPlayers = toPlayersArray(payload && payload.players);
  if (directPlayers.length > 0) {
    return { players: directPlayers, count: directPlayers.length };
  }

  const nestedPlayers = toPlayersArray(
    payload && payload.data && payload.data.players
  );
  if (nestedPlayers.length > 0) {
    return { players: nestedPlayers, count: nestedPlayers.length };
  }

  const rootArrayPlayers = toPlayersArray(payload);
  if (rootArrayPlayers.length > 0) {
    return { players: rootArrayPlayers, count: rootArrayPlayers.length };
  }

  const numericCandidates = [
    payload && payload.playerCount,
    payload && payload.onlinePlayers,
    payload && payload.playersOnline,
    payload && payload.numPlayers,
    payload && payload.currentPlayers,
    payload && payload.data && payload.data.playerCount,
    payload && payload.data && payload.data.onlinePlayers,
    payload && payload.data && payload.data.playersOnline,
    payload && payload.data && payload.data.numPlayers,
    payload && payload.data && payload.data.currentPlayers,
  ];
  const numericCount = numericCandidates.find(
    (value) => typeof value === "number" && Number.isFinite(value)
  );
  if (typeof numericCount === "number") {
    return { players: [], count: Math.max(0, Math.floor(numericCount)) };
  }

  return { players: [], count: 0 };
}

function recordPlayerSample(count) {
  recentPlayerCounts.push(count);
  while (recentPlayerCounts.length > STABLE_ZERO_REQUIRED_SAMPLES) {
    recentPlayerCounts.shift();
  }
}

async function getPlayersSnapshot(logPrefix = "players") {
  try {
    const r = await fetchWithTimeout(
      SERVER_URL + "/v1/api/players",
      { headers: { Authorization: AUTH } },
      PLAYERS_API_TIMEOUT_MS
    );
    if (!r.ok) {
      console.log(
        `[${logPrefix}] failed to fetch players. status:`,
        r.status,
        r.statusText
      );
      return {
        ok: false,
        players: [],
        count: 0,
      };
    }
    const d = await r.json();
    const parsed = parsePlayersSnapshot(d);
    console.log(
      `[${logPrefix}] fetched players:`,
      parsed.count
    );
    return {
      ok: true,
      players: parsed.players,
      count: parsed.count,
    };
  } catch (err) {
    console.log(`[${logPrefix}] error while fetching players:`, err.message);
    return {
      ok: false,
      players: [],
      count: 0,
    };
  }
}

// 🔥 AUTO PAUSE LOOP
setInterval(async () => {
  try {
    const paused = await isPaused({ verbose: false });
    if (paused) {
      if (!loopPausedNoticeShown) {
        console.log("[status] palworld-server paused state: true");
        console.log("[loop] palworld-server is already paused. skipping check.");
        loopPausedNoticeShown = true;
      }
      return;
    }
    if (loopPausedNoticeShown) {
      console.log("[status] palworld-server paused state: false");
      console.log("[loop] palworld-server resumed. restarting checks.");
      loopPausedNoticeShown = false;
    }

    const snapshot = await getPlayersSnapshot("loop");
    const now = Date.now();

    if (snapshot.ok) {
      recordPlayerSample(snapshot.count);
      if (snapshot.count > 0) {
        lastActive = now;
        lastNonZeroSeenAt = now;
        console.log(
          "[loop] players online. count:",
          snapshot.count,
          "resetting idle timer."
        );
      }
    } else {
      console.log(
        "[loop] players fetch failed. skipping idle warning decision this cycle."
      );
      return;
    }

    if (snapshot.count > 0) {
      return;
    }

    const idleSeconds = Math.floor((now - lastActive) / 1000);

    if (idleSeconds >= AUTO_PAUSE_TIMEOUT) {
      const verifySnapshot = await getPlayersSnapshot("loop-verify");
      const verifyNow = Date.now();
      if (!verifySnapshot.ok) {
        console.log(
          "[loop] pre-warning verification failed. skipping idle warning."
        );
        return;
      }

      recordPlayerSample(verifySnapshot.count);
      if (verifySnapshot.count > 0) {
        lastActive = verifyNow;
        lastNonZeroSeenAt = verifyNow;
      }

      const decision = evaluateIdleWarningDecision({
        uptimeMs: verifyNow - bootTime,
        thresholdMs: 0,
        cachedPlayerCount: snapshot.count,
        refreshedPlayerCount: verifySnapshot.count,
        recentSamples: recentPlayerCounts,
        lastNonZeroSeenAt,
        nowMs: verifyNow,
        refreshedFetchOk: verifySnapshot.ok,
        stableZeroRequiredSamples: STABLE_ZERO_REQUIRED_SAMPLES,
        nonZeroGraceMs: NON_ZERO_GRACE_SECONDS * 1000,
      });

      console.log(
        "[loop] idle warning decision:",
        decision.reason,
        JSON.stringify(decision.evidence)
      );
      if (!decision.shouldWarn) {
        return;
      }

      console.log(
        "[loop] idle timeout reached. warning only. seconds:",
        idleSeconds,
        "threshold:",
        AUTO_PAUSE_TIMEOUT
      );
      if (!idleWarningSentSinceStartup && botChannel) {
        idleWarningSentSinceStartup = true;
        const idleMinutes = Math.max(1, Math.floor(idleSeconds / 60));
        botChannel.send(`⚠️ ${idleMinutes}분동안 접속자가 없습니다.`);
      }
    }
  } catch (err) {
    console.log("[loop] unexpected error. ignoring:", err.message);
  }
}, CHECK_INTERVAL);

// 🔥 DISCORD BOT
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on("clientReady", async () => {
  console.log("봇 준비 완료");
  await ensureRpsStatsLoaded();
  await ensureLeetTodayLoaded();
  await warnRpsPersistenceMisconfigOnReady();

  const versionInfo = await getBotVersionInfo();
  console.log("[version] ready info:", formatBootVersionMessage(versionInfo));

  if (!STATUS_CHANNEL_ID) {
    return;
  }

  try {
    const statusChannel = await client.channels.fetch(STATUS_CHANNEL_ID);
    if (!statusChannel || !statusChannel.isTextBased()) {
      console.log("[version] STATUS_CHANNEL_ID is not a text channel.");
      return;
    }
    await statusChannel.send(formatBootVersionMessage(versionInfo));
  } catch (err) {
    console.log("[version] failed to send ready version message:", err.message);
  }
});

client.on("error", (err) => {
  console.log("디스코드 오류:", err.message);
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  const content = msg.content.trim();

  if (!botChannel) botChannel = msg.channel;

  console.log(
    "[command] received message:",
    content,
    "| from:",
    `${msg.author.username}#${msg.author.discriminator}`
  );

  if (content === "!도움") {
    msg.reply(
      "📌 사용 가능한 명령어\n" +
        "!도움\n!기동\n!일시중지\n!재시작\n!상태\n!접속자\n!추첨 [N]\n!랜덤문제 [쉬움|중간|어려움]\n!오늘의문제 [(쉬움|중간|어려움)]\n!가위바위보 <가위|바위|보>\n!가위바위보 전적\n!가위바위보 랭킹 [N]\n!봇 버전\n!봇 업데이트"
    );
  }

  if (content === "!봇 버전" || content === "!봇버전") {
    console.log("[command] !봇 버전 requested.");
    const versionInfo = await getBotVersionInfo();
    return msg.reply(formatVersionMessage(versionInfo));
  }

  if (content === "!봇 업데이트" || content === "!봇업데이트") {
    console.log("[command] !봇 업데이트 requested.");

    if (updateInProgress) {
      return msg.reply("⏳ 이미 업데이트 작업이 진행 중입니다.");
    }

    const auth = isAuthorizedUpdater(msg.author.id);
    if (!auth.ok) {
      return msg.reply(auth.message);
    }

    updateInProgress = true;
    await msg.reply(
      "🔄 봇 이미지 업데이트 확인을 시작합니다.\n완료 전에 봇이 재시작될 수 있습니다."
    );

    try {
      const runOnceCommand = getWatchtowerRunOnceCommand();
      await docker(runOnceCommand);
      const versionInfo = await getBotVersionInfo();
      await msg.channel.send(formatUpdateSummaryMessage(versionInfo));
    } catch (err) {
      console.log("[command] !봇 업데이트 failed:", err.message);
      await msg.channel.send(
        "⚠️ 봇 업데이트 실행에 실패했습니다. Docker 접근 권한, WATCHTOWER_IMAGE, 라벨 설정을 확인해주세요."
      );
    } finally {
      updateInProgress = false;
    }
  }

  const raffleMatch = content.match(/^!추첨(?:\s+(\d+))?$/);
  if (raffleMatch) {
    const requestedCount = raffleMatch[1] ? parseInt(raffleMatch[1], 10) : 1;
    if (!Number.isInteger(requestedCount) || requestedCount <= 0) {
      return msg.reply('⚠️ 사용법: `!추첨` 또는 `!추첨 N` (N은 1 이상의 정수)');
    }

    const onlineResult = await getOnlineHumanMembers(msg.guild);
    if (!onlineResult.ok) {
      return msg.reply(onlineResult.message);
    }

    const onlineMembers = onlineResult.members;
    if (requestedCount > onlineMembers.length) {
      return msg.reply(
        `⚠️ 온라인 유저는 ${onlineMembers.length}명입니다. \`!추첨 ${onlineMembers.length}\` 이하로 입력해주세요.`
      );
    }

    const winners = pickRandomMembers(onlineMembers, requestedCount);
    const mentions = winners.map((member) => `<@${member.id}>`).join(", ");

    if (requestedCount === 1) {
      return msg.reply(`🎉 추첨 결과: ${mentions}`);
    }

    return msg.reply(
      `🎉 추첨 결과 (${requestedCount}명 / 온라인 ${onlineMembers.length}명)\n${mentions}`
    );
  }

  const randomQuestionMatch = content.match(/^!랜덤문제(?:\s+(.+))?$/);
  if (randomQuestionMatch) {
    const difficultyArg = String(randomQuestionMatch[1] || "").trim();
    const difficulty = normalizeLeetDifficulty(difficultyArg);
    if (!difficulty) {
      return msg.reply("⚠️ 사용법: `!랜덤문제 [쉬움|중간|어려움]`");
    }

    try {
      const question = await pickLeetRandomQuestion(difficulty);
      return msg.reply(formatLeetQuestionLine("🎲 랜덤문제", difficulty, question));
    } catch (err) {
      console.log("[leet][WARN] !랜덤문제 실패:", err.message);
      return msg.reply(`⚠️ 랜덤문제 조회 실패: ${err.message}`);
    }
  }

  const todayQuestionMatch = content.match(/^!오늘의문제(?:\s+\(([^)]+)\)|\s+(.+))?$/);
  if (todayQuestionMatch) {
    const rawArg = String(todayQuestionMatch[1] || todayQuestionMatch[2] || "").trim();
    const difficulty = normalizeLeetDifficulty(rawArg);
    if (!difficulty) {
      return msg.reply("⚠️ 사용법: `!오늘의문제`, `!오늘의문제 (중간)`");
    }

    const timezone = resolveLeetTodayTimeZone();
    const dateKey = getDateKeyInTimeZone(new Date(), timezone);
    try {
      const selected = await enqueueLeetTodayTask(async () => {
        await ensureLeetTodayLoaded();
        if (!leetTodayCache.byDate || typeof leetTodayCache.byDate !== "object") {
          leetTodayCache.byDate = {};
        }
        if (!leetTodayCache.byDate[dateKey] || typeof leetTodayCache.byDate[dateKey] !== "object") {
          leetTodayCache.byDate[dateKey] = {};
        }

        const cached = leetTodayCache.byDate[dateKey][difficulty];
        if (cached && cached.titleSlug) {
          return { question: cached, reused: true };
        }

        const question = await pickLeetRandomQuestion(difficulty);
        leetTodayCache.byDate[dateKey][difficulty] = {
          title: question.title,
          titleSlug: question.titleSlug,
          difficulty: question.difficulty,
          selectedAt: new Date().toISOString(),
        };
        await persistLeetTodayCache();
        return { question: leetTodayCache.byDate[dateKey][difficulty], reused: false };
      });

      const header = selected.reused
        ? `📌 오늘의문제 고정 (${dateKey}, ${timezone})`
        : `📌 오늘의문제 확정 (${dateKey}, ${timezone})`;
      return msg.reply(formatLeetQuestionLine(header, difficulty, selected.question));
    } catch (err) {
      console.log("[leet][WARN] !오늘의문제 실패:", err.message);
      return msg.reply(`⚠️ 오늘의문제 조회 실패: ${err.message}`);
    }
  }

  const rpsMatch = content.match(/^!가위바위보(?:\s+(.+))?$/);
  if (rpsMatch) {
    await ensureRpsStatsLoaded();

    const rpsArg = String(rpsMatch[1] || "").trim();
    if (rpsArg === "전적") {
      const record = getOrCreateRpsRecord(rpsStats, msg.author.id);
      return msg.reply(
        `📊 <@${msg.author.id}> 기록\n${formatRpsRecord(record)}`
      );
    }

    const rankingMatch = rpsArg.match(/^랭킹(?:\s+(\d+))?$/);
    if (rankingMatch) {
      const limit = rankingMatch[1] ? parseInt(rankingMatch[1], 10) : 10;
      if (!Number.isInteger(limit) || limit <= 0) {
        return msg.reply("⚠️ 사용법: `!가위바위보 랭킹` 또는 `!가위바위보 랭킹 N`");
      }

      const ranking = getRpsRanking(Math.min(limit, 30));
      if (ranking.length === 0) {
        return msg.reply("📊 아직 가위바위보 전적이 없습니다.");
      }

      const lines = ranking.map((row, idx) => (
        `${idx + 1}. <@${row.userId}> - ${row.wins}승 ${row.losses}패 ${row.draws}무 (${row.games}전) | 승률 ${formatRankingWinRate(row)}${idx === 0 ? " 🤫" : ""}`
      ));
      return msg.reply(`🏆 가위바위보 랭킹 TOP ${ranking.length}\n${lines.join("\n")}`);
    }

    const userChoice = normalizeRpsChoice(rpsArg);
    if (!userChoice) {
      return msg.reply(
        "⚠️ 사용법: `!가위바위보 가위|바위|보`, `!가위바위보 전적`, `!가위바위보 랭킹 [N]`"
      );
    }

    const botChoice = ["가위", "바위", "보"][Math.floor(Math.random() * 3)];
    const result = evaluateRps(userChoice, botChoice);
    const record = await updateRpsStatsForUser(msg.author.id, result);
    const requesterName = (
      msg.member?.displayName ||
      msg.author.globalName ||
      msg.author.username ||
      "플레이어"
    ).trim();
    return msg.reply(
      `${requesterName}${rpsChoiceEmoji(userChoice)} vs ${rpsChoiceEmoji(botChoice)} = ${rpsResultEmoji(result)} ${result}\n📈 ${formatRpsRecord(record)}`
    );
  }

  if (content === "!기동") {
    console.log("[command] !기동 requested.");
    const paused = await isPaused();
    if (!paused) {
      console.log("[command] !기동: server is not paused. already running.");
      return msg.reply("🟢 이미 실행 중입니다.");
    }

    try {
      await docker("docker unpause palworld-server");
      console.log("[command] !기동: unpause succeeded.");

      lastActive = Date.now();
      idleWarningSentSinceStartup = false;

      msg.channel.send("🟢 서버 기동 완료.");
    } catch (err) {
      console.log("[command] !기동: unpause failed:", err.message);
      msg.channel.send(
        "⚠️ 서버 기동에 실패했습니다. Docker 접근 권한 또는 컨테이너 상태를 확인해주세요."
      );
    }
  }

  if (content === "!일시중지") {
    console.log("[command] !일시중지 requested.");
    try {
      await docker("docker pause palworld-server");
      console.log("[command] !일시중지: pause succeeded.");
      msg.channel.send("🟡 서버가 일시중지되었습니다.");
    } catch (err) {
      console.log("[command] !일시중지: pause failed:", err.message);
      msg.channel.send(
        "⚠️ 서버 일시중지에 실패했습니다. Docker 접근 권한 또는 컨테이너 상태를 확인해주세요."
      );
    }
  }

  if (content === "!재시작") {
    console.log("[command] !재시작 requested.");
    try {
      await docker("docker restart palworld-server");
      console.log("[command] !재시작: restart succeeded.");
      lastActive = Date.now();
      idleWarningSentSinceStartup = false;
      msg.channel.send("🔁 서버 재시작 완료");
    } catch (err) {
      console.log("[command] !재시작: restart failed:", err.message);
      msg.channel.send(
        "⚠️ 서버 재시작에 실패했습니다. Docker 접근 권한 또는 컨테이너 상태를 확인해주세요."
      );
    }
  }

  if (content === "!상태") {
    console.log("[command] !상태 requested.");
    const paused = await isPaused();
    if (paused) {
      console.log("[command] !상태: server is paused.");
      return msg.reply("🟡 상태: 일시중지");
    }

    const snapshot = await getPlayersSnapshot("status");
    if (!snapshot.ok) {
      return msg.reply("⚠️ 접속자 정보를 조회할 수 없습니다. API 상태를 확인해주세요.");
    }
    console.log(
      "[command] !상태: server running. players:",
      snapshot.count
    );
    msg.reply(`🟢 실행 중 | 접속자 ${snapshot.count}명`);
  }

  if (content === "!접속자") {
    console.log("[command] !접속자 requested.");
    const paused = await isPaused();
    if (paused) {
      console.log("[command] !접속자: server is paused.");
      return msg.reply("현재 접속자 없음 (서버가 일시중지 상태입니다.)");
    }

    const snapshot = await getPlayersSnapshot("players-command");
    if (!snapshot.ok) {
      return msg.reply("⚠️ 접속자 정보를 조회할 수 없습니다. API 상태를 확인해주세요.");
    }

    if (snapshot.count === 0) {
      console.log("[command] !접속자: no players online.");
      return msg.reply("현재 접속자 없음");
    }

    if (snapshot.players.length === 0) {
      console.log(
        "[command] !접속자: count only response. count:",
        snapshot.count
      );
      return msg.reply(
        `현재 접속자 ${snapshot.count}명 (이름 목록은 API에서 제공되지 않음)`
      );
    } else {
      console.log(
        "[command] !접속자: players online:",
        snapshot.players.map((p) => p.name)
      );
      return msg.reply(
        snapshot.players
          .map((p) => p.name || p.playerName || p.steamName || "(이름없음)")
          .join("\n")
      );
    }
  }
});

client.login(BOT_TOKEN);
