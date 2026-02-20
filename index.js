const { Client, GatewayIntentBits } = require("discord.js");
const { exec } = require("child_process");
const { evaluateAutoPauseDecision } = require("./pause-decision-guard");

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
const IDLE_WARNING_COOLDOWN_SECONDS = parseInt(
  process.env.IDLE_WARNING_COOLDOWN_SECONDS || "300",
  10
);
const PLAYERS_API_TIMEOUT_MS = parseInt(
  process.env.PLAYERS_API_TIMEOUT_MS || "5000",
  10
);
const UPDATE_DELAY_SECONDS = parseInt(
  process.env.UPDATE_DELAY_SECONDS || "60",
  10
);
const UPDATE_COMPOSE_FILE = process.env.UPDATE_COMPOSE_FILE || "docker-compose.yml";
const UPDATE_SERVICE_NAME = process.env.UPDATE_SERVICE_NAME || "palbot";
const UPDATE_ALLOWED_USER_IDS = new Set(
  (process.env.UPDATE_ALLOWED_USER_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);
const UPDATE_ALLOWED_ROLE_IDS = new Set(
  (process.env.UPDATE_ALLOWED_ROLE_IDS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

const AUTH =
  "Basic " + Buffer.from("admin:" + PASSWORD).toString("base64");

let lastActive = Date.now();
let botChannel = null;
let lastNonZeroSeenAt = null;
const recentPlayerCounts = [];
let lastIdleWarningAt = 0;
let pendingUpdateJob = null;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function executeShell(cmd, timeout = 120000) {
  console.log("[shell] executing command:", cmd);
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      { timeout, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout || "";
          err.stderr = stderr || "";
          console.log("[shell] command failed:", err.message);
          return reject(err);
        }
        resolve({ stdout: stdout || "", stderr: stderr || "" });
      }
    );
  });
}

function hasUpdatePermission(msg) {
  const hasUserPolicy = UPDATE_ALLOWED_USER_IDS.size > 0;
  const hasRolePolicy = UPDATE_ALLOWED_ROLE_IDS.size > 0;
  if (!hasUserPolicy && !hasRolePolicy) {
    return false;
  }

  if (UPDATE_ALLOWED_USER_IDS.has(msg.author.id)) {
    return true;
  }

  if (hasRolePolicy && msg.member && msg.member.roles && msg.member.roles.cache) {
    for (const roleId of UPDATE_ALLOWED_ROLE_IDS) {
      if (msg.member.roles.cache.has(roleId)) {
        return true;
      }
    }
  }

  return false;
}

function summarizeExecError(err) {
  const lines = [err.message || "unknown error"];
  if (err.stderr) {
    lines.push(err.stderr.trim().split("\n").slice(-2).join(" | "));
  }
  return lines.filter(Boolean).join(" / ");
}

async function runSelfUpdate(channel) {
  const composeFile = shellQuote(UPDATE_COMPOSE_FILE);
  const serviceName = shellQuote(UPDATE_SERVICE_NAME);

  await channel.send(
    `🔄 업데이트 시작: service=\`${UPDATE_SERVICE_NAME}\`, compose=\`${UPDATE_COMPOSE_FILE}\``
  );

  await executeShell("docker compose version");
  await executeShell(`test -f ${composeFile}`);
  const servicesOut = await executeShell(
    `docker compose -f ${composeFile} config --services`
  );
  const services = servicesOut.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!services.includes(UPDATE_SERVICE_NAME)) {
    throw new Error(
      `service not found in compose file: ${UPDATE_SERVICE_NAME} (services=${services.join(",")})`
    );
  }

  await executeShell(`docker compose -f ${composeFile} pull ${serviceName}`);
  await channel.send("📦 pull 완료. 5초 후 recreate를 시작합니다.");
  await new Promise((resolve) => setTimeout(resolve, 5000));
  await executeShell(
    `docker compose -f ${composeFile} up -d --force-recreate ${serviceName}`
  );
}

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

async function isPaused() {
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
          console.log(
            "[status] palworld-server paused state:",
            paused ? "true" : "false"
          );
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
    const paused = await isPaused();
    if (paused) {
      console.log("[loop] palworld-server is already paused. skipping check.");
      return;
    }

    const snapshot = await getPlayersSnapshot("loop");
    const now = Date.now();

    if (snapshot.ok) {
      recordPlayerSample(snapshot.count);
      if (snapshot.count > 0) {
        lastActive = now;
        lastNonZeroSeenAt = now;
        lastIdleWarningAt = 0;
        console.log(
          "[loop] players online. count:",
          snapshot.count,
          "resetting idle timer."
        );
      }
    } else {
      console.log(
        "[loop] players fetch failed. skipping auto pause decision this cycle."
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
          "[loop] pre-pause verification failed. skipping auto pause."
        );
        return;
      }

      recordPlayerSample(verifySnapshot.count);
      if (verifySnapshot.count > 0) {
        lastActive = verifyNow;
        lastNonZeroSeenAt = verifyNow;
      }

      const decision = evaluateAutoPauseDecision({
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
        "[loop] pause decision:",
        decision.reason,
        JSON.stringify(decision.evidence)
      );
      if (!decision.shouldPause) {
        return;
      }

      console.log(
        "[loop] idle timeout reached. warning only. seconds:",
        idleSeconds,
        "threshold:",
        AUTO_PAUSE_TIMEOUT
      );
      const warningCooldownMs = IDLE_WARNING_COOLDOWN_SECONDS * 1000;
      if (verifyNow - lastIdleWarningAt >= warningCooldownMs) {
        lastIdleWarningAt = verifyNow;
        if (botChannel) {
          botChannel.send(
            `⚠️ ${idleSeconds}초 동안 접속자가 없습니다. 자동 일시중지는 비활성화되어 경고만 전송합니다.`
          );
        }
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

client.on("clientReady", () => {
  console.log("봇 준비 완료");
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
        "!기동\n!일시중지\n!재시작\n!상태\n!접속자\n!업데이트\n!업데이트취소"
    );
  }

  if (content === "!업데이트취소" || content === "!업데이트 취소") {
    if (!hasUpdatePermission(msg)) {
      return msg.reply("⛔ 업데이트 권한이 없습니다.");
    }
    if (!pendingUpdateJob) {
      return msg.reply("ℹ️ 예약된 업데이트가 없습니다.");
    }
    clearTimeout(pendingUpdateJob.timerId);
    const canceledBy = pendingUpdateJob.requestedBy;
    pendingUpdateJob = null;
    return msg.reply(`🛑 업데이트 예약이 취소되었습니다. (요청자: <@${canceledBy}>)`);
  }

  if (content === "!업데이트") {
    if (!hasUpdatePermission(msg)) {
      return msg.reply(
        "⛔ 업데이트 권한이 없습니다. UPDATE_ALLOWED_USER_IDS 또는 UPDATE_ALLOWED_ROLE_IDS를 설정하세요."
      );
    }

    if (pendingUpdateJob) {
      const remainSeconds = Math.max(
        0,
        Math.ceil((pendingUpdateJob.executeAt - Date.now()) / 1000)
      );
      return msg.reply(
        `⏳ 이미 업데이트가 예약되어 있습니다. ${remainSeconds}초 후 실행 예정`
      );
    }

    const executeAt = Date.now() + UPDATE_DELAY_SECONDS * 1000;
    const timerId = setTimeout(async () => {
      const job = pendingUpdateJob;
      pendingUpdateJob = null;
      if (!job) return;

      try {
        await runSelfUpdate(job.channel);
        await job.channel.send("✅ 업데이트 명령 실행 완료. 봇 재기동을 확인하세요.");
      } catch (err) {
        await job.channel.send(`❌ 업데이트 실패: ${summarizeExecError(err)}`);
      }
    }, UPDATE_DELAY_SECONDS * 1000);

    pendingUpdateJob = {
      timerId,
      executeAt,
      requestedBy: msg.author.id,
      channel: msg.channel,
    };

    return msg.reply(
      `🕒 업데이트를 ${UPDATE_DELAY_SECONDS}초 후 실행하도록 예약했습니다. 취소: !업데이트취소`
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
      lastIdleWarningAt = 0;

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
      lastIdleWarningAt = 0;
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
