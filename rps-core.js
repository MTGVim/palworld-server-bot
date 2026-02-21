const path = require("path");

function normalizeRpsChoice(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value === "가위" || value === "scissors") return "가위";
  if (value === "바위" || value === "rock") return "바위";
  if (value === "보" || value === "paper") return "보";
  return "";
}

function evaluateRps(userChoice, botChoice) {
  if (userChoice === botChoice) return "무승부";
  if (
    (userChoice === "가위" && botChoice === "보") ||
    (userChoice === "바위" && botChoice === "가위") ||
    (userChoice === "보" && botChoice === "바위")
  ) {
    return "승리";
  }
  return "패배";
}

function getOrCreateRpsRecord(statsStore, userId) {
  if (!statsStore[userId] || typeof statsStore[userId] !== "object") {
    statsStore[userId] = {
      wins: 0,
      losses: 0,
      draws: 0,
      games: 0,
      updatedAt: new Date().toISOString(),
    };
  }

  const record = statsStore[userId];
  record.wins = Number.isFinite(record.wins) ? record.wins : 0;
  record.losses = Number.isFinite(record.losses) ? record.losses : 0;
  record.draws = Number.isFinite(record.draws) ? record.draws : 0;
  record.games = Number.isFinite(record.games) ? record.games : 0;
  return record;
}

function createRpsPersistence({ fs, statsPath, logInterval, logger }) {
  let writeQueue = Promise.resolve();
  let writeCount = 0;

  async function persist(statsStore) {
    const snapshot = JSON.stringify(statsStore, null, 2);
    const dir = path.dirname(statsPath);
    const tempPath = `${statsPath}.tmp`;

    writeQueue = writeQueue
      .then(async () => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(tempPath, snapshot, "utf8");
        await fs.rename(tempPath, statsPath);
        writeCount += 1;
        if (
          writeCount === 1 ||
          (Number.isFinite(logInterval) &&
            logInterval > 0 &&
            writeCount % logInterval === 0)
        ) {
          logger(
            `[rps][OK] 전적 저장 성공: path=${statsPath} writes=${writeCount} bytes=${Buffer.byteLength(snapshot, "utf8")}`
          );
        }
      })
      .catch((err) => {
        logger(
          `[rps][WARN] 전적 저장 실패: ${err.message} | path: ${statsPath}`
        );
      });

    await writeQueue;
  }

  return {
    persist,
    getWriteCount: () => writeCount,
  };
}

module.exports = {
  createRpsPersistence,
  evaluateRps,
  getOrCreateRpsRecord,
  normalizeRpsChoice,
};
