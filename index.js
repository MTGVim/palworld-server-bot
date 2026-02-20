const { Client, GatewayIntentBits } = require("discord.js");
const { exec } = require("child_process");
const packageJson = require("./package.json");
const { evaluateAutoPauseDecision } = require("./pause-decision-guard");

const bootTime = Date.now();

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const SERVER_URL = process.env.SERVER_URL;
const PASSWORD = process.env.ADMIN_PASSWORD;

const AUTO_PAUSE_TIMEOUT = parseInt(process.env.AUTO_PAUSE_TIMEOUT || "300", 10);
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || "10000", 10);
const WAKE_PROTECTION_MINUTES = parseInt(
  process.env.WAKE_PROTECTION_MINUTES || "30",
  10
);
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
const BUILD_COMMIT_AT = process.env.BUILD_COMMIT_AT || "unknown";

const AUTH =
  "Basic " + Buffer.from("admin:" + PASSWORD).toString("base64");

let lastActive = Date.now();
let pauseProtectionUntil = 0;
let botChannel = null;
let lastNonZeroSeenAt = null;
const recentPlayerCounts = [];
let lastIdleWarningAt = 0;

function getVersionInfo() {
  return `v${packageJson.version} | commitAt: ${BUILD_COMMIT_AT}`;
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
      3000
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
    const players = Array.isArray(d.players) ? d.players : [];
    console.log(
      `[${logPrefix}] fetched players:`,
      players.length
    );
    return {
      ok: true,
      players,
      count: players.length,
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

    if (Date.now() < pauseProtectionUntil) {
      console.log(
        "[loop] wake protection active. auto pause disabled this cycle.",
        "until:",
        new Date(pauseProtectionUntil).toISOString()
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
        thresholdMs: WAKE_PROTECTION_MINUTES * 60 * 1000,
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
  console.log("[version]", getVersionInfo());
});

client.on("error", (err) => {
  console.log("디스코드 오류:", err.message);
});

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;

  if (!botChannel) botChannel = msg.channel;

  console.log(
    "[command] received message:",
    msg.content,
    "| from:",
    `${msg.author.username}#${msg.author.discriminator}`
  );

  if (msg.content === "!도움") {
    msg.reply(
      "📌 사용 가능한 명령어\n" +
        "!기동\n!일시중지\n!재시작\n!상태\n!접속자\n!버전"
    );
  }

  if (msg.content === "!버전") {
    msg.reply(`🏷️ ${getVersionInfo()}`);
  }

  if (msg.content === "!기동") {
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
      pauseProtectionUntil =
        Date.now() + WAKE_PROTECTION_MINUTES * 60 * 1000;

      msg.channel.send(
        `🟢 서버 기동 완료. ${WAKE_PROTECTION_MINUTES}분간 자동 보호 적용.`
      );
    } catch (err) {
      console.log("[command] !기동: unpause failed:", err.message);
      msg.channel.send(
        "⚠️ 서버 기동에 실패했습니다. Docker 접근 권한 또는 컨테이너 상태를 확인해주세요."
      );
    }
  }

  if (msg.content === "!일시중지") {
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

  if (msg.content === "!재시작") {
    console.log("[command] !재시작 requested.");
    try {
      await docker("docker restart palworld-server");
      console.log("[command] !재시작: restart succeeded.");
      lastActive = Date.now();
      lastIdleWarningAt = 0;
      pauseProtectionUntil =
        Date.now() + WAKE_PROTECTION_MINUTES * 60 * 1000;
      msg.channel.send("🔁 서버 재시작 완료");
    } catch (err) {
      console.log("[command] !재시작: restart failed:", err.message);
      msg.channel.send(
        "⚠️ 서버 재시작에 실패했습니다. Docker 접근 권한 또는 컨테이너 상태를 확인해주세요."
      );
    }
  }

  if (msg.content === "!상태") {
    console.log("[command] !상태 requested.");
    const paused = await isPaused();
    if (paused) {
      console.log("[command] !상태: server is paused.");
      return msg.reply("🟡 상태: 일시중지");
    }

    const players = await getPlayers();
    console.log(
      "[command] !상태: server running. players:",
      players.length
    );
    msg.reply(`🟢 실행 중 | 접속자 ${players.length}명`);
  }

  if (msg.content === "!접속자") {
    console.log("[command] !접속자 requested.");
    const players = await getPlayers();
    if (players.length === 0) {
      console.log("[command] !접속자: no players online.");
      msg.reply("현재 접속자 없음");
    } else {
      console.log(
        "[command] !접속자: players online:",
        players.map((p) => p.name)
      );
      msg.reply(players.map((p) => p.name).join("\n"));
    }
  }
});

client.login(BOT_TOKEN);
