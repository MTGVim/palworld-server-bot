const { Client, GatewayIntentBits } = require("discord.js");
const { exec } = require("child_process");

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

const AUTH =
  "Basic " + Buffer.from("admin:" + PASSWORD).toString("base64");

let lastActive = Date.now();
let pauseProtectionUntil = 0;
let botChannel = null;

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
  try {
    const r = await fetchWithTimeout(
      SERVER_URL + "/v1/api/players",
      { headers: { Authorization: AUTH } },
      3000
    );
    if (!r.ok) {
      console.log(
        "[players] failed to fetch players. status:",
        r.status,
        r.statusText
      );
      return [];
    }
    const d = await r.json();
    console.log(
      "[players] fetched players:",
      Array.isArray(d.players) ? d.players.length : 0
    );
    return d.players || [];
  } catch (err) {
    console.log("[players] error while fetching players:", err.message);
    return [];
  }
}

async function sendRestartNotice() {
    const elapsed = ((Date.now() - bootTime) / 1000).toFixed(2);
  
    console.log(`Logged in as ${client.user.tag}`);
    console.log(`Startup time: ${elapsed}s`);
  
    const webhook = process.env.RESTART_WEBHOOK_URL;
    if (!webhook) return;
  
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `🔄 palbot 업데이트 완료 (${elapsed}초 소요)`
        })
      });
    } catch (err) {
      console.error("Webhook 전송 실패:", err);
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

    if (Date.now() < pauseProtectionUntil) {
      console.log(
        "[loop] wake protection active. skipping auto pause.",
        "until:",
        new Date(pauseProtectionUntil).toISOString()
      );
      return;
    }

    const players = await getPlayers();
    const now = Date.now();

    if (players.length > 0) {
      console.log(
        "[loop] players online. count:",
        players.length,
        "resetting idle timer."
      );
      lastActive = now;
      return;
    }

    const idleSeconds = Math.floor((now - lastActive) / 1000);

    if (idleSeconds >= AUTO_PAUSE_TIMEOUT) {
      console.log(
        "[loop] idle timeout reached. seconds:",
        idleSeconds,
        "threshold:",
        AUTO_PAUSE_TIMEOUT
      );
      try {
        await docker("docker pause palworld-server");
        console.log("[loop] auto pause succeeded.");
        if (botChannel) {
          botChannel.send(
            `🟡 서버가 자동으로 일시중지되었습니다. (${idleSeconds}초간 접속자 없음)`
          );
        }
      } catch (err) {
        console.log("[loop] auto pause failed:", err.message);
        if (botChannel) {
          botChannel.send(
            "⚠️ 자동 일시중지에 실패했습니다. 관리자에게 확인이 필요합니다."
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

client.once("ready", async () => {
  console.log(`Logged in as ${client.user.username}`);
  await sendRestartNotice();
});

client.on("clientReady", () => {
  console.log("봇 준비 완료");
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
        "!기동\n!일시중지\n!재시작\n!상태\n!접속자"
    );
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
