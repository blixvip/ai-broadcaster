import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../telemetry.js', import.meta.url), 'utf8');
vm.runInThisContext(source, { filename: 'telemetry.js' });
const telemetry = globalThis.AIBTelemetry;

test('attempt metrics are aggregate-only and deduplicated by attempt ID', () => {
  let snapshot = telemetry.emptySnapshot();
  const event = {
    attemptId: 'delivery:panel:1',
    providerKey: 'gemini',
    hostname: 'gemini.google.com',
    outcome: 'verified',
    reason: 'user_turn_matched',
    actionKind: 'click',
    acceptanceMs: 820,
    inputReadyMs: 120,
    inputSelector: '.ql-editor[contenteditable="true"]',
    submitSelector: 'button.send-button'
  };

  let result = telemetry.applyAttempt(snapshot, event);
  snapshot = result.snapshot;
  assert.equal(result.recorded, true);
  result = telemetry.applyAttempt(snapshot, event);
  assert.equal(result.recorded, false);
  assert.equal(snapshot.totals.attempts, 1);
  assert.equal(snapshot.providers.gemini.verified, 1);
  assert.equal(snapshot.providers.gemini.acceptance.totalMs, 820);
  assert.equal(snapshot.providers.gemini.inputStrategies['.ql-editor[contenteditable="true"]'], 1);
});

test('retry attempts and failure reasons are counted without storing prompt content', () => {
  let snapshot = telemetry.emptySnapshot();
  snapshot = telemetry.applyAttempt(snapshot, {
    attemptId: 'delivery:panel:2',
    providerKey: 'venice',
    hostname: 'venice.ai',
    outcome: 'failed',
    reason: 'no_input:venice.ai'
  }).snapshot;

  const provider = snapshot.providers.venice;
  assert.equal(provider.attempts, 1);
  assert.equal(provider.retries, 1);
  assert.equal(provider.reasons['no_input:venice.ai'], 1);
  assert.equal(JSON.stringify(snapshot).includes('prompt'), false);
});

test('explicit non-retry attempts are not inferred from their numeric suffix', () => {
  let snapshot = telemetry.emptySnapshot();
  snapshot = telemetry.applyAttempt(snapshot, {
    attemptId: 'new-delivery:panel:3',
    isRetry: false,
    providerKey: 'gemini',
    outcome: 'verified',
    reason: 'user_turn_matched'
  }).snapshot;
  assert.equal(snapshot.providers.gemini.retries, 0);
});

test('response completion latency is recorded once', () => {
  let snapshot = telemetry.emptySnapshot();
  let result = telemetry.applyResponseComplete(snapshot, {
    attemptId: 'delivery:panel:1',
    providerKey: 'deepseek',
    hostname: 'chat.deepseek.com',
    responseMs: 4200
  });
  snapshot = result.snapshot;
  assert.equal(result.recorded, true);
  result = telemetry.applyResponseComplete(snapshot, {
    attemptId: 'delivery:panel:1',
    providerKey: 'deepseek',
    responseMs: 5000
  });
  assert.equal(result.recorded, false);
  assert.equal(snapshot.providers.deepseek.response.samples, 1);
  assert.equal(snapshot.providers.deepseek.response.totalMs, 4200);
});

test('smart ranking favors reliable providers while retaining usage data', () => {
  let snapshot = telemetry.emptySnapshot();
  for (let index = 0; index < 5; index += 1) {
    snapshot = telemetry.applyAttempt(snapshot, {
      attemptId: `good:${index}:1`, providerKey: 'good', outcome: 'verified',
      reason: 'user_turn_matched', acceptanceMs: 500
    }).snapshot;
    snapshot = telemetry.applyAttempt(snapshot, {
      attemptId: `bad:${index}:1`, providerKey: 'bad', outcome: 'failed',
      reason: 'no_input'
    }).snapshot;
  }

  const ranking = telemetry.rankProviders(snapshot);
  assert.equal(ranking[0].id, 'good');
  assert.ok(ranking[0].smartScore > ranking[1].smartScore);
});

test('public export omits internal attempt dedupe identifiers', () => {
  let snapshot = telemetry.emptySnapshot();
  snapshot = telemetry.applyAttempt(snapshot, {
    attemptId: 'private-attempt-id', providerKey: 'gemini', outcome: 'failed', reason: 'no_input'
  }).snapshot;
  const exported = telemetry.publicSnapshot(snapshot);
  assert.equal('recentAttemptIds' in exported, false);
  assert.equal('completedAttemptIds' in exported, false);
});
