/**
 * SAP AI Core message framing for the email-driven approval workflow.
 *
 * Uses the same Generative AI Hub deployment/credentials as ai-recommendation.js:
 *   AI_CORE_AUTH_URL       — OAuth2 token endpoint (…/oauth/token)
 *   AI_CORE_CLIENT_ID      — Client credentials ID
 *   AI_CORE_CLIENT_SECRET  — Client credentials secret
 *   AI_CORE_DEPLOYMENT_URL — Full inference URL (…/v2/inference/deployments/<id>/chat/completions)
 *   AI_CORE_RESOURCE_GROUP — Resource group (default: "default")
 *
 * When AI is not configured (or a call fails), every function falls back to a
 * clean templated message — it never throws, so email delivery is never blocked.
 */

function isAiConfigured() {
  return !!process.env.AI_CORE_DEPLOYMENT_URL;
}

let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 30_000) return cachedToken;

  const authUrl  = process.env.AI_CORE_AUTH_URL;
  const clientId = process.env.AI_CORE_CLIENT_ID;
  const secret   = process.env.AI_CORE_CLIENT_SECRET;

  if (!authUrl || !clientId || !secret) {
    throw new Error('SAP AI Core OAuth credentials not configured');
  }

  const encoded  = Buffer.from(`${clientId}:${secret}`).toString('base64');
  const response = await fetch(`${authUrl}?grant_type=client_credentials`, {
    method:  'POST',
    headers: { Authorization: `Basic ${encoded}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    'grant_type=client_credentials',
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`AI Core token fetch failed: ${response.status} ${text}`);
  }

  const data  = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

async function callModel(systemPrompt, userPrompt, maxTokens = 400) {
  const token       = await getAccessToken();
  const deployUrl   = process.env.AI_CORE_DEPLOYMENT_URL;
  const resourceGrp = process.env.AI_CORE_RESOURCE_GROUP || 'default';

  const response = await fetch(deployUrl, {
    method:  'POST',
    headers: {
      Authorization:       `Bearer ${token}`,
      'Content-Type':      'application/json',
      'AI-Resource-Group': resourceGrp,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      max_tokens:  maxTokens,
      temperature: 0.4,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`AI Core inference failed: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// --- helpers ---------------------------------------------------------------

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Turn plain text (with blank-line paragraphs) into safe HTML paragraphs.
function textToHtml(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map(p => `<p style="margin:0 0 12px;">${escapeHtml(p.trim()).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function actionLabel(recommendedAction) {
  if (recommendedAction === 'RECOMMENDED_DELETE') return 'DELETE';
  if (recommendedAction === 'RECOMMENDED_KEEP')   return 'KEEP';
  return 'BLOCK';
}

function assetLines(assets) {
  return (assets || [])
    .map(a => `- ${a.companyCode}/${a.masterFixedAsset}${a.fixedAsset ? '/' + a.fixedAsset : ''} — ${a.assetDescription || 'no description'} — recommended: ${actionLabel(a.recommendedAction)}`)
    .join('\n');
}

// Try AI, parse {"subject","body"} JSON; on any failure return null.
async function aiSubjectBody(systemPrompt, userPrompt) {
  if (!isAiConfigured()) return null;
  try {
    const raw = await callModel(systemPrompt, userPrompt);
    // Models sometimes wrap JSON in ```; strip fences.
    const clean = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(clean);
    if (parsed && parsed.subject && parsed.body) {
      return { subject: String(parsed.subject), bodyHtml: textToHtml(parsed.body) };
    }
  } catch (err) {
    cds.log('ai-email-writer').warn('AI framing failed, using template: %s', err.message);
  }
  return null;
}

const SYSTEM = 'You are a professional SAP fixed-asset governance assistant. Write concise, courteous business emails. ' +
  'Respond ONLY with valid JSON: {"subject":"<short subject>","body":"<plain text body, may use blank lines between paragraphs>"}. ' +
  'Do not include salutations with placeholder names, links, or button text — those are added separately.';

/**
 * Frame an email for a given workflow event.
 * @returns {Promise<{subject:string, bodyHtml:string}>}
 */
export async function frameEmail(kind, ctx = {}) {
  switch (kind) {
    case 'APPROVAL_REQUEST': {
      const prompt =
        `An asset accountant (${ctx.requestedBy}) submitted ${ctx.count} fixed-asset governance recommendation(s) that need admin approval.\n\n` +
        `Assets:\n${assetLines(ctx.assets)}\n\n` +
        `Write an email asking an administrator to review and either approve (which will execute the block/delete in S/4HANA immediately) or cancel. Mention the count and that action buttons follow.`;
      const ai = await aiSubjectBody(SYSTEM, prompt);
      if (ai) return ai;
      return {
        subject: `Approval needed: ${ctx.count} asset action(s) from ${ctx.requestedBy}`,
        bodyHtml:
          `<p style="margin:0 0 12px;">${ctx.count} fixed-asset governance recommendation(s) submitted by ` +
          `<strong>${escapeHtml(ctx.requestedBy)}</strong> require your approval.</p>` +
          `<p style="margin:0 0 12px;">Approving will immediately execute the recommended block/delete in S/4HANA. ` +
          `Use the buttons below to approve all or cancel.</p>`,
      };
    }

    case 'APPROVED_RESULT': {
      const prompt =
        `A fixed-asset recommendation submitted by ${ctx.requestedBy} was APPROVED by administrator ${ctx.decidedBy} and executed in S/4HANA.\n\n` +
        `Outcome:\n${ctx.resultSummary}\n\n` +
        `Write a short email notifying the requester that their recommendation was approved and the action was performed.`;
      const ai = await aiSubjectBody(SYSTEM, prompt);
      if (ai) return ai;
      return {
        subject: `Your asset recommendation was approved and executed`,
        bodyHtml:
          `<p style="margin:0 0 12px;">Your fixed-asset recommendation was approved by <strong>${escapeHtml(ctx.decidedBy)}</strong> and executed in S/4HANA.</p>` +
          `<p style="margin:0 0 12px;">${escapeHtml(ctx.resultSummary)}</p>`,
      };
    }

    case 'DECISION_NOTICE': {
      const verb = ctx.decision === 'CANCELLED' ? 'cancelled' : 'approved';
      const prompt =
        `Administrator ${ctx.decidedBy} has already ${verb} a batch of ${ctx.count} fixed-asset recommendation(s) originally submitted by ${ctx.requestedBy}.\n\n` +
        `Write a brief email informing the other administrators that this batch has already been ${verb}, so no further action is needed.`;
      const ai = await aiSubjectBody(SYSTEM, prompt);
      if (ai) return ai;
      return {
        subject: `Asset batch already ${verb} by ${ctx.decidedBy}`,
        bodyHtml:
          `<p style="margin:0 0 12px;">The batch of ${ctx.count} recommendation(s) from <strong>${escapeHtml(ctx.requestedBy)}</strong> ` +
          `was already <strong>${verb}</strong> by <strong>${escapeHtml(ctx.decidedBy)}</strong>. No further action is required.</p>`,
      };
    }

    case 'EXECUTION_ERROR': {
      const prompt =
        `While executing an approved fixed-asset action in S/4HANA (approved by ${ctx.decidedBy}), the write-back FAILED.\n\n` +
        `Asset: ${ctx.bukrs}/${ctx.anln1}/${ctx.anln2}\nError: ${ctx.messages}\n${ctx.diagnosis ? 'Diagnosis: ' + ctx.diagnosis + '\n' : ''}` +
        `Write a short email alerting administrators that the execution failed for this asset and that they can request an AI diagnosis or notify/reject the requester using the buttons that follow.`;
      const ai = await aiSubjectBody(SYSTEM, prompt);
      if (ai) return ai;
      return {
        subject: `Write-back failed: asset ${ctx.anln1}`,
        bodyHtml:
          `<p style="margin:0 0 12px;">Execution of the approved action for asset ` +
          `<strong>${escapeHtml(ctx.bukrs)}/${escapeHtml(ctx.anln1)}/${escapeHtml(ctx.anln2)}</strong> failed in S/4HANA.</p>` +
          `<p style="margin:0 0 12px;">Use the buttons below to request an AI diagnosis or to notify the requester and reject the recommendation.</p>`,
      };
    }

    case 'REQUESTER_ERROR': {
      const prompt =
        `A fixed-asset recommendation submitted by ${ctx.requestedBy} could not be executed in S/4HANA and has been rejected.\n\n` +
        `Asset: ${ctx.bukrs}/${ctx.anln1}/${ctx.anln2}\nError: ${ctx.messages}\n` +
        `Write a courteous email telling the requester that an error occurred, their recommendation was rejected, and they may review and resubmit.`;
      const ai = await aiSubjectBody(SYSTEM, prompt);
      if (ai) return ai;
      return {
        subject: `Your asset recommendation could not be executed and was rejected`,
        bodyHtml:
          `<p style="margin:0 0 12px;">An error occurred while executing your recommendation for asset ` +
          `<strong>${escapeHtml(ctx.bukrs)}/${escapeHtml(ctx.anln1)}/${escapeHtml(ctx.anln2)}</strong>, so it has been rejected.</p>` +
          `<p style="margin:0 0 12px;"><strong>Error:</strong> ${escapeHtml(ctx.messages)}</p>` +
          `<p style="margin:0 0 12px;">Please review and resubmit if appropriate.</p>`,
      };
    }

    default:
      return { subject: 'Asset Master Data Monitor notification', bodyHtml: '<p>Notification.</p>' };
  }
}

/**
 * Produce a plain-language diagnosis of an S/4HANA write-back error.
 * @returns {Promise<string>}
 */
export async function diagnoseError(ctx = {}) {
  const fallback =
    `The S/4HANA write-back failed for asset ${ctx.bukrs}/${ctx.anln1}/${ctx.anln2}.\n\n` +
    `Reported error: ${ctx.messages || 'unknown'}\n` +
    (ctx.diagnosis ? `Diagnosis: ${ctx.diagnosis}\n` : '') +
    (ctx.procedure ? `Suggested procedure: ${ctx.procedure}\n` : '') +
    `\nTypical causes include the asset having postings/values that prevent deletion, being locked by another user, or missing authorization. Review the asset in transaction AS03 and resolve open items before retrying.`;

  if (!isAiConfigured()) return fallback;
  try {
    const system = 'You are a senior SAP fixed-asset (FI-AA) support expert. Explain the error in plain language and give concrete, numbered remediation steps. Be concise.';
    const user =
      `An S/4HANA write-back failed for a fixed asset.\n\n` +
      `Asset: ${ctx.bukrs}/${ctx.anln1}/${ctx.anln2}\n` +
      `Error messages: ${ctx.messages || 'n/a'}\n` +
      `Diagnosis: ${ctx.diagnosis || 'n/a'}\n` +
      `System response: ${ctx.systemResponse || 'n/a'}\n` +
      `Procedure: ${ctx.procedure || 'n/a'}\n\n` +
      `Explain the likely root cause and how to fix it.`;
    const text = await callModel(system, user, 500);
    return text || fallback;
  } catch (err) {
    cds.log('ai-email-writer').warn('AI diagnosis failed, using fallback: %s', err.message);
    return fallback;
  }
}
