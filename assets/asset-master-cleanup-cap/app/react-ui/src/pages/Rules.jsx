import { useState, useEffect, useCallback } from 'react'
import * as api from '../api/client'

const FIELD_OPTIONS = [
  { value: 'ZUGDT',                label: 'ZUGDT — Acquisition Value Date' },
  { value: 'AKTIV',                label: 'AKTIV — Capitalization Date' },
  { value: 'DEAKT',                label: 'DEAKT — Deactivation Date' },
  { value: 'XLOEV',                label: 'XLOEV — Block Flag Date' },
  { value: 'FixedAssetDescription', label: 'Fixed Asset Description' },
]

const COND_OPTIONS = [
  { value: 'IS_EMPTY',         label: 'Is Empty' },
  { value: 'IS_NOT_EMPTY',     label: 'Is Not Empty' },
  { value: 'CONTAINS_KEYWORD', label: 'Contains Keyword' },
]

export default function Rules() {
  const [rules,    setRules]    = useState([])
  const [loading,  setLoading]  = useState(true)
  const [expanded, setExpanded] = useState(null)
  const [alert,    setAlert]    = useState(null)

  const [showRuleDialog, setShowRuleDialog] = useState(false)
  const [ruleForm, setRuleForm] = useState({ name: '', description: '', ageDaysThreshold: 90, isActive: true })

  const [showCondDialog, setShowCondDialog] = useState(false)
  const [condForRule,    setCondForRule]    = useState(null)
  const [condForm, setCondForm] = useState({ fieldName: 'ZUGDT', conditionType: 'IS_EMPTY', keywordValue: '' })

  const loadRules = useCallback(async () => {
    setLoading(true)
    try {
      setRules(await api.fetchMonitoringRules())
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadRules() }, [loadRules])

  const handleToggle = async (rule) => {
    try {
      await api.updateRule(rule.ID, { isActive: !rule.isActive })
      await loadRules()
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    }
  }

  const handleDeleteRule = async (id) => {
    if (!window.confirm('Delete this rule and all its conditions? This cannot be undone.')) return
    try {
      await api.deleteRule(id)
      setExpanded(null)
      await loadRules()
      setAlert({ type: 'success', msg: 'Rule deleted.' })
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    }
  }

  const handleCreateRule = async () => {
    try {
      await api.createRule({
        name: ruleForm.name,
        description: ruleForm.description || null,
        ageDaysThreshold: Number(ruleForm.ageDaysThreshold),
        isActive: ruleForm.isActive,
      })
      setShowRuleDialog(false)
      setRuleForm({ name: '', description: '', ageDaysThreshold: 90, isActive: true })
      await loadRules()
      setAlert({ type: 'success', msg: 'Rule created.' })
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    }
  }

  const handleAddCondition = async () => {
    const body = { rule_ID: condForRule, fieldName: condForm.fieldName, conditionType: condForm.conditionType }
    if (condForm.conditionType === 'CONTAINS_KEYWORD') body.keywordValue = condForm.keywordValue
    try {
      await api.createCondition(body)
      setShowCondDialog(false)
      setCondForm({ fieldName: 'ZUGDT', conditionType: 'IS_EMPTY', keywordValue: '' })
      await loadRules()
      setAlert({ type: 'success', msg: 'Condition added.' })
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    }
  }

  const handleDeleteCondition = async (condId) => {
    try {
      await api.deleteCondition(condId)
      await loadRules()
    } catch (e) {
      setAlert({ type: 'error', msg: e.message })
    }
  }

  const openCondDialog = (ruleId) => {
    setCondForRule(ruleId)
    setShowCondDialog(true)
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <div className="page-title">Monitoring Rules</div>
          <div className="page-subtitle">Rules define which assets are flagged during each scan</div>
        </div>
        <button className="btn btn-primary" onClick={() => setShowRuleDialog(true)}>+ Add Rule</button>
      </div>

      {alert && (
        <div className={`alert alert-${alert.type}`}>
          <span>{alert.msg}</span>
          <button className="alert-close" onClick={() => setAlert(null)}>✕</button>
        </div>
      )}

      <div className="card">
        <div className="table-container">
          <table className="data-table">
            <thead>
              <tr>
                <th>Rule Name</th>
                <th>Age Threshold</th>
                <th>Conditions</th>
                <th>Active</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={5} className="table-loading">Loading rules…</td></tr>
              ) : rules.length === 0 ? (
                <tr><td colSpan={5} className="table-empty">No rules defined yet</td></tr>
              ) : rules.flatMap(rule => {
                const conditions = rule.conditions || []
                const rows = [
                  <tr key={rule.ID}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{rule.name}</div>
                      {rule.description && (
                        <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{rule.description}</div>
                      )}
                    </td>
                    <td>
                      <span style={{ fontWeight: 700 }}>{rule.ageDaysThreshold}</span>
                      <span style={{ color: '#64748b' }}> days</span>
                    </td>
                    <td>
                      <button className="btn btn-ghost btn-sm"
                        onClick={() => setExpanded(expanded === rule.ID ? null : rule.ID)}>
                        {conditions.length} condition{conditions.length !== 1 ? 's' : ''}
                        {' '}{expanded === rule.ID ? '▲' : '▼'}
                      </button>
                    </td>
                    <td>
                      <label className="toggle">
                        <input type="checkbox" checked={rule.isActive} onChange={() => handleToggle(rule)} />
                        <span className="toggle-slider" />
                      </label>
                    </td>
                    <td>
                      <div className="flex-gap">
                        <button className="btn btn-ghost btn-sm" onClick={() => openCondDialog(rule.ID)}>
                          + Condition
                        </button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDeleteRule(rule.ID)}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ]

                if (expanded === rule.ID) {
                  rows.push(
                    <tr key={`${rule.ID}-exp`}>
                      <td colSpan={5} style={{ padding: 0 }}>
                        <div className="conditions-panel">
                          <div className="conditions-header">
                            Field Conditions — ALL must be true (AND logic)
                          </div>
                          {conditions.length === 0 ? (
                            <div className="no-conditions">
                              No conditions yet. Click "+ Condition" to add one.
                            </div>
                          ) : conditions.map(c => (
                            <div key={c.ID} className="condition-item">
                              <span className="cond-field">{c.fieldName}</span>
                              <span className="cond-type">{c.conditionType.replace(/_/g, ' ')}</span>
                              {c.keywordValue && (
                                <span className="cond-value">"{c.keywordValue}"</span>
                              )}
                              <button className="btn btn-danger btn-sm" style={{ marginLeft: 'auto' }}
                                onClick={() => handleDeleteCondition(c.ID)}>
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )
                }

                return rows
              })}
            </tbody>
          </table>
        </div>
      </div>

      {showRuleDialog && (
        <div className="dialog-overlay" onClick={() => setShowRuleDialog(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <div className="dialog-header">
              <span className="dialog-title">Create Monitoring Rule</span>
              <button className="dialog-close" onClick={() => setShowRuleDialog(false)}>✕</button>
            </div>
            <div className="dialog-body">
              <div className="form-group">
                <label className="form-label">Rule Name *</label>
                <input className="form-input" value={ruleForm.name}
                  onChange={e => setRuleForm({ ...ruleForm, name: e.target.value })}
                  placeholder="e.g. Uncapitalized Assets (>90 days)" />
              </div>
              <div className="form-group">
                <label className="form-label">Description</label>
                <textarea className="form-textarea" value={ruleForm.description}
                  onChange={e => setRuleForm({ ...ruleForm, description: e.target.value })}
                  placeholder="Describe what this rule detects…" />
              </div>
              <div className="form-group">
                <label className="form-label">Age Threshold (days) *</label>
                <input className="form-input" type="number" min={1} value={ruleForm.ageDaysThreshold}
                  onChange={e => setRuleForm({ ...ruleForm, ageDaysThreshold: e.target.value })} />
                <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 4 }}>
                  Assets must be older than this many days to be evaluated by this rule
                </div>
              </div>
              <div className="form-group">
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label className="toggle">
                    <input type="checkbox" checked={ruleForm.isActive}
                      onChange={e => setRuleForm({ ...ruleForm, isActive: e.target.checked })} />
                    <span className="toggle-slider" />
                  </label>
                  <span style={{ fontSize: 13, color: '#374151' }}>Active — enable immediately</span>
                </div>
              </div>
            </div>
            <div className="dialog-footer">
              <button className="btn btn-outline" onClick={() => setShowRuleDialog(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleCreateRule}
                disabled={!ruleForm.name || !ruleForm.ageDaysThreshold}>
                Create Rule
              </button>
            </div>
          </div>
        </div>
      )}

      {showCondDialog && (
        <div className="dialog-overlay" onClick={() => setShowCondDialog(false)}>
          <div className="dialog" onClick={e => e.stopPropagation()}>
            <div className="dialog-header">
              <span className="dialog-title">Add Field Condition</span>
              <button className="dialog-close" onClick={() => setShowCondDialog(false)}>✕</button>
            </div>
            <div className="dialog-body">
              <div className="form-group">
                <label className="form-label">SAP Field</label>
                <select className="form-select" value={condForm.fieldName}
                  onChange={e => setCondForm({ ...condForm, fieldName: e.target.value })}>
                  {FIELD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Condition</label>
                <select className="form-select" value={condForm.conditionType}
                  onChange={e => setCondForm({ ...condForm, conditionType: e.target.value })}>
                  {COND_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </div>
              {condForm.conditionType === 'CONTAINS_KEYWORD' && (
                <div className="form-group">
                  <label className="form-label">Keyword *</label>
                  <input className="form-input" value={condForm.keywordValue}
                    onChange={e => setCondForm({ ...condForm, keywordValue: e.target.value })}
                    placeholder="e.g. dummy, test, temp" />
                  <div style={{ fontSize: 11.5, color: '#64748b', marginTop: 4 }}>Case-insensitive partial match</div>
                </div>
              )}
            </div>
            <div className="dialog-footer">
              <button className="btn btn-outline" onClick={() => setShowCondDialog(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAddCondition}
                disabled={condForm.conditionType === 'CONTAINS_KEYWORD' && !condForm.keywordValue}>
                Add Condition
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
