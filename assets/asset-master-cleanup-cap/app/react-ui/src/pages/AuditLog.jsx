import { useState, useEffect } from 'react'
import * as api from '../api/client'

const EVENT_OPTIONS = [
  { value: '',                 label: 'All Events' },
  { value: 'SCAN_STARTED',    label: 'Scan Started' },
  { value: 'SCAN_COMPLETED',  label: 'Scan Completed' },
  { value: 'SCAN_FAILED',     label: 'Scan Failed' },
  { value: 'ASSET_REVIEWED',  label: 'Asset Reviewed' },
  { value: 'ACTION_APPROVED', label: 'Action Approved' },
  { value: 'ACTION_REJECTED', label: 'Action Rejected' },
  { value: 'WRITEBACK_SUCCESS', label: 'Write-back Success' },
  { value: 'WRITEBACK_FAILED',  label: 'Write-back Failed' },
]

function EventBadge({ type }) {
  const map = {
    SCAN_STARTED:     'badge-scan',
    SCAN_COMPLETED:   'badge-completed',
    SCAN_FAILED:      'badge-failed',
    ASSET_REVIEWED:   'badge-review',
    ACTION_APPROVED:  'badge-approve',
    ACTION_REJECTED:  'badge-rejected',
    WRITEBACK_SUCCESS:'badge-writeback',
    WRITEBACK_FAILED: 'badge-failed',
  }
  return (
    <span className={`status-badge ${map[type] || 'badge-pending'}`}>
      {type.replace(/_/g, ' ')}
    </span>
  )
}

function fmtDateTime(s) {
  if (!s) return '—'
  return new Date(s).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

export default function AuditLog() {
  const [entries,     setEntries]     = useState([])
  const [loading,     setLoading]     = useState(true)
  const [eventFilter, setEventFilter] = useState('')
  const [userFilter,  setUserFilter]  = useState('')
  const [alert,       setAlert]       = useState(null)

  useEffect(() => {
    api.fetchAuditLog()
      .then(setEntries)
      .catch(e => setAlert({ type: 'error', msg: e.message }))
      .finally(() => setLoading(false))
  }, [])

  const filtered = entries.filter(e => {
    if (eventFilter && e.eventType !== eventFilter) return false
    if (userFilter  && !(e.performedBy || '').toLowerCase().includes(userFilter.toLowerCase())) return false
    return true
  })

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Audit Log</div>
          <div className="page-subtitle">Complete trail of all actions performed in the system</div>
        </div>
      </div>

      {alert && (
        <div className={`alert alert-${alert.type}`}>{alert.msg}</div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">Events ({filtered.length})</span>
          <div className="filter-row">
            <select className="filter-select" value={eventFilter} onChange={e => setEventFilter(e.target.value)}>
              {EVENT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input className="filter-input" placeholder="Filter by user…" value={userFilter}
              onChange={e => setUserFilter(e.target.value)} />
            <button className="btn btn-outline btn-sm"
              onClick={() => { setEventFilter(''); setUserFilter('') }}>
              Reset
            </button>
          </div>
        </div>

        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Event</th>
                <th>Performed By</th>
                <th>Entity</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="table-loading">Loading audit log…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={5} className="table-empty">No entries match the current filters</td></tr>
              ) : filtered.map(e => (
                <tr key={e.ID}>
                  <td className="muted" style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
                    {fmtDateTime(e.performedAt)}
                  </td>
                  <td><EventBadge type={e.eventType} /></td>
                  <td style={{ fontWeight: 500 }}>{e.performedBy || '—'}</td>
                  <td className="muted">{e.entityType || '—'}</td>
                  <td style={{ maxWidth: 320, fontSize: 12.5, color: '#475569' }}>{e.details || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
