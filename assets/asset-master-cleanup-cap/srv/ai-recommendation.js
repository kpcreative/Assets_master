/**
 * SAP AI Core Generative AI Hub integration for fixed asset action recommendations.
 *
 * Env vars required for live mode:
 *   AI_CORE_AUTH_URL       — OAuth2 token endpoint (e.g. https://<subdomain>.authentication.eu10.hana.ondemand.com/oauth/token)
 *   AI_CORE_CLIENT_ID      — Client credentials ID
 *   AI_CORE_CLIENT_SECRET  — Client credentials secret
 *   AI_CORE_DEPLOYMENT_URL — Full inference URL including deployment ID
 *                            (e.g. https://api.ai.prod.eu-central-1.aws.ml.hana.ondemand.com/v2/inference/deployments/<id>/chat/completions)
 *   AI_CORE_RESOURCE_GROUP — Resource group (default: "default")
 *
 * When AI_CORE_DEPLOYMENT_URL is not set, all calls return null (mock mode).
 * This means the rest of the app continues working without AI credentials.
 */

function isAiConfigured() {
  return !!process.env.AI_CORE_DEPLOYMENT_URL;
}

let cachedToken = null;
let tokenExpiry  = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry - 30_000) return cachedToken;

  const authUrl  = process.env.AI_CORE_AUTH_URL;
  const clientId = process.env.AI_CORE_CLIENT_ID;
  const secret   = process.env.AI_CORE_CLIENT_SECRET;

  if (!authUrl || !clientId || !secret) {
    throw new Error('SAP AI Core OAuth credentials not configured (AI_CORE_AUTH_URL, AI_CORE_CLIENT_ID, AI_CORE_CLIENT_SECRET)');
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

  const data    = await response.json();
  cachedToken   = data.access_token;
  tokenExpiry   = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

function buildPrompt(asset, violatedFields) {
  const cap  = asset.AssetCapitalizationDate || 'NOT SET';
  const acq  = asset.AcquisitionValueDate    || 'NOT SET';
  const deac = asset.AssetDeactivationDate   || 'NOT SET';
  const fy   = asset.FirstAcquisitionFiscalYear || 'NOT SET';
  const lcs  = asset.AssetLifecycleStatus    || 'UNKNOWN';
  const cs   = asset.AssetCompletenessStatus || 'UNKNOWN';

  return `You are a SAP fixed asset accounting expert. Analyze this asset record and recommend the most appropriate governance action.

Asset Key: ${asset.CompanyCode} / ${asset.MasterFixedAsset} / ${asset.FixedAsset}
Description: ${asset.FixedAssetDescription}
Asset Class: ${asset.AssetClass}
Created: ${asset.CreationDate} (${asset.daysSince || 0} days ago)
Lifecycle Status: ${lcs}
Completeness Status: ${cs}

Ledger Data:
  Capitalization Date: ${cap}
  Acquisition Value Date: ${acq}
  First Acquisition Fiscal Year: ${fy}
  Deactivation Date: ${deac}

Rule Violations Triggered: ${violatedFields.join('; ')}

Choose the single best action:
- DELETE: Asset is clearly erroneous or a test/migration placeholder. Should be fully retired/written off.
- BLOCK: Asset is real but inactive or on hold. Should be deactivated (blocked) without full retirement.

Respond ONLY with valid JSON (no markdown, no explanation outside JSON):
{"action":"DELETE|BLOCK","reasoning":"<one concise sentence>","confidence":0.0}`;
}

/**
 * Get AI recommendation for a flagged fixed asset.
 *
 * @param {object} asset         - Flat asset record including ledger fields
 * @param {string[]} violatedFields - Rule violation descriptions
 * @returns {Promise<{action:string, reasoning:string, confidence:number}|null>}
 */
export async function getAssetRecommendation(asset, violatedFields) {
  if (!isAiConfigured()) {
    cds.log('ai-recommendation').debug('AI mock mode: no recommendation for asset %s/%s/%s', asset.CompanyCode, asset.MasterFixedAsset, asset.FixedAsset);
    return null;
  }

  try {
    const token       = await getAccessToken();
    const deployUrl   = process.env.AI_CORE_DEPLOYMENT_URL;
    const resourceGrp = process.env.AI_CORE_RESOURCE_GROUP || 'default';

    const response = await fetch(deployUrl, {
      method:  'POST',
      headers: {
        Authorization:    `Bearer ${token}`,
        'Content-Type':   'application/json',
        'AI-Resource-Group': resourceGrp,
      },
      body: JSON.stringify({
        model:       'gpt-4o',
        messages:    [{ role: 'user', content: buildPrompt(asset, violatedFields) }],
        max_tokens:  200,
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`AI Core inference failed: ${response.status} ${text}`);
    }

    const data    = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() || '';

    const parsed = JSON.parse(content);

    if (!['DELETE', 'BLOCK'].includes(parsed.action)) {
      throw new Error(`Unexpected AI action value: ${parsed.action}`);
    }

    cds.log('ai-recommendation').info(
      'AI recommendation for %s/%s/%s: action=%s confidence=%s',
      asset.CompanyCode, asset.MasterFixedAsset, asset.FixedAsset,
      parsed.action, parsed.confidence
    );

    return {
      action:     parsed.action,
      reasoning:  parsed.reasoning  || '',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : null,
    };

  } catch (err) {
    cds.log('ai-recommendation').warn('AI recommendation failed for %s/%s/%s: %s', asset.CompanyCode, asset.MasterFixedAsset, asset.FixedAsset, err.message);
    return null;
  }
}
