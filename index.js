const { Client, GatewayIntentBits } = require("discord.js");
const { exec } = require("child_process");
const fs = require("fs/promises");
const path = require("path");
const { evaluateIdleWarningDecision } = require("./idle-warning-decision");

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
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

function normalizeChannelId(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return "";
  }
  const cleaned = raw.replace(/^<#[!#]?\d+>$/g, (match) => (
    match.replace("<#", "").replace(">", "")
  ));
  return cleaned.trim().replace(/[\s,]+/g, "");
}

function resolveAllowedChannelIds() {
  const candidates = [];

  const primary = normalizeChannelId(process.env.ALLOWED_CHANNEL_ID || "");
  if (primary) {
    candidates.push(...primary.split(",").map((value) => value.trim()).filter(Boolean));
  }

  if (candidates.length === 0) {
    const legacyRaw = String(process.env.ALLOWED_CHANNEL_IDS || "")
      .split(",")
      .map((value) => normalizeChannelId(value))
      .filter(Boolean);
    if (legacyRaw.length > 0) {
      candidates.push(...legacyRaw);
      console.log("[config] ALLOWED_CHANNEL_ID 미설정. ALLOWED_CHANNEL_IDS에서 채널을 fallback으로 사용합니다.");
    }
  }

  const allowedSet = new Set(candidates);
  if (allowedSet.size === 0) {
    console.log("[config] 허용 채널 미설정: 모든 채널 허용 모드");
  } else {
    console.log(`[config] allowed channels: ${Array.from(allowedSet).join(",")}`);
  }

  return allowedSet;
}

const ALLOWED_CHANNEL_SET = resolveAllowedChannelIds();
function isAllowedChannel(channelId) {
  return ALLOWED_CHANNEL_SET.size === 0 || ALLOWED_CHANNEL_SET.has(channelId);
}
function getPrimaryAllowedChannelId() {
  return ALLOWED_CHANNEL_SET.size > 0 ? ALLOWED_CHANNEL_SET.values().next().value : "";
}
const WATCHTOWER_IMAGE = (process.env.WATCHTOWER_IMAGE || "containrrr/watchtower:latest").trim();
const WATCHTOWER_SCOPE = (process.env.WATCHTOWER_SCOPE || "palworld-server-bot").trim();
const WATCHTOWER_UPDATE_TIMEOUT_MS = parseInt(process.env.WATCHTOWER_UPDATE_TIMEOUT_MS || "180000", 10);
const BOT_IMAGE_REF = (process.env.BOT_IMAGE_REF || "ghcr.io/mtgvim/palworld-server-bot:latest").trim();

const AUTH =
  "Basic " + Buffer.from("admin:" + PASSWORD).toString("base64");

let lastActive = Date.now();
let botChannel = null;
let lastNonZeroSeenAt = null;
const recentPlayerCounts = [];
let idleWarningSentSinceStartup = false;
let updateInProgress = false;
let loopPausedNoticeShown = false;

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

function dockerWithTimeout(cmd, timeoutMs = WATCHTOWER_UPDATE_TIMEOUT_MS) {
  console.log("[docker] executing command with timeout:", cmd, "| timeoutMs:", timeoutMs);
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: timeoutMs }, (err) => {
      if (err) {
        const timedOut = err.killed || err.signal === "SIGTERM" || /timed out/i.test(err.message || "");
        console.log(
          "[docker] command with timeout failed:",
          cmd,
          "| timeout:",
          timedOut ? "true" : "false",
          "| error:",
          err.message
        );
        if (timedOut) {
          reject(new Error("업데이트 명령이 3분 안에 완료되지 않아 중단되었습니다."));
        } else {
          reject(err);
        }
      } else {
        console.log("[docker] command with timeout succeeded:", cmd);
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

function isSafeWatchtowerScope(value) {
  return /^[A-Za-z0-9._-]+$/.test(value);
}

function isAuthorizedUpdater(userId) {
  const adminAuth = requireAdminAuthorization(userId);
  if (!adminAuth.ok) {
    return adminAuth;
  }
  return { ok: true };
}

function requireAdminAuthorization(userId) {
  if (ADMIN_USER_IDS.length === 0) {
    return {
      ok: false,
      message:
        "⚠️ 관리자 권한자가 설정되지 않았습니다. `ADMIN_USER_IDS`에 Discord 사용자 ID를 지정해주세요.",
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
    `- Revision: ${shortRevision(versionInfo.revision)}\n` +
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
    `- Revision: ${shortRevision(versionInfo.revision)}\n` +
    `\n\n${getAvailableCommandsMessage()}`
  );
}

function formatUpdateSummaryMessage(versionInfo) {
  if (!versionInfo.ok) {
    return `업데이트 확인이 완료되었습니다.\n정보: ${versionInfo.message}`;
  }

  return (
    "업데이트 확인이 완료되었습니다.\n" +
    `- Created: ${formatCreatedAtSeoul(versionInfo.createdAt)}\n` +
    `- Revision: ${shortRevision(versionInfo.revision)}`
  );
}

function formatAvailableCommands(commands) {
  return (
    "📌 사용 가능한 명령어\n" +
    commands
      .map(({ command, description }) => `- \`${command}\` : ${description}`)
      .join("\n")
  );
}

function getAvailableCommandsMessage() {
  const commands = [
    { command: "!도움", description: "명령어 목록" },
    { command: "!기동", description: "서버 기동" },
    { command: "!일시중지", description: "서버 일시중지" },
    { command: "!재시작", description: "서버 재시작" },
    { command: "!상태", description: "서버 상태 조회" },
    { command: "!접속자", description: "접속자 목록 조회" },
    { command: "!봇 버전", description: "봇 이미지 정보 조회" },
    { command: "!봇 업데이트", description: "봇 최신 버전 업데이트" },
  ];
  return formatAvailableCommands(commands);
}

function shortRevision(revision) {
  const value = String(revision || "").trim();
  if (!value || value === "(unknown)") return value || "(unknown)";
  if (/^[a-f0-9]{7,}$/i.test(value)) {
    return value.slice(0, 7);
  }
  return value;
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

function getWatchtowerRunOnceCommand() {
  if (!isSafeDockerRef(WATCHTOWER_IMAGE)) {
    throw new Error(
      "WATCHTOWER_IMAGE 값이 안전하지 않습니다. 영문/숫자/._:@/- 문자만 사용해주세요."
    );
  }
  if (!isSafeWatchtowerScope(WATCHTOWER_SCOPE)) {
    throw new Error(
      "WATCHTOWER_SCOPE 값이 안전하지 않습니다. 영문/숫자/._- 문자만 사용해주세요."
    );
  }

  return (
    "docker run --rm " +
    "-v /var/run/docker.sock:/var/run/docker.sock " +
    `${WATCHTOWER_IMAGE} ` +
    `--run-once --cleanup --label-enable --scope ${WATCHTOWER_SCOPE}`
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
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on("ready", async () => {
  console.log("봇 준비 완료");
  const versionInfo = await getBotVersionInfo();
  console.log("[version] ready info:", formatBootVersionMessage(versionInfo));

  const allowedChannelId = getPrimaryAllowedChannelId();
  if (!allowedChannelId) {
    return;
  }

  try {
    const statusChannel = await client.channels.fetch(allowedChannelId);
    if (!statusChannel || !statusChannel.isTextBased()) {
      console.log("[version] allowed channel is not a text channel.");
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
  if (!isAllowedChannel(msg.channelId)) return;
  const content = msg.content.trim();

  if (!botChannel) botChannel = msg.channel;

  if (content === "!도움") {
    msg.reply(getAvailableCommandsMessage());
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
    await msg.reply("🔄 봇 이미지 업데이트 확인을 시작하고 봇을 재시작합니다.");

    try {
      const runOnceCommand = getWatchtowerRunOnceCommand();
      await dockerWithTimeout(runOnceCommand);
      const versionInfo = await getBotVersionInfo();
      await msg.channel.send(
        `${formatUpdateSummaryMessage(versionInfo)}\n\n${getAvailableCommandsMessage()}`
      );
    } catch (err) {
      console.log("[command] !봇 업데이트 failed:", err.message);
      await msg.channel.send(
        `⚠️ 봇 업데이트 실행에 실패했습니다. ${err.message} (Docker 접근 권한, WATCHTOWER_IMAGE, 라벨 설정을 확인해주세요.)\n\n` +
        getAvailableCommandsMessage()
      );
    } finally {
      updateInProgress = false;
    }
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
