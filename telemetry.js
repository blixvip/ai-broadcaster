'use strict';

(function initTelemetry(global) {
  const VERSION = 1;
  const STORAGE_KEY = 'aib_telemetry_v1';
  const RECENT_ID_LIMIT = 128;
  const DIMENSION_LIMIT = 32;

  function emptySnapshot() {
    return {
      version: VERSION,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      totals: {
        attempts: 0,
        verified: 0,
        unverified: 0,
        failed: 0,
        responseSamples: 0
      },
      providers: {},
      recentAttemptIds: [],
      completedAttemptIds: []
    };
  }

  function normalizeSnapshot(value) {
    const snapshot = value && typeof value === 'object' ? value : emptySnapshot();
    snapshot.version = VERSION;
    snapshot.createdAt = Number(snapshot.createdAt) || Date.now();
    snapshot.updatedAt = Number(snapshot.updatedAt) || Date.now();
    snapshot.totals = snapshot.totals && typeof snapshot.totals === 'object'
      ? snapshot.totals
      : emptySnapshot().totals;
    for (const key of ['attempts', 'verified', 'unverified', 'failed', 'responseSamples']) {
      snapshot.totals[key] = Number(snapshot.totals[key]) || 0;
    }
    snapshot.providers = snapshot.providers && typeof snapshot.providers === 'object'
      ? snapshot.providers
      : {};
    snapshot.recentAttemptIds = Array.isArray(snapshot.recentAttemptIds)
      ? snapshot.recentAttemptIds.slice(-RECENT_ID_LIMIT)
      : [];
    snapshot.completedAttemptIds = Array.isArray(snapshot.completedAttemptIds)
      ? snapshot.completedAttemptIds.slice(-RECENT_ID_LIMIT)
      : [];
    return snapshot;
  }

  function clean(value, limit = 160) {
    return String(value || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit);
  }

  function providerId(event) {
    return clean(event.providerKey || event.hostname || 'unknown', 80) || 'unknown';
  }

  function createProvider(event) {
    return {
      providerKey: clean(event.providerKey, 80),
      hostname: clean(event.hostname, 255),
      attempts: 0,
      verified: 0,
      unverified: 0,
      failed: 0,
      retries: 0,
      acceptance: { samples: 0, totalMs: 0, minMs: null, maxMs: null },
      response: { samples: 0, totalMs: 0, minMs: null, maxMs: null },
      input: { samples: 0, totalMs: 0 },
      reasons: {},
      inputStrategies: {},
      submitStrategies: {},
      actionKinds: {},
      lastOutcome: '',
      lastReason: '',
      lastUsedAt: null,
      lastVerifiedAt: null
    };
  }

  function incrementDimension(target, rawKey) {
    const key = clean(rawKey || 'unknown', 140) || 'unknown';
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      target[key] += 1;
      return;
    }
    if (Object.keys(target).length < DIMENSION_LIMIT) {
      target[key] = 1;
      return;
    }
    target.other = (target.other || 0) + 1;
  }

  function addSample(metric, value) {
    const sample = Math.max(0, Math.round(Number(value) || 0));
    if (!sample) return;
    metric.samples += 1;
    metric.totalMs += sample;
    metric.minMs = metric.minMs == null ? sample : Math.min(metric.minMs, sample);
    metric.maxMs = metric.maxMs == null ? sample : Math.max(metric.maxMs, sample);
  }

  function isRetryAttempt(attemptId) {
    const match = /:(\d+)$/.exec(String(attemptId || ''));
    return !!match && Number(match[1]) > 1;
  }

  function rememberId(list, id) {
    if (!id) return;
    list.push(id);
    if (list.length > RECENT_ID_LIMIT) list.splice(0, list.length - RECENT_ID_LIMIT);
  }

  function applyAttempt(snapshotValue, event = {}) {
    const snapshot = normalizeSnapshot(snapshotValue);
    const attemptId = clean(event.attemptId, 220);
    if (attemptId && snapshot.recentAttemptIds.includes(attemptId)) {
      return { snapshot, recorded: false };
    }

    const id = providerId(event);
    const provider = snapshot.providers[id] || createProvider(event);
    snapshot.providers[id] = provider;
    provider.providerKey = clean(event.providerKey || provider.providerKey, 80);
    provider.hostname = clean(event.hostname || provider.hostname, 255);

    const outcome = ['verified', 'unverified', 'failed'].includes(event.outcome)
      ? event.outcome
      : 'failed';
    const reason = clean(event.reason || outcome, 120);
    provider.attempts += 1;
    provider[outcome] += 1;
    if (event.isRetry === true || (event.isRetry == null && isRetryAttempt(attemptId))) {
      provider.retries += 1;
    }
    provider.lastOutcome = outcome;
    provider.lastReason = reason;
    provider.lastUsedAt = Number(event.recordedAt) || Date.now();
    if (outcome === 'verified') provider.lastVerifiedAt = provider.lastUsedAt;

    snapshot.totals.attempts += 1;
    snapshot.totals[outcome] += 1;
    incrementDimension(provider.reasons, reason);
    incrementDimension(provider.actionKinds, event.actionKind || 'none');
    if (event.inputSelector) incrementDimension(provider.inputStrategies, event.inputSelector);
    if (event.submitSelector) incrementDimension(provider.submitStrategies, event.submitSelector);

    if (outcome === 'verified') addSample(provider.acceptance, event.acceptanceMs);
    const inputMs = Math.max(0, Math.round(Number(event.inputReadyMs) || 0));
    if (inputMs) {
      provider.input.samples += 1;
      provider.input.totalMs += inputMs;
    }

    rememberId(snapshot.recentAttemptIds, attemptId);
    snapshot.updatedAt = Date.now();
    return { snapshot, recorded: true };
  }

  function applyResponseComplete(snapshotValue, event = {}) {
    const snapshot = normalizeSnapshot(snapshotValue);
    const attemptId = clean(event.attemptId, 220);
    if (!attemptId || snapshot.completedAttemptIds.includes(attemptId)) {
      return { snapshot, recorded: false };
    }

    const id = providerId(event);
    const provider = snapshot.providers[id] || createProvider(event);
    snapshot.providers[id] = provider;
    provider.providerKey = clean(event.providerKey || provider.providerKey, 80);
    provider.hostname = clean(event.hostname || provider.hostname, 255);
    addSample(provider.response, event.responseMs);
    if (!provider.response.samples) return { snapshot, recorded: false };

    snapshot.totals.responseSamples += 1;
    rememberId(snapshot.completedAttemptIds, attemptId);
    snapshot.updatedAt = Date.now();
    return { snapshot, recorded: true };
  }

  function average(metric) {
    return metric?.samples ? metric.totalMs / metric.samples : null;
  }

  function rankProviders(snapshotValue) {
    const snapshot = normalizeSnapshot(snapshotValue);
    const providers = Object.entries(snapshot.providers).map(([id, provider]) => {
      const attempts = Number(provider.attempts) || 0;
      const verified = Number(provider.verified) || 0;
      const reliability = (verified + 2) / (attempts + 3);
      const responseAverageMs = average(provider.response);
      const acceptanceAverageMs = average(provider.acceptance);
      const latency = responseAverageMs || acceptanceAverageMs;
      const speed = latency == null ? 0.5 : Math.max(0, Math.min(1, 1 - latency / 120000));
      const usage = Math.min(1, Math.log2(attempts + 1) / 8);
      const smartScore = Math.round((reliability * 0.65 + speed * 0.25 + usage * 0.10) * 1000) / 10;
      return {
        id,
        ...provider,
        reliability,
        acceptanceAverageMs,
        responseAverageMs,
        smartScore
      };
    });
    return providers.sort((a, b) => b.smartScore - a.smartScore || b.attempts - a.attempts);
  }

  function publicSnapshot(snapshotValue) {
    const snapshot = normalizeSnapshot(snapshotValue);
    return {
      version: snapshot.version,
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.updatedAt,
      totals: { ...snapshot.totals },
      providers: structuredClone(snapshot.providers)
    };
  }

  global.AIBTelemetry = Object.freeze({
    VERSION,
    STORAGE_KEY,
    emptySnapshot,
    normalizeSnapshot,
    applyAttempt,
    applyResponseComplete,
    rankProviders,
    publicSnapshot
  });
})(globalThis);
