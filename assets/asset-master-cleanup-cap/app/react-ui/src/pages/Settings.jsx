import { useState, useEffect, useCallback } from 'react'
import * as api from '../api/client'

export default function Settings({ isAdmin }) {
  const [recipients, setRecipients] = useState([])
  const [loading,    setLoading]    = useState(true)
  const [showDialog, setShowDialog] = useState(false)
  const [form,       setForm]       = useState({ email: '', role: 'ASSET_ACCOUNTANT', isActive: true })
  const [alert,      setAlert]      = useState(null)
  const [admins,     setAdmins]     = useState([])
  const [adminEmail, setAdminEmail] = useState('')

  const loadData = useCallback(async () => {
    setLoading(true)
    try {
      setRecipients(await api.fetchAlertRecipients())
      if (isAdmin) {
        try { setAdmins(await api.fetchAdmins()) } catch { /* non-admin or unavailable */ }
      }
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  useEffect(() => { loadData() }, [loadData])

  const handleAddAdmin = async () => {
    const email = adminEmail.trim().toLowerCase()
    if (!email) return
    try {
      await api.addAdmin(email)
      setAdminEmail('')
      setAdmins(await api.fetchAdmins())
      setAlert({ type: 'success', msg: `Admin added: ${email}` })
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    }
  }

  const handleRemoveAdmin = async (email) => {
    if (!window.confirm(`Remove admin access for ${email}?`)) return
    try {
      await api.removeAdmin(email)
      setAdmins(await api.fetchAdmins())
      setAlert({ type: 'success', msg: `Admin removed: ${email}` })
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    }
  }

  const handleCreate = async () => {
    try {
      await api.createRecipient({ email: form.email, role: form.role, isActive: form.isActive })
      setShowDialog(false)
      setForm({ email: '', role: 'ASSET_ACCOUNTANT', isActive: true })
      await loadData()
      setAlert({ type: 'success', msg: 'Recipient added.' })
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    }
  }

  const handleDelete = async (id) => {
    if (!window.confirm('Remove this alert recipient?')) return
    try {
      await api.deleteRecipient(id)
      await loadData()
      setAlert({ type: 'success', msg: 'Recipient removed.' })
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    }
  }

  const accountants = recipients.filter(r => r.role === 'ASSET_ACCOUNTANT')
  const managers    = recipients.filter(r => r.role === 'FINANCE_MANAGER')

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Alert Recipients</div>
          <div className="page-subtitle">Configure who receives email notifications for scans and approvals</div>
        </div>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setShowDialog(true)}>+ Add Recipient</button>
        )}
      </div>

      {alert && (
        <div className={`alert alert-${alert.type}`}>
          <span>{alert.msg}</span>
          <button className="alert-close" onClick={() => setAlert(null)}>✕</button>
        </div>
      )}

      <div className="stats-row" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <div className="stat-card accent-blue">
          <div className="stat-value">{accountants.length}</div>
          <div className="stat-label">Asset Accountants</div>
        </div>
        <div className="stat-card accent-green">
          <div className="stat-value">{managers.length}</div>
          <div className="stat-label">Finance Managers</div>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <span className="card-title">Recipients ({recipients.length})</span>
        </div>
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Email Address</th>
                <th>Role</th>
                <th>Notification Type</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="table-loading">Loading…</td></tr>
              ) : recipients.length === 0 ? (
                <tr><td colSpan={5} className="table-empty">No recipients configured</td></tr>
              ) : recipients.map(r => (
                <tr key={r.ID}>
                  <td style={{ fontWeight: 500 }}>{r.email}</td>
                  <td>
                    <span className={`status-badge ${r.role === 'ASSET_ACCOUNTANT' ? 'badge-rec-keep' : 'badge-approve'}`}>
                      {r.role === 'ASSET_ACCOUNTANT' ? 'Asset Accountant' : 'Finance Manager'}
                    </span>
                  </td>
                  <td className="muted" style={{ fontSize: 12.5 }}>
                    {r.role === 'ASSET_ACCOUNTANT'
                      ? 'Receives scan completion alerts'
                      : 'Receives approval request notifications'}
                  </td>
                  <td>
                    <span className={`status-badge ${r.isActive ? 'badge-approved' : 'badge-pending'}`}>
                      {r.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td>
                    {isAdmin && (
                      <button className="btn btn-danger btn-sm" onClick={() => handleDelete(r.ID)}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {isAdmin && (
        <div className="card">
          <div className="card-header">
            <span className="card-title">Administrators ({admins.length})</span>
          </div>
          <div style={{ padding: '14px 18px' }}>
            <p style={{ fontSize: 13, color: '#475569', marginBottom: 12, lineHeight: 1.6 }}>
              Admins can approve/reject recommendations, execute write-back, manage recipients, and manage this list.
              A user's login email is matched against these entries.
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <input
                className="form-input"
                type="email"
                value={adminEmail}
                onChange={e => setAdminEmail(e.target.value)}
                placeholder="admin.email@company.com"
                style={{ maxWidth: 320 }}
                onKeyDown={e => { if (e.key === 'Enter') handleAddAdmin() }}
              />
              <button className="btn btn-primary" onClick={handleAddAdmin} disabled={!adminEmail.trim()}>
                Add Admin
              </button>
            </div>
            <div className="table-container">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Email Address</th>
                    <th>Added By</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {admins.length === 0 ? (
                    <tr><td colSpan={3} className="table-empty">No administrators configured</td></tr>
                  ) : admins.map(a => (
                    <tr key={a.email}>
                      <td style={{ fontWeight: 500 }}>{a.email}</td>
                      <td className="muted">{a.addedBy || '—'}</td>
                      <td>
                        {a.addedBy === 'system (permanent)' ? (
                          <span className="muted" style={{ fontSize: 12.5 }}>Permanent</span>
                        ) : (
                          <button className="btn btn-danger btn-sm" onClick={() => handleRemoveAdmin(a.email)}>Remove</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-header">
          <span className="card-title">How Notifications Work</span>
        </div>
        <div style={{ padding: '14px 18px', fontSize: 13, lineHeight: 1.7, color: '#475569' }}>
          <div style={{ marginBottom: 10 }}>
            <strong style={{ color: '#1d2d3e' }}>Asset Accountants</strong> receive an email
            after each scan completes that flagged at least one asset. The email includes the scan ID
            and the number of new records requiring review.
          </div>
          <div>
            <strong style={{ color: '#1d2d3e' }}>Finance Managers</strong> receive approval request
            emails when the Asset Accountant submits recommendations.
            In development mode, emails are logged to the server console instead of being sent.
          </div>
        </div>
      </div>

      {showDialog && (
        <div className="dialog-overlay" onClick={() => setShowDialog(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <div className="dialog-header">
              <span className="dialog-title">Add Alert Recipient</span>
              <button className="dialog-close" onClick={() => setShowDialog(false)}>✕</button>
            </div>
            <div className="dialog-body">
              <div className="form-group">
                <label className="form-label">Email Address *</label>
                <input className="form-input" type="email" value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  placeholder="user@company.com" />
              </div>
              <div className="form-group">
                <label className="form-label">Role</label>
                <select className="form-select" value={form.role}
                  onChange={e => setForm({ ...form, role: e.target.value })}>
                  <option value="ASSET_ACCOUNTANT">Asset Accountant — receives scan alerts</option>
                  <option value="FINANCE_MANAGER">Finance Manager — receives approval requests</option>
                </select>
              </div>
              <div className="form-group">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label className="toggle">
                    <input type="checkbox" checked={form.isActive}
                      onChange={e => setForm({ ...form, isActive: e.target.checked })} />
                    <span className="toggle-slider" />
                  </label>
                  <span style={{ fontSize: 13, color: '#374151' }}>Active — send notifications immediately</span>
                </div>
              </div>
            </div>
            <div className="dialog-footer">
              <button className="btn btn-outline" onClick={() => setShowDialog(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreate} disabled={!form.email}>
                Add Recipient
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
