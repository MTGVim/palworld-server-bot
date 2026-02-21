const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  createRpsPersistence,
  evaluateRps,
  getOrCreateRpsRecord,
  normalizeRpsChoice,
} = require("./rps-core");

async function testNormalizeRpsChoice() {
  assert.strictEqual(normalizeRpsChoice("가위"), "가위");
  assert.strictEqual(normalizeRpsChoice(" Rock "), "바위");
  assert.strictEqual(normalizeRpsChoice("paper"), "보");
  assert.strictEqual(normalizeRpsChoice("unknown"), "");
  console.log("PASS normalizeRpsChoice");
}

async function testEvaluateRps() {
  assert.strictEqual(evaluateRps("가위", "보"), "승리");
  assert.strictEqual(evaluateRps("보", "가위"), "패배");
  assert.strictEqual(evaluateRps("바위", "바위"), "무승부");
  console.log("PASS evaluateRps");
}

async function testGetOrCreateRpsRecord() {
  const statsStore = {
    "123": {
      wins: Number.NaN,
      losses: undefined,
      draws: null,
      games: 5,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  };
  const existing = getOrCreateRpsRecord(statsStore, "123");
  assert.deepStrictEqual(existing, {
    wins: 0,
    losses: 0,
    draws: 0,
    games: 5,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const created = getOrCreateRpsRecord(statsStore, "456");
  assert.strictEqual(created.wins, 0);
  assert.strictEqual(created.losses, 0);
  assert.strictEqual(created.draws, 0);
  assert.strictEqual(created.games, 0);
  assert.strictEqual(typeof created.updatedAt, "string");
  console.log("PASS getOrCreateRpsRecord");
}

async function testPersistQueueSerializesWrites() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rps-persist-"));
  const statsPath = path.join(tempDir, "rps-stats.json");
  const logs = [];
  const persistence = createRpsPersistence({
    fs,
    statsPath,
    logInterval: 1,
    logger: (line) => logs.push(line),
  });

  const first = { u1: { wins: 1, losses: 0, draws: 0, games: 1 } };
  const second = { u1: { wins: 2, losses: 0, draws: 0, games: 2 } };

  await Promise.all([persistence.persist(first), persistence.persist(second)]);

  const raw = await fs.readFile(statsPath, "utf8");
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.u1.games, 2);
  assert.strictEqual(persistence.getWriteCount(), 2);
  assert.ok(logs.some((line) => line.includes("persist success")));
  console.log("PASS createRpsPersistence queue");
}

async function run() {
  await testNormalizeRpsChoice();
  await testEvaluateRps();
  await testGetOrCreateRpsRecord();
  await testPersistQueueSerializesWrites();
}

run().catch((err) => {
  console.error("FAIL rps-core tests:", err);
  process.exit(1);
});
