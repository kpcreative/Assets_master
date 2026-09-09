import { createRequire } from 'module';
import http from 'http';
const require = createRequire(import.meta.url);

const MOCK_DATA = require('./fixtures/s4-assets-mock.json');

/**
 * Abstracts all S/4HANA OData API calls against the custom ZUI_ASSET_MONITOR_O4 service.
 *
 * Service base: /sap/opu/odata4/sap/zui_asset_monitor_o4/srvd_a2x/sap/zui_asset_monitor/0001
 *
 * Connection priority:
 *   1. Mock mode  — S4_BASE_URL and S4_DESTINATION_NAME both unset (offline development)
 *   2. Direct URL — S4_BASE_URL + optional S4_USERNAME/S4_PASSWORD (local dev with real system)
 *   3. BTP Destination — S4_DESTINATION_NAME resolved via BTP Destination Service.
 *                        On-premise destinations (ProxyType=OnPremise) are automatically
 *                        routed through the SAP Connectivity proxy using a proxy JWT.
 */

const S4_SERVICE_PATH = '/sap/opu/odata4/sap/zui_asset_monitor_o4/srvd_a2x/sap/zui_asset_monitor/0001';
const ACTION_NAMESPACE = 'com.sap.gateway.srvd_a2x.zui_asset_monitor.v0001';
const PO_SERVICE_PATH  = '/sap/opu/odata4/sap/api_purchaseorder_2/srvd_a2x/sap/purchaseorder/0001';
const SICF_BLOCK_PATH  = '/sap/bc/zasset_block';
const SICF_DELETE_PATH = '/sap/bc/z_delete_asset';
const SAP_CLIENT = process.env.S4_CLIENT || '550';

const log = () => cds.log('s4-integration');

function isMockMode() {
  return !process.env.S4_BASE_URL && !process.env.S4_DESTINATION_NAME;
}

function isDirectMode() {
  return !!process.env.S4_BASE_URL;
}

// ─── Direct (Basic Auth) helpers ─────────────────────────────────────────────

function getDirectDestination() {
  return {
    baseUrl: process.env.S4_BASE_URL,
    user:    process.env.S4_USERNAME,
    pass:    process.env.S4_PASSWORD,
  };
}

function buildBasicHeader(user, pass) {
  if (user && pass) {
    return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return undefined;
}

// ─── BTP Destination + Connectivity helpers ───────────────────────────────────

let _destCache   = {};
let _proxyTokenCache = null;
let _csrfToken   = null;
let _csrfCookies = '';
let _csrfExpiry  = 0;

async function fetchToken(tokenUrl, clientId, clientSecret) {
  const b64 = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(tokenUrl, {
    method:  'POST',
    headers: { Authorization: `Basic ${b64}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error(`Token request to ${tokenUrl} failed: ${res.status} ${await res.text().catch(() => '')}`);
  const { access_token, expires_in } = await res.json();
  return { token: access_token, expiresAt: Date.now() + (expires_in || 3600) * 900 };
}

/**
 * Resolves a BTP destination. Returns:
 *   { url, authHeader, proxyType, proxyHost, proxyPort, proxyToken }
 */
async function resolveDestination(destName) {
  if (_destCache[destName]?.expiresAt > Date.now()) return _destCache[destName];

  const vcap = JSON.parse(process.env.VCAP_SERVICES || '{}');
  const destSvc  = (vcap['destination']   || [])[0];
  const connSvc  = (vcap['connectivity']  || [])[0];
  const xsuaaSvc = (vcap['xsuaa']         || [])[0];

  if (!destSvc) throw new Error('BTP Destination service binding not found in VCAP_SERVICES');

  const destCreds = destSvc.credentials;
  const tokenBase = xsuaaSvc?.credentials?.url || destCreds.url;

  // Get token for Destination Service
  const { token: destToken, expiresAt } = await fetchToken(
    `${tokenBase}/oauth/token`, destCreds.clientid, destCreds.clientsecret
  );

  // Fetch destination details (includes authTokens for resolved credentials)
  const detailRes = await fetch(
    `${destCreds.uri}/destination-configuration/v1/destinations/${destName}`,
    { headers: { Authorization: `Bearer ${destToken}` } }
  );
  if (!detailRes.ok) {
    throw new Error(`Destination '${destName}' lookup failed: ${detailRes.status} ${await detailRes.text().catch(() => '')}`);
  }

  const detail = await detailRes.json();
  const cfg    = detail.destinationConfiguration || {};

  const destUrl = cfg.URL;
  if (!destUrl) throw new Error(`Destination '${destName}' has no URL configured`);

  const proxyType = cfg.ProxyType || 'Internet';

  // Build Authorization header for the backend call.
  // The Destination Service pre-resolves credentials and returns them in authTokens[0].http_header.value
  // as a ready-to-use "Basic base64(user:pass)" string — use it directly to avoid double-encoding.
  let authHeader;
  if (detail.authTokens?.[0]?.http_header?.value) {
    authHeader = detail.authTokens[0].http_header.value;
    log().info('Auth resolved from destination service authTokens (type: %s)', detail.authTokens[0].type || 'unknown');
  } else if (cfg.Authentication === 'BasicAuthentication' && cfg.User) {
    authHeader = buildBasicHeader(cfg.User, cfg.Password || '');
    log().info('Auth built from destination config User field (fallback)');
  } else {
    log().warn('No auth header resolved for destination %s (Authentication=%s, authTokens=%j)', destName, cfg.Authentication, detail.authTokens?.map(t => ({ type: t.type, hasHeader: !!t.http_header })));
  }

  let proxyHost, proxyPort, proxyToken;

  if (proxyType === 'OnPremise') {
    if (!connSvc) throw new Error('Connectivity service binding required for OnPremise destination but not found in VCAP_SERVICES');
    const connCreds = connSvc.credentials;
    proxyHost = connCreds.onpremise_proxy_host;
    proxyPort = connCreds.onpremise_proxy_http_port || '20003';

    // Get proxy JWT from connectivity XSUAA
    const proxyTokenUrl = `${connCreds.token_service_url || connCreds.url}/oauth/token`;
    const proxyResult = await fetchToken(proxyTokenUrl, connCreds.clientid, connCreds.clientsecret);
    proxyToken = proxyResult.token;
    log().info('OnPremise proxy configured: %s:%s', proxyHost, proxyPort);
  }

  // CloudConnectorLocationId must be forwarded as SAP-Connectivity-SCC-Location_ID header
  // so the proxy routes to the correct Cloud Connector instance.
  const sccLocationId = cfg.CloudConnectorLocationId || '';

  const resolved = { url: destUrl.replace(/\/$/, ''), authHeader, proxyType, proxyHost, proxyPort, proxyToken, sccLocationId, expiresAt };
  _destCache[destName] = resolved;
  return resolved;
}

/**
 * Returns { baseUrl, headers, proxyConfig } ready for a fetch() call.
 * For OnPremise destinations, proxyConfig routes through native HTTP proxy.
 */
async function getRequestConfig() {
  const baseHeaders = { 'Content-Type': 'application/json', Accept: 'application/json', 'sap-client': SAP_CLIENT };

  if (isDirectMode()) {
    const dest = getDirectDestination();
    const hdr  = buildBasicHeader(dest.user, dest.pass);
    if (hdr) baseHeaders['Authorization'] = hdr;
    return { baseUrl: dest.baseUrl, headers: baseHeaders, proxyConfig: undefined };
  }

  // BTP Destination mode
  const destName = process.env.S4_DESTINATION_NAME || 'AB1_I769395';
  const resolved  = await resolveDestination(destName);

  if (resolved.authHeader) baseHeaders['Authorization'] = resolved.authHeader;

  let proxyConfig;

  if (resolved.proxyType === 'OnPremise') {
    proxyConfig = {
      host:        resolved.proxyHost,
      port:        resolved.proxyPort,
      token:       resolved.proxyToken,
      locationId:  resolved.sccLocationId || '',
    };
    log().info('Using native HTTP proxy: %s:%s (token length: %d, locationId: %s)', proxyConfig.host, proxyConfig.port, proxyConfig.token?.length || 0, proxyConfig.locationId || '(empty)');
  }

  return { baseUrl: resolved.url, headers: baseHeaders, proxyConfig };
}

/**
 * Makes an HTTP request, routing through SAP Connectivity proxy when proxyConfig is set.
 * Uses native http.request for proxy to guarantee standard HTTP proxy protocol
 * (full URL in request line + Proxy-Authorization header), which SAP Connectivity requires.
 */
async function s4Fetch(url, options) {
  const { proxyConfig, ...opts } = options;

  if (!proxyConfig) {
    return fetch(url, opts);
  }

  // Native HTTP proxy: connect to proxy host:port, send full target URL as request path
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(url);
    const reqHeaders = {
      ...opts.headers,
      'Host': targetUrl.host,
      'Proxy-Authorization': `Bearer ${proxyConfig.token}`,
      'SAP-Connectivity-SCC-Location_ID': proxyConfig.locationId || '',
    };

    const reqOpts = {
      hostname: proxyConfig.host,
      port:     parseInt(proxyConfig.port, 10),
      method:   opts.method || 'GET',
      path:     url,          // full URL as path = standard HTTP proxy protocol
      headers:  reqHeaders,
    };

    const req = http.request(reqOpts, (res) => {
      const chunks = [];
      const resHeaders = res.headers; // capture before async processing
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok:         res.statusCode >= 200 && res.statusCode < 300,
          status:     res.statusCode,
          statusText: res.statusMessage,
          headers:    { get: (n) => resHeaders[n.toLowerCase()] ?? null },
          json:       () => Promise.resolve(JSON.parse(body)),
          text:       () => Promise.resolve(body),
        });
      });
    });

    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ─── CSRF token helpers ───────────────────────────────────────────────────────

async function fetchCsrfToken(baseUrl, headers, proxyConfig) {
  if (_csrfToken && Date.now() < _csrfExpiry) return _csrfToken;

  const res = await s4Fetch(`${baseUrl}${S4_SERVICE_PATH}/`, {
    method:  'GET',
    headers: { ...headers, 'X-CSRF-Token': 'Fetch' },
    proxyConfig,
  });
  const token = res.headers.get('x-csrf-token');
  if (!token || token.toLowerCase() === 'required') {
    throw new Error(`CSRF token fetch failed — S/4HANA returned: ${token}`);
  }

  // SAP CSRF tokens are session-bound — capture Set-Cookie so the POST reuses the same session
  const rawCookies = res.headers.get('set-cookie');
  if (rawCookies) {
    const arr = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
    _csrfCookies = arr.map(c => c.split(';')[0]).join('; ');
  } else {
    _csrfCookies = '';
  }

  _csrfToken  = token;
  _csrfExpiry = Date.now() + 28 * 60 * 1000;
  log().info('CSRF token refreshed (valid 28 min), session cookies: %s', _csrfCookies ? 'captured' : 'none');
  return _csrfToken;
}

/**
 * POST to S/4HANA with automatic CSRF token handling.
 * Fetches a fresh token if the cache is empty; retries once if the cached token is rejected.
 */
async function s4Post(url, requestConfig, body = '{}') {
  const { baseUrl, headers, proxyConfig } = requestConfig;
  const csrf = await fetchCsrfToken(baseUrl, headers, proxyConfig);
  const postHeaders = {
    ...headers,
    'X-CSRF-Token': csrf,
    ...(_csrfCookies ? { Cookie: _csrfCookies } : {}),
  };
  const response = await s4Fetch(url, {
    method:  'POST',
    headers: postHeaders,
    body,
    proxyConfig,
  });
  if (!response.ok && response.status === 403) {
    // Cached token expired — refresh and retry once
    _csrfToken = null;
    const csrf2 = await fetchCsrfToken(baseUrl, headers, proxyConfig);
    return s4Fetch(url, {
      method:  'POST',
      headers: { ...headers, 'X-CSRF-Token': csrf2, ...(_csrfCookies ? { Cookie: _csrfCookies } : {}) },
      body,
      proxyConfig,
    });
  }
  return response;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch all fixed asset records with ledger data expanded.
 */
export async function fetchFixedAssets() {
  if (isMockMode()) {
    log().info('Mock mode: returning fixture assets (%d records)', MOCK_DATA.length);
    return MOCK_DATA;
  }

  const { baseUrl, headers, proxyConfig } = await getRequestConfig();
  const url = `${baseUrl}${S4_SERVICE_PATH}/AssetMonitor?$expand=_FixedAssetLedger&$top=5000`;

  log().info('Fetching assets from: %s', url);

  const response = await s4Fetch(url, { method: 'GET', headers, proxyConfig });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log().error('fetchFixedAssets HTTP %d: %s', response.status, body.slice(0, 500));
    throw new Error(`fetchFixedAssets failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const raw  = json.value || [];

  return raw.map(asset => {
    const ledger = (asset._FixedAssetLedger || [])[0] || {};
    return {
      CompanyCode:              asset.CompanyCode,
      MasterFixedAsset:         asset.MasterFixedAsset,
      FixedAsset:               asset.FixedAsset,
      FixedAssetDescription:    asset.FixedAssetDescription,
      AssetClass:               asset.AssetClass,
      CreationDate:             asset.CreationDate,
      AssetLifecycleStatus:     asset.AssetLifecycleStatus     || null,
      AssetCompletenessStatus:  asset.AssetCompletenessStatus  || null,
      AccountIsBlockedForPosting:   asset.AccountIsBlockedForPosting || false,
      AcquisitionValueDate:         ledger.AcquisitionValueDate         || null,
      AssetCapitalizationDate:      ledger.AssetCapitalizationDate      || null,
      AssetDeactivationDate:        ledger.AssetDeactivationDate        || null,
      FirstAcquisitionFiscalYear:   ledger.FirstAcquisitionFiscalYear   || null,
      FirstAcquisitionFiscalPeriod: ledger.FirstAcquisitionFiscalPeriod || null,
    };
  });
}

/**
 * Retire an asset via the custom RAP bound action retireAsset.
 */
export async function retireAsset(companyCode, masterFixedAsset, fixedAsset) {
  if (isMockMode()) {
    log().info('Mock mode: retire asset %s/%s/%s', companyCode, masterFixedAsset, fixedAsset);
    return { success: true, response: JSON.stringify({ message: 'Asset retired successfully (mock)' }) };
  }

  const requestConfig = await getRequestConfig();
  const keyPredicate = `CompanyCode='${companyCode}',MasterFixedAsset='${masterFixedAsset}',FixedAsset='${fixedAsset}'`;
  const url = `${requestConfig.baseUrl}${S4_SERVICE_PATH}/AssetMonitor(${keyPredicate})/${ACTION_NAMESPACE}.retireAsset`;

  const response = await s4Post(url, requestConfig);
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`retireAsset failed: ${response.status} ${text}`);
  }

  return { success: true, response: await response.text() };
}

/**
 * Block an asset via the custom RAP bound action blockAsset.
 */
export async function blockAsset(companyCode, masterFixedAsset, fixedAsset) {
  if (isMockMode()) {
    log().info('Mock mode: block asset %s/%s/%s', companyCode, masterFixedAsset, fixedAsset);
    return { success: true, response: JSON.stringify({ message: 'Asset blocked successfully (mock)' }) };
  }

  const requestConfig = await getRequestConfig();
  const keyPredicate = `CompanyCode='${companyCode}',MasterFixedAsset='${masterFixedAsset}',FixedAsset='${fixedAsset}'`;
  const url = `${requestConfig.baseUrl}${S4_SERVICE_PATH}/AssetMonitor(${keyPredicate})/${ACTION_NAMESPACE}.blockAsset`;

  const response = await s4Post(url, requestConfig);
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new Error(`blockAsset failed: ${response.status} ${text}`);
  }

  return { success: true, response: await response.text() };
}

/**
 * Block an asset via the custom SICF HTTP service (BDC on AS05).
 * POST /sap/bc/zasset_block — expects { companycode, masterfixedasset, fixedasset }
 * and returns { success: boolean, message: string }.
 * Routes through the same destination/proxy plumbing as the OData calls.
 */
export async function blockAssetViaSICF(companyCode, masterFixedAsset, fixedAsset) {
  if (isMockMode()) {
    log().info('Mock mode: SICF block %s/%s/%s', companyCode, masterFixedAsset, fixedAsset);
    return { success: true, response: JSON.stringify({ message: 'Asset blocked successfully (mock)' }) };
  }

  const cfg  = await getRequestConfig();
  const url  = `${cfg.baseUrl}${SICF_BLOCK_PATH}?sap-client=${SAP_CLIENT}`;
  const body = JSON.stringify({
    companycode:      companyCode,
    masterfixedasset: masterFixedAsset,
    fixedasset:       fixedAsset || '0000',
  });

  const response = await s4Fetch(url, { method: 'POST', headers: cfg.headers, body, proxyConfig: cfg.proxyConfig });
  const text = await response.text().catch(() => '');

  let parsed = {};
  try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }

  if (!response.ok || parsed.success === false) {
    throw new Error(parsed.message || `zasset_block failed: ${response.status} ${text.slice(0, 300)}`);
  }

  return { success: true, response: parsed.message || text };
}

/**
 * Delete an asset via the custom SICF HTTP service (BDC on AS05).
 * POST /sap/bc/z_delete_asset — expects { companycode, masterfixedasset, fixedasset }
 * Returns { success, message } on success; { success, bukrs, anln1, anln2, messages, diagnosis, systemResponse, procedure } on failure.
 */
export async function deleteAssetViaSICF(companyCode, masterFixedAsset, fixedAsset) {
  if (isMockMode()) {
    log().info('Mock mode: SICF delete %s/%s/%s', companyCode, masterFixedAsset, fixedAsset);
    return { success: true, response: JSON.stringify({ message: 'Asset deleted successfully (mock)' }) };
  }

  const cfg  = await getRequestConfig();
  const url  = `${cfg.baseUrl}${SICF_DELETE_PATH}?sap-client=${SAP_CLIENT}`;
  const body = JSON.stringify({
    CompanyCode:      companyCode,
    MasterFixedAsset: masterFixedAsset,
    FixedAsset:       fixedAsset || '0',
  });

  const response = await s4Fetch(url, { method: 'POST', headers: cfg.headers, body, proxyConfig: cfg.proxyConfig });
  const text = await response.text().catch(() => '');

  let parsed = {};
  try { parsed = JSON.parse(text); } catch { /* non-JSON body */ }

  if (!response.ok || parsed.success === false) {
    const err = new Error(parsed.messages || parsed.message || `z_delete_asset failed: ${response.status} ${text.slice(0, 300)}`);
    err.bukrs          = parsed.bukrs          || '';
    err.anln1          = parsed.anln1          || '';
    err.anln2          = parsed.anln2          || '0';
    err.messages       = parsed.messages       || err.message;
    err.diagnosis      = parsed.diagnosis      || '';
    err.systemResponse = parsed.systemResponse || '';
    err.procedure      = parsed.procedure      || '';
    throw err;
  }

  return { success: true, response: parsed.message || text };
}

/**
 * Uses the standard api_purchaseorder_2 OData V4 service.
 * Returns a deduplicated array of PO number strings.
 */
export async function fetchLinkedPurchaseOrders(masterFixedAsset) {
  if (isMockMode()) {
    log().info('Mock mode: fetch POs for asset %s', masterFixedAsset);
    return [];
  }

  const { baseUrl, headers, proxyConfig } = await getRequestConfig();
  const filter = `MasterFixedAsset eq '${masterFixedAsset}'`;
  const url = `${baseUrl}${PO_SERVICE_PATH}/PurchaseOrderAccountAssignment?$filter=${encodeURIComponent(filter)}&$select=PurchaseOrder`;

  log().info('Fetching linked POs for asset: %s', masterFixedAsset);

  const response = await s4Fetch(url, { method: 'GET', headers, proxyConfig });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    log().error('fetchLinkedPurchaseOrders HTTP %d: %s', response.status, body.slice(0, 200));
    throw new Error(`fetchLinkedPurchaseOrders failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json();
  const raw  = json.value || [];
  return [...new Set(raw.map(r => r.PurchaseOrder).filter(Boolean))];
}
