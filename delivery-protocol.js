'use strict';

(function initDeliveryProtocol(global) {
  const VERSION = 1;
  const ATTACHMENT_LIMITS = Object.freeze({
    maxCount: 8,
    maxFileBytes: 20 * 1024 * 1024,
    maxTotalBytes: 48 * 1024 * 1024,
    allowedTypes: Object.freeze(['image/*', 'application/pdf'])
  });

  function estimatedDataUrlBytes(value) {
    const data = String(value || '');
    const comma = data.indexOf(',');
    const encoded = comma >= 0 ? data.slice(comma + 1) : data;
    return Math.max(0, Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0));
  }

  function attachmentTypeAllowed(type) {
    return String(type || '').toLowerCase() === 'application/pdf'
      || String(type || '').toLowerCase().startsWith('image/');
  }

  function validateAttachments(value) {
    const attachments = Array.isArray(value) ? value : [];
    if (attachments.length > ATTACHMENT_LIMITS.maxCount) {
      return { ok: false, reason: 'too_many_attachments', count: attachments.length, totalBytes: 0 };
    }

    let totalBytes = 0;
    for (const attachment of attachments) {
      if (!attachment?.base64 || !String(attachment.base64).startsWith('data:')) {
        return { ok: false, reason: 'invalid_attachment_data', count: attachments.length, totalBytes };
      }
      if (!attachmentTypeAllowed(attachment.type)) {
        return { ok: false, reason: 'unsupported_attachment_type', count: attachments.length, totalBytes };
      }
      const bytes = Number(attachment.size) || estimatedDataUrlBytes(attachment.base64);
      if (bytes > ATTACHMENT_LIMITS.maxFileBytes) {
        return { ok: false, reason: 'attachment_too_large', count: attachments.length, totalBytes: totalBytes + bytes };
      }
      totalBytes += bytes;
      if (totalBytes > ATTACHMENT_LIMITS.maxTotalBytes) {
        return { ok: false, reason: 'attachment_batch_too_large', count: attachments.length, totalBytes };
      }
    }

    return { ok: true, reason: '', count: attachments.length, totalBytes };
  }

  const STRONG_EVIDENCE = new Set([
    'user_turn_matched',
    'image_user_turn',
    'attachment_user_turn',
    'generation_started',
    'assistant_activity'
  ]);

  const WEAK_EVIDENCE = new Set([
    'composer_cleared',
    'input_detached',
    'attachment_consumed',
    'route_changed',
    'unmatched_user_turn'
  ]);

  const SAFE_PRE_DISPATCH_REASONS = new Set([
    'no_registered_frame',
    'frame_busy',
    'generation_did_not_stop',
    'login_required',
    'no_input',
    'text_not_inserted',
    'attachment_not_ready',
    'image_not_ready',
    'submit_control_missing'
  ]);

  function evidenceType(entry) {
    return typeof entry === 'string' ? entry : entry?.type;
  }

  function diffEvidenceSnapshots(baseline = {}, current = {}, payload = {}) {
    const changes = [];
    if (payload.hasText && current.matchingUserTurns > baseline.matchingUserTurns) {
      changes.push({ type: 'user_turn_matched', strength: 'strong' });
    }
    const hasAttachments = payload.hasAttachments || payload.hasImages;
    if (hasAttachments && current.imageUserTurns > baseline.imageUserTurns) {
      changes.push({
        type: payload.hasAttachments ? 'attachment_user_turn' : 'image_user_turn',
        strength: 'strong'
      });
    }
    if (!baseline.stopVisible && current.stopVisible) {
      changes.push({ type: 'generation_started', strength: 'strong' });
    }
    if ((current.assistantCount > baseline.assistantCount)
      || (current.assistantText && current.assistantText !== baseline.assistantText)) {
      changes.push({ type: 'assistant_activity', strength: 'strong' });
    }
    if (!current.composerConnected) {
      changes.push({ type: 'input_detached', strength: 'weak' });
    } else if (payload.hasText && baseline.composerContainsText && !current.composerContainsText) {
      changes.push({ type: 'composer_cleared', strength: 'weak' });
    }
    if (baseline.attachments > 0 && current.attachments < baseline.attachments) {
      changes.push({ type: 'attachment_consumed', strength: 'weak' });
    }
    if (current.url !== baseline.url) {
      changes.push({ type: 'route_changed', strength: 'weak' });
    }
    if (current.userTurns > baseline.userTurns
      && current.matchingUserTurns === baseline.matchingUserTurns) {
      changes.push({ type: 'unmatched_user_turn', strength: 'weak' });
    }
    return changes;
  }

  function classifyEvidence(entries) {
    const evidence = Array.isArray(entries) ? entries.filter(Boolean) : [];
    const strong = evidence.find(entry => STRONG_EVIDENCE.has(evidenceType(entry)));
    if (strong) {
      return {
        outcome: 'verified',
        confidence: 'strong',
        reason: evidenceType(strong)
      };
    }

    const weak = evidence.find(entry => WEAK_EVIDENCE.has(evidenceType(entry)));
    if (weak) {
      return {
        outcome: 'unverified',
        confidence: 'weak',
        reason: 'weak_evidence_only'
      };
    }

    return {
      outcome: 'unverified',
      confidence: 'none',
      reason: 'evidence_timeout'
    };
  }

  function deriveRetrySafety({
    actionDispatched = false,
    reason = '',
    attachmentsMutated = false
  } = {}) {
    if (actionDispatched) {
      return { safe: false, reason: 'action_may_have_succeeded' };
    }
    if (attachmentsMutated) {
      return { safe: false, reason: 'attachments_may_remain' };
    }
    if (SAFE_PRE_DISPATCH_REASONS.has(String(reason).split(':')[0])) {
      return { safe: true, reason: 'no_submit_action_dispatched' };
    }
    return { safe: false, reason: 'frame_state_unknown' };
  }

  function attemptFromResult(result) {
    return result?.attempt || result || {};
  }

  function summarizeDelivery(panelResults, expectedPanels = []) {
    const results = Array.isArray(panelResults) ? panelResults.filter(Boolean) : [];
    const expected = Array.isArray(expectedPanels) ? expectedPanels.length : Number(expectedPanels) || 0;
    const targeted = results.filter(result => result?.reason !== 'no_registered_frame').length;
    const verified = results.filter(result => attemptFromResult(result).outcome === 'verified').length;
    const uncertain = results.filter(result => attemptFromResult(result).outcome === 'unverified').length;
    const failed = results.filter(result => attemptFromResult(result).outcome === 'failed').length;

    let outcome;
    if (targeted === 0 && results.length === 0) outcome = 'no_targets';
    else if (expected > 0 && targeted === 0) outcome = 'no_targets';
    else if (expected > 0 && verified === expected) outcome = 'verified';
    else if (verified > 0) outcome = 'partial';
    else if (uncertain > 0) outcome = 'unverified';
    else outcome = 'failed';

    return {
      protocolVersion: VERSION,
      outcome,
      expected,
      targeted,
      verified,
      uncertain,
      failed
    };
  }

  global.AIBDeliveryProtocol = Object.freeze({
    VERSION,
    ATTACHMENT_LIMITS,
    STRONG_EVIDENCE,
    WEAK_EVIDENCE,
    estimatedDataUrlBytes,
    validateAttachments,
    diffEvidenceSnapshots,
    classifyEvidence,
    deriveRetrySafety,
    summarizeDelivery
  });
})(globalThis);
