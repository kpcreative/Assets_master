const BASE = '/monitoring'

async function apiFetch(method, path, body) {
  const opts = { method, headers: {} }
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json'
    opts.body = JSON.stringify(body)
  }
  const res = await fetch(`${BASE}${path}`, opts)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    let msg = text
    try { msg = JSON.parse(text)?.error?.message || text } catch {}
    throw new Error(msg || `${method} ${path} → HTTP ${res.status}`)
  }
  if (res.status === 204) return null
  const ct = res.headers.get('content-type') || ''
  if (!ct.includes('json')) return null
  return res.json()
}

const getList = (path) =>
  apiFetch('GET', path).then(r => (r && Array.isArray(r.value) ? r.value : (Array.isArray(r) ? r : [])))

const action = (path, body = {}) => apiFetch('POST', path, body)

export const fetchFlaggedAssets = () =>
  getList('/FlaggedAssets?$orderby=daysSinceCreation%20desc')

export const fetchScanRuns = () =>
  getList('/ScanRuns?$orderby=startedAt%20desc&$top=10')

export const fetchMonitoringRules = () =>
  getList('/MonitoringRules?$expand=conditions&$orderby=createdAt%20asc')

export const fetchAuditLog = () =>
  getList('/AuditLog?$orderby=performedAt%20desc&$top=300')

export const fetchAlertRecipients = () =>
  getList('/AlertRecipients')

export const triggerScan = () =>
  action('/triggerScan')

export const submitRecommendation = (flaggedAssetId, act, comment) =>
  action('/submitRecommendation', { flaggedAssetId, action: act, comment })

export const massSubmitRecommendation = (flaggedAssetIds, act, comment) =>
  action('/massSubmitRecommendation', { flaggedAssetIds, action: act, comment })

export const approveAction = (flaggedAssetId) =>
  action('/approveAction', { flaggedAssetId })

export const rejectAction = (flaggedAssetId, reason) =>
  action('/rejectAction', { flaggedAssetId, reason })

export const massApproveActions = (flaggedAssetIds) =>
  action('/massApproveActions', { flaggedAssetIds })

export const executeApprovedActions = (flaggedAssetIds) =>
  action('/executeApprovedActions', { flaggedAssetIds })

export const massResetToPending = (flaggedAssetIds) =>
  action('/massResetToPending', { flaggedAssetIds })

export const getLinkedPurchaseOrders = (masterFixedAsset) =>
  apiFetch('POST', '/getLinkedPurchaseOrders', { masterFixedAsset })
    .then(r => Array.isArray(r?.value) ? r.value : (Array.isArray(r) ? r : []))

export const createRule = (data) =>
  apiFetch('POST', '/MonitoringRules', data)

export const updateRule = (id, data) =>
  apiFetch('PATCH', `/MonitoringRules(${id})`, data)

export const deleteRule = (id) =>
  apiFetch('DELETE', `/MonitoringRules(${id})`)

export const createCondition = (data) =>
  apiFetch('POST', '/SensitiveFieldConditions', data)

export const deleteCondition = (id) =>
  apiFetch('DELETE', `/SensitiveFieldConditions(${id})`)

export const createRecipient = (data) =>
  apiFetch('POST', '/AlertRecipients', data)

export const deleteRecipient = (id) =>
  apiFetch('DELETE', `/AlertRecipients(${id})`)

export const fetchCurrentUser = () =>
  apiFetch('GET', '/currentUser()')

export const fetchAdmins = () =>
  getList('/listAdmins()')

export const addAdmin = (email) =>
  action('/addAdmin', { email })

export const removeAdmin = (email) =>
  action('/removeAdmin', { email })
