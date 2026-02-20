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
const PLAYERS_API_TIMEOUT_MS = parseInt(
  process.env.PLAYERS_API_TIMEOUT_MS || "5000",
  10
);

const AUTH =
  "Basic " + Buffer.from("admin:" + PASSWORD).toString("base64");

let lastActive = Date.now();
let botChannel = null;
let lastNonZeroSeenAt = null;
const recentPlayerCounts = [];
let idleWarningSentSinceStartup = false;

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
        "!기동\n!일시중지\n!재시작\n!상태\n!접속자"
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
