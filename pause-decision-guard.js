function evaluateAutoPauseDecision(context) {
  const {
    uptimeMs,
    thresholdMs,
    cachedPlayerCount,
    refreshedPlayerCount,
    recentSamples,
    lastNonZeroSeenAt,
    nowMs = Date.now(),
    refreshedFetchOk = true,
    stableZeroRequiredSamples = 2,
    nonZeroGraceMs = 0,
  } = context;

  if (uptimeMs < thresholdMs) {
    return {
      shouldPause: false,
      reason: "BELOW_THRESHOLD",
      evidence: { uptimeMs, thresholdMs },
    };
  }

  if (!refreshedFetchOk) {
    return {
      shouldPause: false,
      reason: "STALE_STATE",
      evidence: { refreshedFetchOk },
    };
  }

  if (cachedPlayerCount > 0 || refreshedPlayerCount > 0) {
    return {
      shouldPause: false,
      reason: "ACTIVE_PLAYERS",
      evidence: { cachedPlayerCount, refreshedPlayerCount },
    };
  }

  if (
    lastNonZeroSeenAt &&
    nowMs - lastNonZeroSeenAt <= nonZeroGraceMs
  ) {
    return {
      shouldPause: false,
      reason: "ACTIVE_PLAYERS_RECENTLY",
      evidence: { lastNonZeroSeenAt, nonZeroGraceMs },
    };
  }

  const recent = Array.isArray(recentSamples) ? recentSamples : [];
  const stableZero = recent
    .slice(-stableZeroRequiredSamples)
    .every((value) => value === 0);

  if (recent.length < stableZeroRequiredSamples || !stableZero) {
    return {
      shouldPause: false,
      reason: "NO_PLAYERS_NOT_STABLE",
      evidence: {
        recentSamples: recent,
        stableZeroRequiredSamples,
      },
    };
  }

  return {
    shouldPause: true,
    reason: "NO_PLAYERS_STABLE",
    evidence: {
      recentSamples: recent,
      stableZeroRequiredSamples,
    },
  };
}

module.exports = {
  evaluateAutoPauseDecision,
};
