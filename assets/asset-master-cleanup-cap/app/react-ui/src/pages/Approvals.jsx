import { useState, useEffect, useCallback } from 'react'
import * as api from '../api/client'

const REC_STATUSES = ['RECOMMENDED_BLOCK', 'RECOMMENDED_DELETE', 'RECOMMENDED_KEEP']
const RELEVANT_STATUSES = [...REC_STATUSES, 'APPROVED', 'EXECUTED', 'FAILED', 'REJECTED']

function StatusBadge({ status }) {
  const map = {
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

// SAP packs Diagnosis / System Response / Procedure into one concatenated string.
// This splits it back into the three labelled parts.
function parseProcedureText(raw) {
  if (!raw) return { diagnosis: '', systemResponse: '', procedure: '' }
  const diagMatch = raw.match(/Diagnosis:([\s\S]*?)(?=System Response:|Procedure:|$)/)
  const sysMatch  = raw.match(/System Response:([\s\S]*?)(?=Procedure:|$)/)
  const procMatch = raw.match(/Procedure:([\s\S]*)$/)
  return {
    diagnosis:      diagMatch ? diagMatch[1].trim() : '',
    systemResponse: sysMatch  ? sysMatch[1].trim()  : '',
    procedure:      procMatch ? procMatch[1].trim()  : (!diagMatch && !sysMatch ? raw.trim() : ''),
  }
}

export default function Approvals({ onBadgeRefresh }) {
  const [assets,    setAssets]    = useState([])
  const [loading,   setLoading]   = useState(true)
  const [tab,       setTab]       = useState('pending')
  const [selected,  setSelected]  = useState(new Set())
  const [alert,     setAlert]     = useState(null)
  const [executing, setExecuting] = useState(false)
  const [deleteError,   setDeleteError]   = useState(null)
  const [deleteVisible, setDeleteVisible] = useState(false)

  const [rejectId,     setRejectId]     = useState(null)
  const [rejectReason, setRejectReason] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      const all = await api.fetchFlaggedAssets()
      setAssets(all.filter(a => RELEVANT_STATUSES.includes(a.reviewStatus)))
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const counts = {
    pending:  assets.filter(a => REC_STATUSES.includes(a.reviewStatus)).length,
    approved: assets.filter(a => a.reviewStatus === 'APPROVED').length,
    executed: assets.filter(a => a.reviewStatus === 'EXECUTED').length,
    failed:   assets.filter(a => a.reviewStatus === 'FAILED').length,
    rejected: assets.filter(a => a.reviewStatus === 'REJECTED').length,
  }

  const filtered = assets.filter(a => {
    if (tab === 'pending')  return REC_STATUSES.includes(a.reviewStatus)
    if (tab === 'approved') return a.reviewStatus === 'APPROVED'
    return true
  })

  const allSelected = filtered.length > 0 && filtered.every(a => selected.has(a.ID))
  const toggleAll  = () => allSelected ? setSelected(new Set()) : setSelected(new Set(filtered.map(a => a.ID)))
  const toggleOne  = id => { const s = new Set(selected); s.has(id) ? s.delete(id) : s.add(id); setSelected(s) }
  const changeTab  = t  => { setTab(t); setSelected(new Set()) }

  const closeDeleteError = () => {
    setDeleteVisible(false)
    setTimeout(() => setDeleteError(null), 400)
  }

  const onSendToAI = (assetData, errorData, procedureData) => {
    console.log('[SendToAI] asset:', assetData, 'error:', errorData, 'procedure:', procedureData)
    // AI integration will be connected here later
  }

  const pendingSelected  = [...selected].filter(id => assets.find(a => a.ID === id && REC_STATUSES.includes(a.reviewStatus))).length
  const approvedSelected = [...selected].filter(id => assets.find(a => a.ID === id)?.reviewStatus === 'APPROVED').length

  const handleApprove = async (id) => {
    try {
      await api.approveAction(id)
      setAlert({ type: 'success', msg: 'Asset approved.' })
      await loadData()
      if (onBadgeRefresh) onBadgeRefresh()
    } catch (e) { setAlert({ type: 'error', msg: e.message }) }
  }

  const handleMassApprove = async () => {
    const ids = [...selected].filter(id => assets.find(a => a.ID === id && REC_STATUSES.includes(a.reviewStatus)))
    try {
      const res = await api.massApproveActions(ids)
      setAlert({ type: 'success', msg: `${res.approved} asset(s) approved.` })
      setSelected(new Set())
      await loadData()
      if (onBadgeRefresh) onBadgeRefresh()
    } catch (e) { setAlert({ type: 'error', msg: e.message }) }
  }

  const handleReject = async () => {
    try {
      await api.rejectAction(rejectId, rejectReason)
      setAlert({ type: 'success', msg: 'Asset rejected.' })
      setRejectId(null)
      setRejectReason('')
      await loadData()
      if (onBadgeRefresh) onBadgeRefresh()
    } catch (e) { setAlert({ type: 'error', msg: e.message }) }
  }

  const handleExecuteIds = async (ids) => {
    if (!ids.length) { setAlert({ type: 'error', msg: 'No approved assets selected for write-back.' }); return }
    setExecuting(true)
    try {
      const res = await api.executeApprovedActions(ids)
      if (res.failed === 0) {
        setAlert({ type: 'success', msg: `Write-back: ${res.executed} asset(s) deleted successfully.` })
      } else {
        setAlert({ type: 'info', msg: `Write-back: ${res.executed} succeeded, ${res.failed} failed.` })
        if (res.errors?.length) {
          setDeleteError(res.errors)
          setTimeout(() => setDeleteVisible(true), 10)
        }
      }
      setSelected(new Set())
      await loadData()
    } catch (e) { setAlert({ type: 'error', msg: e.message }) }
    finally { setExecuting(false) }
  }

  const massExecuteIds = [...selected].filter(id => assets.find(a => a.ID === id)?.reviewStatus === 'APPROVED')

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Approval Queue</div>
          <div className="page-subtitle">Finance Manager review — approve or reject Asset Accountant recommendations</div>
        </div>
      </div>

      {alert && (
        <div className={`alert alert-${alert.type}`}>
          <span>{alert.msg}</span>
          <button className="alert-close" onClick={() => setAlert(null)}>✕</button>
        </div>
      )}

      {deleteError && deleteError.map((errItem, i) => (
        <div
          key={i}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={closeDeleteError}
        >
          <div
            style={{
              background: '#fff', borderRadius: 10, width: 520, maxWidth: '92vw',
              boxShadow: '0 8px 32px rgba(0,0,0,0.22)',
              animation: `${deleteVisible ? 'fadeInModal' : 'fadeOutModal'} 400ms ease-in both`,
              overflow: 'hidden',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ background: '#b91c1c', color: '#fff', padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>⚠</span>
              <span style={{ fontWeight: 700, fontSize: 15 }}>Deletion Failed</span>
            </div>

            <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>

              <div>
                <div style={{ fontWeight: 600, fontSize: 12.5, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Asset Information</div>
                <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 8, display: 'grid', gridTemplateColumns: '140px 1fr', gap: '4px 8px', fontSize: 13.5 }}>
                  <span style={{ color: '#64748b' }}>Company Code</span>  <span>{errItem.bukrs || errItem.companyCode}</span>
                  <span style={{ color: '#64748b' }}>Asset Number</span>  <span>{errItem.anln1 || errItem.masterFixedAsset}</span>
                  <span style={{ color: '#64748b' }}>Sub Number</span>    <span>{errItem.anln2 || errItem.fixedAsset || '0'}</span>
                </div>
              </div>

              <div>
                <div style={{ fontWeight: 600, fontSize: 12.5, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Error</div>
                <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 8, background: '#fff1f2', border: '1px solid #fca5a5', borderRadius: 6, padding: '10px 12px', fontSize: 13.5, color: '#b91c1c' }}>
                  {errItem.messages || errItem.message}
                </div>
              </div>

              {(errItem.diagnosis || errItem.systemResponse || errItem.procedure) && (() => {
                const p = parseProcedureText(errItem.procedure)
                const diag    = errItem.diagnosis      || p.diagnosis
                const sysResp = errItem.systemResponse || p.systemResponse
                const proc    = p.procedure            || (!p.diagnosis && !p.systemResponse ? '' : errItem.procedure)
                return (
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 12.5, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Details</div>
                    <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {diag && (
                        <div style={{ fontSize: 13, color: '#374151' }}>
                          <div style={{ fontWeight: 600, color: '#64748b', marginBottom: 2 }}>Diagnosis</div>
                          <div>{diag}</div>
                        </div>
                      )}
                      {sysResp && (
                        <div style={{ fontSize: 13, color: '#374151' }}>
                          <div style={{ fontWeight: 600, color: '#64748b', marginBottom: 2 }}>System Response</div>
                          <div>{sysResp}</div>
                        </div>
                      )}
                      {proc && (
                        <div style={{ fontSize: 13, color: '#374151' }}>
                          <div style={{ fontWeight: 600, color: '#64748b', marginBottom: 2 }}>Procedure</div>
                          <div>{proc}</div>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}
            </div>

            <div style={{ padding: '12px 18px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
              <button
                className="btn btn-primary"
                style={{ background: '#7c3aed', borderColor: '#7c3aed' }}
                onClick={() => {
                  const p = parseProcedureText(errItem.procedure)
                  onSendToAI(
                    { bukrs: errItem.bukrs, anln1: errItem.anln1, anln2: errItem.anln2 },
                    { messages: errItem.messages },
                    {
                      diagnosis:      errItem.diagnosis      || p.diagnosis,
                      systemResponse: errItem.systemResponse || p.systemResponse,
                      procedure:      p.procedure,
                    }
                  )
                }}
              >
                Send to AI
              </button>
              <button className="btn btn-secondary" onClick={closeDeleteError}>Close</button>
            </div>
          </div>
        </div>
      ))}

      <div className="stats-row">
        <div className="stat-card accent-orange">
          <div className="stat-value">{counts.pending}</div>
          <div className="stat-label">Awaiting Approval</div>
        </div>
        <div className="stat-card accent-blue">
          <div className="stat-value">{counts.approved}</div>
          <div className="stat-label">Approved (ready)</div>
        </div>
        <div className="stat-card accent-green">
          <div className="stat-value">{counts.executed}</div>
          <div className="stat-label">Executed in S/4HANA</div>
        </div>
        <div className="stat-card accent-red">
          <div className="stat-value">{counts.failed}</div>
          <div className="stat-label">Failed</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 0, padding: 0 }}>
          <div className="tab-bar" style={{ padding: '0 16px' }}>
            <button className={`tab-btn${tab === 'pending'  ? ' active' : ''}`} onClick={() => changeTab('pending')}>
              Pending Approval ({counts.pending})
            </button>
            <button className={`tab-btn${tab === 'approved' ? ' active' : ''}`} onClick={() => changeTab('approved')}>
              Approved ({counts.approved})
            </button>
            <button className={`tab-btn${tab === 'all'      ? ' active' : ''}`} onClick={() => changeTab('all')}>
              All ({assets.length})
            </button>
          </div>
        </div>

        <div className={`table-toolbar${selected.size === 0 ? ' hidden' : ''}`}>
          <span>{selected.size} selected</span>
          {tab === 'pending' && (
            <button className="btn btn-success btn-sm" onClick={handleMassApprove} disabled={pendingSelected === 0}>
              ✓ Approve ({pendingSelected})
            </button>
          )}
          {(tab === 'approved' || tab === 'all') && (
            <button className="btn btn-primary btn-sm" disabled={executing || approvedSelected === 0}
              onClick={() => handleExecuteIds(massExecuteIds)}>
              {executing ? '⟳ Executing…' : `▶ Execute Write-back (${approvedSelected})`}
            </button>
          )}
          <button className="btn btn-outline btn-sm" onClick={() => setSelected(new Set())}>Clear</button>
        </div>

        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th className="checkbox-cell">
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} disabled={filtered.length === 0} />
                </th>
                <th>Company</th>
                <th>Asset No.</th>
                <th>Description</th>
                <th>Days Old</th>
                <th>Recommendation</th>
                <th>Reviewed By</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="table-loading">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={8} className="table-empty">No items in this queue</td></tr>
              ) : filtered.map(a => (
                <tr key={a.ID}>
                  <td className="checkbox-cell">
                    <input type="checkbox" checked={selected.has(a.ID)} onChange={() => toggleOne(a.ID)} />
                  </td>
                  <td style={{ fontWeight: 600 }}>{a.companyCode}</td>
                  <td className="muted mono">{a.masterFixedAsset}</td>
                  <td>{a.assetDescription || '—'}</td>
                  <td style={{ textAlign: 'center', fontWeight: 600 }}>{a.daysSinceCreation}</td>
                  <td><StatusBadge status={a.reviewStatus} /></td>
                  <td className="muted">{a.reviewedBy || '—'}</td>
                  <td>
                    <div className="flex-gap">
                      {REC_STATUSES.includes(a.reviewStatus) && (
                        <>
                          <button className="btn btn-success btn-sm" title="Approve" onClick={() => handleApprove(a.ID)}>✓</button>
                          <button className="btn btn-danger btn-sm" title="Reject" onClick={() => setRejectId(a.ID)}>✕</button>
                        </>
                      )}
                      {a.reviewStatus === 'APPROVED' && (
                        <button className="btn btn-primary btn-sm" disabled={executing}
                          onClick={() => handleExecuteIds([a.ID])}>
                          ▶
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {rejectId && (
        <div className="dialog-overlay" onClick={() => setRejectId(null)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <div className="dialog-header">
              <span className="dialog-title">Reject Recommendation</span>
              <button className="dialog-close" onClick={() => setRejectId(null)}>✕</button>
            </div>
            <div className="dialog-body">
              <div className="form-group">
                <label className="form-label">Reason for Rejection</label>
                <textarea className="form-textarea" value={rejectReason}
                  onChange={e => setRejectReason(e.target.value)}
                  placeholder="Explain why this recommendation is being rejected…" />
              </div>
            </div>
            <div className="dialog-footer">
              <button className="btn btn-outline" onClick={() => { setRejectId(null); setRejectReason('') }}>Cancel</button>
              <button className="btn btn-danger" onClick={handleReject}>Reject</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
