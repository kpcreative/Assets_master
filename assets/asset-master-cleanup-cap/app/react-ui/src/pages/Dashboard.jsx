import { useState, useEffect, useCallback } from 'react'
import * as api from '../api/client'

const STATUS_OPTIONS = [
  { value: '', label: 'All Statuses' },
  { value: 'PENDING',             label: 'Pending' },
  { value: 'RECOMMENDED_BLOCK',   label: 'Recommended: Block' },
  { value: 'RECOMMENDED_DELETE',  label: 'Recommended: Delete' },
  { value: 'RECOMMENDED_KEEP',    label: 'Recommended: Keep' },
  { value: 'APPROVED',            label: 'Approved' },
  { value: 'REJECTED',            label: 'Rejected' },
]

const REC_ACTIONS = [
  { value: 'RECOMMENDED_BLOCK',  label: 'Block — Set deactivation date in S/4HANA' },
  { value: 'RECOMMENDED_DELETE', label: 'Delete — Post retirement document in S/4HANA' },
  { value: 'RECOMMENDED_KEEP',   label: 'Keep — Mark as reviewed, no action needed' },
]

// Maps AI action string to the matching recommendation action value
const AI_ACTION_MAP = {
  BLOCK:  'RECOMMENDED_BLOCK',
  DELETE: 'RECOMMENDED_DELETE',
}

function StatusBadge({ status }) {
  const map = {
    PENDING:             ['badge-pending',    'Pending'],
    RECOMMENDED_BLOCK:   ['badge-rec-block',  'Block'],
    RECOMMENDED_DELETE:  ['badge-rec-delete', 'Delete'],
    RECOMMENDED_KEEP:    ['badge-rec-keep',   'Keep'],
    APPROVED:            ['badge-approved',   'Approved'],
    REJECTED:            ['badge-rejected',   'Rejected'],
    EXECUTED:            ['badge-executed',   'Executed'],
    FAILED:              ['badge-failed',     'Failed'],
  }
  const [cls, label] = map[status] || ['badge-pending', status]
  return <span className={`status-badge ${cls}`}>{label}</span>
}

function AiBadge({ action, confidence, reasoning, expanded, onToggle }) {
  if (!action) return <span style={{ color: '#94a3b8', fontSize: 12 }}>—</span>

  const colorMap = { DELETE: '#dc2626', BLOCK: '#d97706' }
  const color = colorMap[action] || '#475569'
  const pct   = confidence != null ? ` ${Math.round(confidence * 100)}%` : ''

  return (
    <div>
      <button
        onClick={onToggle}
        title={reasoning || 'Click to see AI reasoning'}
        style={{
          background: 'none', border: `1px solid ${color}`, borderRadius: 4,
          color, fontSize: 11, fontWeight: 600, padding: '2px 7px',
          cursor: 'pointer', whiteSpace: 'nowrap',
        }}
      >
        AI: {action}{pct} {expanded ? '▲' : '▼'}
      </button>
      {expanded && reasoning && (
        <div style={{
          marginTop: 4, padding: '6px 8px', background: '#f8fafc',
          border: '1px solid #e2e8f0', borderRadius: 4,
          fontSize: 11.5, color: '#334155', lineHeight: 1.5,
          maxWidth: 240, position: 'absolute', zIndex: 10,
          boxShadow: '0 2px 8px rgba(0,0,0,0.12)',
        }}>
          <strong style={{ color, display: 'block', marginBottom: 3 }}>AI: {action}</strong>
          {reasoning}
        </div>
      )}
    </div>
  )
}

function fmtDate(s) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export default function Dashboard({ onBadgeRefresh }) {
  const [assets,   setAssets]   = useState([])
  const [scanRuns, setScanRuns] = useState([])
  const [loading,  setLoading]  = useState(true)
  const [scanning, setScanning] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [statusFilter,  setStatusFilter]  = useState('')
  const [companyFilter, setCompanyFilter] = useState('')
  const [showDialog, setShowDialog] = useState(false)
  const [recAction,  setRecAction]  = useState('RECOMMENDED_BLOCK')
  const [recComment, setRecComment] = useState('')
  const [alert, setAlert]           = useState(null)
  const [expandedAi, setExpandedAi] = useState(null)
  const [poMap, setPoMap]           = useState({})
  const [poDialogData, setPoDialogData] = useState(null)
  const [activeTab,       setActiveTab]       = useState('active')
  const [selectedHistory, setSelectedHistory] = useState(new Set())
  const [selectedBlocked, setSelectedBlocked] = useState(new Set())
  const [dialogSource,    setDialogSource]    = useState('active')  // 'active' | 'blocked'

  // ── Data loading ──────────────────────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const [a, s] = await Promise.all([api.fetchFlaggedAssets(), api.fetchScanRuns()])
      setAssets(a)
      setScanRuns(s)
    } catch (e) {
      setAlert({ type: 'error', msg: 'Failed to load: ' + e.message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  // After assets load, fetch linked POs for each unique masterFixedAsset
  useEffect(() => {
    if (assets.length === 0) return
    const unique = [...new Set(assets.map(a => a.masterFixedAsset))]
    unique.forEach(mfa => {
      if (poMap[mfa] !== undefined) return
      setPoMap(prev => ({ ...prev, [mfa]: [] }))
      api.getLinkedPurchaseOrders(mfa)
        .then(arr => {
          const pos = arr.map(r => r.purchaseOrder).filter(Boolean)
          setPoMap(prev => ({ ...prev, [mfa]: pos }))
        })
        .catch(() => setPoMap(prev => ({ ...prev, [mfa]: [] })))
    })
  }, [assets]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived data ──────────────────────────────────────────────────────────

  const latestScan   = scanRuns[0]
  const pendingCount = assets.filter(a => a.reviewStatus === 'PENDING').length
  const aiCount      = assets.filter(a => a.aiRecommendedAction).length

  // Split assets three ways:
  //   history  → EXECUTED/FAILED (write-back attempts)
  //   blocked  → already blocked in S/4 but still violating a rule
  //   active   → everything else (the normal review queue)
  const historyAssets = assets.filter(a => a.reviewStatus === 'EXECUTED' || a.reviewStatus === 'FAILED')
  // Only FAILED rows can be reset — a successful EXECUTED write-back must not be reset (reset does not undo the S/4 action)
  const resettableHistory = historyAssets.filter(a => a.reviewStatus === 'FAILED')
  const blockedAssets = assets.filter(a => a.isAlreadyBlocked && a.reviewStatus !== 'EXECUTED' && a.reviewStatus !== 'FAILED')
  const activeAssets  = assets.filter(a => !a.isAlreadyBlocked && a.reviewStatus !== 'EXECUTED' && a.reviewStatus !== 'FAILED')

  // Active tab: apply status + company filters
  const filtered = activeAssets.filter(a => {
    if (statusFilter  && a.reviewStatus !== statusFilter)                       return false
    if (companyFilter && !a.companyCode.includes(companyFilter.toUpperCase()))  return false
    return true
  })

  // Only PENDING assets with no linked POs can have a recommendation submitted
  const submittableAssets = filtered.filter(
    a => a.reviewStatus === 'PENDING' && !(poMap[a.masterFixedAsset]?.length > 0)
  )

  const allSubmittableSelected =
    submittableAssets.length > 0 && submittableAssets.every(a => selected.has(a.ID))

  const pendingSelected = [...selected].filter(id => {
    const a = assets.find(x => x.ID === id)
    return a && a.reviewStatus === 'PENDING'
  })

  // Active tab: rejected rows can be resubmitted (reset) back to PENDING
  const rejectedSelected = [...selected].filter(id => {
    const a = assets.find(x => x.ID === id)
    return a && a.reviewStatus === 'REJECTED'
  })

  // Blocked tab: only PENDING blocked assets can receive a recommendation
  const pendingSelectedBlocked = [...selectedBlocked].filter(id => {
    const a = assets.find(x => x.ID === id)
    return a && a.reviewStatus === 'PENDING'
  })

  // Which ids the Submit Recommendation dialog acts on, based on where it was opened
  const dialogIds = dialogSource === 'blocked' ? pendingSelectedBlocked : pendingSelected

  // ── Selection helpers ─────────────────────────────────────────────────────

  const toggleAll = () =>
    allSubmittableSelected
      ? setSelected(new Set())
      : setSelected(new Set(submittableAssets.map(a => a.ID)))

  const toggleOne = id => {
    const s = new Set(selected)
    s.has(id) ? s.delete(id) : s.add(id)
    setSelected(s)
  }

  const toggleAllHistory = () => {
    const allSel = resettableHistory.length > 0 && resettableHistory.every(a => selectedHistory.has(a.ID))
    setSelectedHistory(allSel ? new Set() : new Set(resettableHistory.map(a => a.ID)))
  }

  const toggleOneHistory = id => {
    const s = new Set(selectedHistory)
    s.has(id) ? s.delete(id) : s.add(id)
    setSelectedHistory(s)
  }

  const toggleAllBlocked = () => {
    const allSel = blockedAssets.length > 0 && blockedAssets.every(a => selectedBlocked.has(a.ID))
    setSelectedBlocked(allSel ? new Set() : new Set(blockedAssets.map(a => a.ID)))
  }

  const toggleOneBlocked = id => {
    const s = new Set(selectedBlocked)
    s.has(id) ? s.delete(id) : s.add(id)
    setSelectedBlocked(s)
  }

  // ── Action handlers ───────────────────────────────────────────────────────

  // When opening dialog, pre-fill action from AI recommendation if single pending asset selected.
  // Blocked-tab source never offers Block (asset is already blocked) — default to Delete.
  const openDialog = (source = 'active') => {
    setDialogSource(source)
    const ids = source === 'blocked' ? pendingSelectedBlocked : pendingSelected

    if (source === 'blocked') {
      setRecAction('RECOMMENDED_DELETE')
    }

    if (ids.length === 1) {
      const asset = assets.find(a => a.ID === ids[0])
      if (asset?.aiRecommendedAction) {
        const mapped = AI_ACTION_MAP[asset.aiRecommendedAction] || 'RECOMMENDED_BLOCK'
        // Never pre-select Block for an already-blocked asset
        setRecAction(source === 'blocked' && mapped === 'RECOMMENDED_BLOCK' ? 'RECOMMENDED_DELETE' : mapped)
        if (asset.aiReasoningSummary) {
          setRecComment(`AI suggested: ${asset.aiReasoningSummary}`)
        }
      }
    }
    setShowDialog(true)
  }

  const handleTriggerScan = async () => {
    setScanning(true)
    setAlert(null)
    try {
      const res = await api.triggerScan()
      setAlert({ type: 'success', msg: `Scan completed. Run ID: ${res.scanRunId}` })
      await loadData()
      if (onBadgeRefresh) onBadgeRefresh()
    } catch (e) {
      setAlert({ type: 'error', msg: 'Scan failed: ' + e.message })
    } finally {
      setScanning(false)
    }
  }

  const handleSubmitRec = async () => {
    const ids = dialogIds
    try {
      const res = await api.massSubmitRecommendation(ids, recAction, recComment)
      setAlert({ type: 'success', msg: `Recommendation submitted for ${res.updated} asset(s)` })
      setShowDialog(false)
      if (dialogSource === 'blocked') setSelectedBlocked(new Set())
      else setSelected(new Set())
      setRecComment('')
      await loadData()
      if (onBadgeRefresh) onBadgeRefresh()
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    }
  }

  const handleResetToPending = async () => {
    const ids = [...selectedHistory]
    try {
      const res = await api.massResetToPending(ids)
      setAlert({ type: 'success', msg: `Reset to Pending: ${res.reset} asset(s)` })
      setSelectedHistory(new Set())
      await loadData()
      if (onBadgeRefresh) onBadgeRefresh()
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    }
  }

  const handleResubmitRejected = async () => {
    try {
      const res = await api.massResetToPending(rejectedSelected)
      setAlert({ type: 'success', msg: `Resubmitted to Pending: ${res.reset} asset(s)` })
      setSelected(new Set())
      await loadData()
      if (onBadgeRefresh) onBadgeRefresh()
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    }
  }

  const resetFilters = () => { setStatusFilter(''); setCompanyFilter(''); setSelected(new Set()) }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Flagged Assets Dashboard</div>
          <div className="page-subtitle">Assets that matched monitoring rules and require review</div>
        </div>
        <div className="header-actions">
          <button className="btn btn-primary" onClick={handleTriggerScan} disabled={scanning}>
            {scanning ? '⟳  Running Scan…' : '▶  Trigger Scan'}
          </button>
        </div>
      </div>

      {alert && (
        <div className={`alert alert-${alert.type}`}>
          <span>{alert.msg}</span>
          <button className="alert-close" onClick={() => setAlert(null)}>✕</button>
        </div>
      )}

      <div className="stats-row">
        <div className="stat-card">
          <div className="stat-value">{latestScan ? fmtDate(latestScan.startedAt) : '—'}</div>
          <div className="stat-label">Last Scan</div>
        </div>
        <div className="stat-card accent-blue">
          <div className="stat-value">{latestScan?.totalRecordsEvaluated ?? '—'}</div>
          <div className="stat-label">Evaluated</div>
        </div>
        <div className="stat-card accent-orange">
          <div className="stat-value">{activeAssets.length}</div>
          <div className="stat-label">Total Flagged</div>
        </div>
        <div className="stat-card accent-red">
          <div className="stat-value">{pendingCount}</div>
          <div className="stat-label">Pending Review</div>
        </div>
        {aiCount > 0 && (
          <div className="stat-card" style={{ borderTop: '3px solid #7c3aed' }}>
            <div className="stat-value" style={{ color: '#7c3aed' }}>{aiCount}</div>
            <div className="stat-label">AI Suggestions</div>
          </div>
        )}
      </div>

      <div className="card">

        {/* ── Tab navigation ── */}
        <div className="tab-bar" style={{ padding: '0 16px' }}>
          <button
            className={`tab-btn${activeTab === 'active' ? ' active' : ''}`}
            onClick={() => setActiveTab('active')}
          >
            Active ({activeAssets.length})
          </button>
          <button
            className={`tab-btn${activeTab === 'blocked' ? ' active' : ''}`}
            onClick={() => setActiveTab('blocked')}
          >
            Blocked Assets ({blockedAssets.length})
          </button>
          <button
            className={`tab-btn${activeTab === 'history' ? ' active' : ''}`}
            onClick={() => setActiveTab('history')}
          >
            History ({historyAssets.length})
          </button>
        </div>

        {/* ── Active tab ── */}
        {activeTab === 'active' && (
          <>
            <div className="card-header">
              <span className="card-title">Active Assets ({filtered.length})</span>
              <div className="filter-row">
                <select className="filter-select" value={statusFilter}
                  onChange={e => { setStatusFilter(e.target.value); setSelected(new Set()) }}>
                  {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <input className="filter-input" placeholder="Company code…" value={companyFilter}
                  onChange={e => { setCompanyFilter(e.target.value); setSelected(new Set()) }} />
                <button className="btn btn-outline btn-sm" onClick={resetFilters}>Reset</button>
              </div>
            </div>

            <div className={`table-toolbar${selected.size === 0 ? ' hidden' : ''}`}>
              <span>{selected.size} row{selected.size !== 1 ? 's' : ''} selected</span>
              <button className="btn btn-warning btn-sm" onClick={() => openDialog('active')}
                disabled={pendingSelected.length === 0}>
                Submit Recommendation ({pendingSelected.length} pending)
              </button>
              <button className="btn btn-outline btn-sm" onClick={handleResubmitRejected}
                disabled={rejectedSelected.length === 0}>
                Resubmit to Pending ({rejectedSelected.length} rejected)
              </button>
              <button className="btn btn-outline btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
            </div>

            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="checkbox-cell">
                      <input
                        type="checkbox"
                        checked={allSubmittableSelected}
                        onChange={toggleAll}
                        disabled={submittableAssets.length === 0}
                        title="Select all submittable (Pending, no linked POs)"
                      />
                    </th>
                    <th>Company</th>
                    <th>Asset No.</th>
                    <th>Description</th>
                    <th>Days Old</th>
                    <th>Violation</th>
                    <th>AI Suggestion</th>
                    <th>Status</th>
                    <th>Reviewer</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={9} className="table-loading">Loading assets…</td></tr>
                  ) : filtered.length === 0 ? (
                    <tr><td colSpan={9} className="table-empty">No assets match the current filters</td></tr>
                  ) : filtered.map(a => (
                    <tr key={a.ID}>
                      <td className="checkbox-cell">
                        <input type="checkbox" checked={selected.has(a.ID)} onChange={() => toggleOne(a.ID)} />
                      </td>
                      <td style={{ fontWeight: 600 }}>{a.companyCode}</td>
                      <td className="muted mono">{a.masterFixedAsset}</td>
                      <td style={{ maxWidth: 200 }}>{a.assetDescription || '—'}</td>
                      <td style={{
                        textAlign: 'center', fontWeight: 600,
                        color: a.daysSinceCreation > 365 ? '#dc2626' : a.daysSinceCreation > 180 ? '#ea580c' : '#374151'
                      }}>
                        {a.daysSinceCreation}
                      </td>
                      <td style={{ maxWidth: 180, fontSize: 12, color: '#64748b' }}>
                        {a.triggeringFieldsSummary || '—'}
                      </td>
                      <td style={{ position: 'relative' }}>
                        <AiBadge
                          action={a.aiRecommendedAction}
                          confidence={a.aiConfidenceScore}
                          reasoning={a.aiReasoningSummary}
                          expanded={expandedAi === a.ID}
                          onToggle={() => setExpandedAi(expandedAi === a.ID ? null : a.ID)}
                        />
                        {poMap[a.masterFixedAsset]?.length > 0 && (
                          <div style={{ marginTop: 4 }}>
                            <span style={{ color: '#dc2626', fontSize: 11, fontWeight: 600 }}>⚠ Block/Delete unavailable</span>
                            <button
                              onClick={() => setPoDialogData({ mfa: a.masterFixedAsset, poNumbers: poMap[a.masterFixedAsset] })}
                              style={{ marginLeft: 5, color: '#2563eb', fontSize: 11, background: 'none', border: 'none',
                                       cursor: 'pointer', textDecoration: 'underline', padding: 0 }}>
                              See more
                            </button>
                          </div>
                        )}
                      </td>
                      <td><StatusBadge status={a.reviewStatus} /></td>
                      <td className="muted">{a.reviewedBy || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ── Blocked Assets tab ── */}
        {activeTab === 'blocked' && (
          <>
            <div className="card-header">
              <span className="card-title">Blocked Assets ({blockedAssets.length})</span>
              <span style={{ fontSize: 12, color: '#64748b' }}>
                Already blocked in S/4 but still violate a rule — recommend Delete to retire
              </span>
            </div>

            <div className={`table-toolbar${selectedBlocked.size === 0 ? ' hidden' : ''}`}>
              <span>{selectedBlocked.size} row{selectedBlocked.size !== 1 ? 's' : ''} selected</span>
              <button className="btn btn-warning btn-sm" onClick={() => openDialog('blocked')}
                disabled={pendingSelectedBlocked.length === 0}>
                Submit Recommendation ({pendingSelectedBlocked.length} pending)
              </button>
              <button className="btn btn-outline btn-sm" onClick={() => setSelectedBlocked(new Set())}>Clear</button>
            </div>

            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="checkbox-cell">
                      <input
                        type="checkbox"
                        checked={blockedAssets.length > 0 && blockedAssets.every(a => selectedBlocked.has(a.ID))}
                        onChange={toggleAllBlocked}
                        disabled={blockedAssets.length === 0}
                      />
                    </th>
                    <th>Company</th>
                    <th>Asset No.</th>
                    <th>Description</th>
                    <th>Days Old</th>
                    <th>Violation</th>
                    <th>Status</th>
                    <th>Reviewer</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={8} className="table-loading">Loading…</td></tr>
                  ) : blockedAssets.length === 0 ? (
                    <tr><td colSpan={8} className="table-empty">No blocked assets currently violate a rule</td></tr>
                  ) : blockedAssets.map(a => (
                    <tr key={a.ID}>
                      <td className="checkbox-cell">
                        <input
                          type="checkbox"
                          checked={selectedBlocked.has(a.ID)}
                          onChange={() => toggleOneBlocked(a.ID)}
                        />
                      </td>
                      <td style={{ fontWeight: 600 }}>{a.companyCode}</td>
                      <td className="muted mono">{a.masterFixedAsset}</td>
                      <td style={{ maxWidth: 200 }}>{a.assetDescription || '—'}</td>
                      <td style={{ textAlign: 'center', fontWeight: 600 }}>{a.daysSinceCreation}</td>
                      <td style={{ maxWidth: 180, fontSize: 12, color: '#64748b' }}>
                        {a.triggeringFieldsSummary || '—'}
                      </td>
                      <td><StatusBadge status={a.reviewStatus} /></td>
                      <td className="muted">{a.reviewedBy || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* ── History tab ── */}
        {activeTab === 'history' && (
          <>
            <div className="card-header">
              <span className="card-title">History ({historyAssets.length})</span>
              <span style={{ fontSize: 12, color: '#64748b' }}>Executed and failed write-back attempts</span>
            </div>

            <div className={`table-toolbar${selectedHistory.size === 0 ? ' hidden' : ''}`}>
              <span>{selectedHistory.size} row{selectedHistory.size !== 1 ? 's' : ''} selected</span>
              <button className="btn btn-warning btn-sm" onClick={handleResetToPending}>
                Reset to Pending ({selectedHistory.size})
              </button>
              <button className="btn btn-outline btn-sm" onClick={() => setSelectedHistory(new Set())}>Clear</button>
            </div>

            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="checkbox-cell">
                      <input
                        type="checkbox"
                        checked={resettableHistory.length > 0 && resettableHistory.every(a => selectedHistory.has(a.ID))}
                        onChange={toggleAllHistory}
                        disabled={resettableHistory.length === 0}
                      />
                    </th>
                    <th>Company</th>
                    <th>Asset No.</th>
                    <th>Description</th>
                    <th>Days Old</th>
                    <th>Status</th>
                    <th>Reviewer</th>
                    <th>Write-back Result</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={8} className="table-loading">Loading…</td></tr>
                  ) : historyAssets.length === 0 ? (
                    <tr><td colSpan={8} className="table-empty">No history records</td></tr>
                  ) : historyAssets.map(a => (
                    <tr key={a.ID}>
                      <td className="checkbox-cell">
                        <input
                          type="checkbox"
                          checked={selectedHistory.has(a.ID)}
                          onChange={() => toggleOneHistory(a.ID)}
                          disabled={a.reviewStatus !== 'FAILED'}
                          title={a.reviewStatus !== 'FAILED' ? 'Only failed write-backs can be reset' : undefined}
                        />
                      </td>
                      <td style={{ fontWeight: 600 }}>{a.companyCode}</td>
                      <td className="muted mono">{a.masterFixedAsset}</td>
                      <td style={{ maxWidth: 200 }}>{a.assetDescription || '—'}</td>
                      <td style={{ textAlign: 'center', fontWeight: 600 }}>{a.daysSinceCreation}</td>
                      <td><StatusBadge status={a.reviewStatus} /></td>
                      <td className="muted">{a.reviewedBy || '—'}</td>
                      <td style={{ maxWidth: 220, fontSize: 12, color: '#64748b' }}>
                        {a.writeBackSapResponse
                          ? a.writeBackSapResponse.slice(0, 80) + (a.writeBackSapResponse.length > 80 ? '…' : '')
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

      </div>

      {/* ── Submit Recommendation dialog ── */}
      {showDialog && (
        <div className="dialog-overlay" onClick={() => setShowDialog(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <div className="dialog-header">
              <span className="dialog-title">Submit Recommendation</span>
              <button className="dialog-close" onClick={() => setShowDialog(false)}>✕</button>
            </div>
            <div className="dialog-body">
              <p style={{ marginBottom: 16, color: '#556b82', fontSize: 13, lineHeight: 1.5 }}>
                Applying recommendation to <strong>{dialogIds.length}</strong> pending asset(s).
                Only assets in <em>Pending</em> status will be updated.
              </p>
              {dialogIds.length === 1 && (() => {
                const a = assets.find(x => x.ID === dialogIds[0])
                return a?.aiRecommendedAction ? (
                  <div style={{
                    background: '#f5f3ff', border: '1px solid #c4b5fd', borderRadius: 6,
                    padding: '10px 12px', marginBottom: 14, fontSize: 12.5,
                  }}>
                    <strong style={{ color: '#7c3aed' }}>AI Suggestion: {a.aiRecommendedAction}</strong>
                    {a.aiConfidenceScore != null && (
                      <span style={{ color: '#6d28d9', marginLeft: 8 }}>
                        ({Math.round(a.aiConfidenceScore * 100)}% confidence)
                      </span>
                    )}
                    {a.aiReasoningSummary && (
                      <div style={{ color: '#4c1d95', marginTop: 4 }}>{a.aiReasoningSummary}</div>
                    )}
                  </div>
                ) : null
              })()}
              <div className="form-group">
                <label className="form-label">Action</label>
                {(() => {
                  const hasPo = dialogIds.some(id => {
                    const a = assets.find(x => x.ID === id)
                    return a && poMap[a.masterFixedAsset]?.length > 0
                  })
                  return (
                    <>
                      {dialogSource === 'blocked' && (
                        <div style={{
                          background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6,
                          padding: '10px 12px', marginBottom: 10, fontSize: 12.5, color: '#1e40af',
                        }}>
                          <strong>These assets are already blocked in S/4.</strong>
                          <div style={{ marginTop: 4 }}>Only <strong>Delete</strong> or <strong>Keep</strong> can be submitted.</div>
                        </div>
                      )}
                      {hasPo && (
                        <div style={{
                          background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 6,
                          padding: '10px 12px', marginBottom: 10, fontSize: 12.5, color: '#92400e',
                        }}>
                          <strong>⚠ Some selected assets have linked Purchase Orders.</strong>
                          <div style={{ marginTop: 4 }}>Block and Delete are unavailable. Only <strong>Keep</strong> can be submitted.</div>
                        </div>
                      )}
                      <select className="form-select" value={recAction} onChange={e => setRecAction(e.target.value)}>
                        {REC_ACTIONS
                          .filter(a => !hasPo || a.value === 'RECOMMENDED_KEEP')
                          .filter(a => dialogSource !== 'blocked' || a.value !== 'RECOMMENDED_BLOCK')
                          .map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
                      </select>
                    </>
                  )
                })()}
              </div>
              <div className="form-group">
                <label className="form-label">Comment (optional)</label>
                <textarea className="form-textarea" value={recComment}
                  onChange={e => setRecComment(e.target.value)}
                  placeholder="Add a note about this recommendation…" />
              </div>
            </div>
            <div className="dialog-footer">
              <button className="btn btn-outline" onClick={() => setShowDialog(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleSubmitRec} disabled={dialogIds.length === 0}>
                Submit
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PO detail dialog ── */}
      {poDialogData && (
        <div className="dialog-overlay" onClick={() => setPoDialogData(null)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <div className="dialog-header">
              <span className="dialog-title">Linked Purchase Orders</span>
              <button className="dialog-close" onClick={() => setPoDialogData(null)}>✕</button>
            </div>
            <div className="dialog-body">
              <p style={{ marginBottom: 12, color: '#374151', fontSize: 13 }}>
                Asset <strong>{poDialogData.mfa}</strong> is linked to the following Purchase Orders:
              </p>
              <ul style={{ margin: '0 0 16px 0', paddingLeft: 20 }}>
                {poDialogData.poNumbers.map(po => (
                  <li key={po} style={{ fontWeight: 600, color: '#1e40af', marginBottom: 4 }}>{po}</li>
                ))}
              </ul>
              <div style={{
                background: '#fff7ed', border: '1px solid #fed7aa', borderRadius: 6,
                padding: '12px 14px', fontSize: 12.5, color: '#78350f', lineHeight: 1.6,
              }}>
                <strong>Blocking the asset can lead to problems</strong> when the goods receipt or the
                invoice receipt for this purchase order is posted.<br /><br />
                If you still want to block the asset, you must correct the account assignment to the
                asset in the purchase order.<br /><br />
                Or you must cancel the purchase order.
              </div>
            </div>
            <div className="dialog-footer">
              <button className="btn btn-primary" onClick={() => setPoDialogData(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
