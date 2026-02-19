const { Client, GatewayIntentBits } = require("discord.js");
const { exec } = require("child_process");

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
  return new Promise((resolve, reject) => {
    exec(cmd, (err) => {
      if (err) reject(err);
      else resolve();
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
        if (err) resolve(false);
        else resolve(out.trim() === "true");
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
    if (!r.ok) return [];
    const d = await r.json();
    return d.players || [];
  } catch {
    return [];
  }
}

// 🔥 AUTO PAUSE LOOP
setInterval(async () => {
  try {
    const paused = await isPaused();
    if (paused) return;

    if (Date.now() < pauseProtectionUntil) return;

    const players = await getPlayers();
    const now = Date.now();

    if (players.length > 0) {
      lastActive = now;
      return;
    }

    const idleSeconds = Math.floor((now - lastActive) / 1000);

    if (idleSeconds >= AUTO_PAUSE_TIMEOUT) {
      await docker("docker pause palworld-server").catch(() => {});
      console.log("자동 일시중지 실행");

      if (botChannel) {
        botChannel.send(
          `🟡 서버가 자동으로 일시중지되었습니다. (${idleSeconds}초간 접속자 없음)`
        );
      }
    }
  } catch {
    console.log("루프 오류 무시");
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

  if (!botChannel) botChannel = msg.channel;

  if (msg.content === "!도움") {
    msg.reply(
      "📌 사용 가능한 명령어\n" +
        "!기동\n!일시중지\n!재시작\n!상태\n!접속자"
    );
  }

  if (msg.content === "!기동") {
    const paused = await isPaused();
    if (!paused) return msg.reply("🟢 이미 실행 중입니다.");

    await docker("docker unpause palworld-server").catch(() => {});

    lastActive = Date.now();
    pauseProtectionUntil =
      Date.now() + WAKE_PROTECTION_MINUTES * 60 * 1000;

    msg.channel.send(
      `🟢 서버 기동 완료. ${WAKE_PROTECTION_MINUTES}분간 자동 보호 적용.`
    );
  }

  if (msg.content === "!일시중지") {
    await docker("docker pause palworld-server").catch(() => {});
    msg.channel.send("🟡 서버가 일시중지되었습니다.");
  }

  if (msg.content === "!재시작") {
    await docker("docker restart palworld-server").catch(() => {});
    lastActive = Date.now();
    pauseProtectionUntil =
      Date.now() + WAKE_PROTECTION_MINUTES * 60 * 1000;
    msg.channel.send("🔁 서버 재시작 완료");
  }

  if (msg.content === "!상태") {
    const paused = await isPaused();
    if (paused) return msg.reply("🟡 상태: 일시중지");

    const players = await getPlayers();
    msg.reply(`🟢 실행 중 | 접속자 ${players.length}명`);
  }

  if (msg.content === "!접속자") {
    const players = await getPlayers();
    if (players.length === 0) {
      msg.reply("현재 접속자 없음");
    } else {
      msg.reply(players.map((p) => p.name).join("\n"));
    }
  }
});

client.login(BOT_TOKEN);
