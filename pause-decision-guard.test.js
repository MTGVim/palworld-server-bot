const assert = require("node:assert/strict");
const { evaluateAutoPauseDecision } = require("./pause-decision-guard");

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    throw err;
  }
}

runTest("does not pause when refreshed player count is greater than zero", () => {
  const result = evaluateAutoPauseDecision({
    uptimeMs: 31 * 60 * 1000,
    thresholdMs: 30 * 60 * 1000,
    cachedPlayerCount: 0,
    refreshedPlayerCount: 2,
    recentSamples: [0, 2],
    lastNonZeroSeenAt: Date.now(),
    stableZeroRequiredSamples: 2,
  });

  assert.equal(result.shouldPause, false);
  assert.equal(result.reason, "ACTIVE_PLAYERS");
});

runTest("pauses when player count is stable zero", () => {
  const now = Date.now();
  const result = evaluateAutoPauseDecision({
    uptimeMs: 31 * 60 * 1000,
    thresholdMs: 30 * 60 * 1000,
    cachedPlayerCount: 0,
    refreshedPlayerCount: 0,
    recentSamples: [0, 0],
    lastNonZeroSeenAt: now - 5 * 60 * 1000,
    nowMs: now,
    stableZeroRequiredSamples: 2,
    nonZeroGraceMs: 20 * 1000,
  });

  assert.equal(result.shouldPause, true);
  assert.equal(result.reason, "NO_PLAYERS_STABLE");
});

runTest("does not pause during grace window after recent active players", () => {
  const now = Date.now();
  const result = evaluateAutoPauseDecision({
    uptimeMs: 31 * 60 * 1000,
    thresholdMs: 30 * 60 * 1000,
    cachedPlayerCount: 0,
    refreshedPlayerCount: 0,
    recentSamples: [0, 0],
    lastNonZeroSeenAt: now - 5 * 1000,
    nowMs: now,
    stableZeroRequiredSamples: 2,
    nonZeroGraceMs: 20 * 1000,
  });

  assert.equal(result.shouldPause, false);
  assert.equal(result.reason, "ACTIVE_PLAYERS_RECENTLY");
});

runTest("does not pause below protection threshold", () => {
  const result = evaluateAutoPauseDecision({
    uptimeMs: 29 * 60 * 1000,
    thresholdMs: 30 * 60 * 1000,
    cachedPlayerCount: 0,
    refreshedPlayerCount: 0,
    recentSamples: [0, 0],
    lastNonZeroSeenAt: null,
    stableZeroRequiredSamples: 2,
  });

  assert.equal(result.shouldPause, false);
  assert.equal(result.reason, "BELOW_THRESHOLD");
});
