import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../delivery-protocol.js', import.meta.url), 'utf8');
vm.runInThisContext(source, { filename: 'delivery-protocol.js' });
const protocol = globalThis.AIBDeliveryProtocol;

const BASELINE = {
  url: 'https://provider.example/chat',
  userTurns: 2,
  matchingUserTurns: 0,
  imageUserTurns: 0,
  assistantCount: 2,
  assistantText: 'previous answer',
  stopVisible: false,
  composerConnected: true,
  composerContainsText: true,
  attachments: 1
};

test('matching user turn is strong verified evidence', () => {
  const evidence = protocol.diffEvidenceSnapshots(BASELINE, {
    ...BASELINE,
    userTurns: 3,
    matchingUserTurns: 1,
    composerContainsText: false
  }, { hasText: true, hasImages: false });

  assert.equal(protocol.classifyEvidence(evidence).outcome, 'verified');
  assert.equal(protocol.classifyEvidence(evidence).reason, 'user_turn_matched');
});

test('preexisting matching turn does not verify without a count increase', () => {
  const baseline = { ...BASELINE, matchingUserTurns: 1 };
  const evidence = protocol.diffEvidenceSnapshots(baseline, {
    ...baseline,
    composerContainsText: false
  }, { hasText: true, hasImages: false });

  assert.deepEqual(protocol.classifyEvidence(evidence), {
    outcome: 'unverified',
    confidence: 'weak',
    reason: 'weak_evidence_only'
  });
});

test('new stop control proves generation started only when absent at baseline', () => {
  const evidence = protocol.diffEvidenceSnapshots(BASELINE, {
    ...BASELINE,
    stopVisible: true
  }, { hasText: true, hasImages: false });
  assert.equal(protocol.classifyEvidence(evidence).reason, 'generation_started');

  const alreadyGenerating = protocol.diffEvidenceSnapshots(
    { ...BASELINE, stopVisible: true },
    { ...BASELINE, stopVisible: true },
    { hasText: true, hasImages: false }
  );
  assert.equal(protocol.classifyEvidence(alreadyGenerating).outcome, 'unverified');
});

test('new image-bearing user turn verifies image-only delivery', () => {
  const evidence = protocol.diffEvidenceSnapshots(BASELINE, {
    ...BASELINE,
    userTurns: 3,
    imageUserTurns: 1,
    attachments: 0
  }, { hasText: false, hasImages: true });
  assert.equal(protocol.classifyEvidence(evidence).reason, 'image_user_turn');
});

test('composer clear, route change, and attachment consumption remain weak', () => {
  const evidence = protocol.diffEvidenceSnapshots(BASELINE, {
    ...BASELINE,
    url: 'https://provider.example/chat/2',
    composerContainsText: false,
    attachments: 0
  }, { hasText: true, hasImages: true });
  const result = protocol.classifyEvidence(evidence);
  assert.equal(result.outcome, 'unverified');
  assert.equal(result.confidence, 'weak');
});

test('no evidence times out honestly', () => {
  assert.deepEqual(protocol.classifyEvidence([]), {
    outcome: 'unverified',
    confidence: 'none',
    reason: 'evidence_timeout'
  });
});

test('retry is safe only before dispatch and before attachment mutation', () => {
  assert.deepEqual(protocol.deriveRetrySafety({ reason: 'login_required' }), {
    safe: true,
    reason: 'no_submit_action_dispatched'
  });
  assert.equal(protocol.deriveRetrySafety({
    actionDispatched: true,
    reason: 'evidence_timeout'
  }).safe, false);
  assert.equal(protocol.deriveRetrySafety({
    reason: 'image_not_ready',
    attachmentsMutated: true
  }).safe, false);
});

test('delivery aggregation distinguishes verified, partial, and no-target outcomes', () => {
  const expected = [{ panelId: 'a' }, { panelId: 'b' }];
  const verified = id => ({ panelId: id, attempt: { outcome: 'verified' } });
  const failed = id => ({ panelId: id, attempt: { outcome: 'failed' } });

  assert.equal(protocol.summarizeDelivery([verified('a'), verified('b')], expected).outcome, 'verified');
  assert.equal(protocol.summarizeDelivery([verified('a'), failed('b')], expected).outcome, 'partial');
  assert.equal(protocol.summarizeDelivery([], expected).outcome, 'no_targets');
  assert.equal(protocol.summarizeDelivery([], []).outcome, 'no_targets');
});

test('attachment validation accepts images and PDFs within bounded limits', () => {
  const attachments = [
    { base64: 'data:image/png;base64,AA==', type: 'image/png', size: 1 },
    { base64: 'data:application/pdf;base64,JVBERg==', type: 'application/pdf', size: 4 }
  ];
  assert.deepEqual(protocol.validateAttachments(attachments), {
    ok: true,
    reason: '',
    count: 2,
    totalBytes: 5
  });
});

test('attachment validation rejects unsupported, oversized, and excessive payloads', () => {
  assert.equal(protocol.validateAttachments([
    { base64: 'data:text/plain;base64,QQ==', type: 'text/plain', size: 1 }
  ]).reason, 'unsupported_attachment_type');

  assert.equal(protocol.validateAttachments([
    { base64: 'data:image/png;base64,AA==', type: 'image/png', size: protocol.ATTACHMENT_LIMITS.maxFileBytes + 1 }
  ]).reason, 'attachment_too_large');

  const tooMany = Array.from({ length: protocol.ATTACHMENT_LIMITS.maxCount + 1 }, () => ({
    base64: 'data:image/png;base64,AA==', type: 'image/png', size: 1
  }));
  assert.equal(protocol.validateAttachments(tooMany).reason, 'too_many_attachments');
});

test('generic attachment-bearing user turn is strong evidence', () => {
  const evidence = protocol.diffEvidenceSnapshots(BASELINE, {
    ...BASELINE,
    userTurns: 3,
    imageUserTurns: 1
  }, { hasText: false, hasAttachments: true });
  assert.equal(protocol.classifyEvidence(evidence).reason, 'attachment_user_turn');
});
