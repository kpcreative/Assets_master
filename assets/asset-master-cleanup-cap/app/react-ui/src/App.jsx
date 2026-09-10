import { useState, useEffect } from 'react'
import Dashboard from './pages/Dashboard'
import Rules from './pages/Rules'
import Approvals from './pages/Approvals'
import AuditLog from './pages/AuditLog'
import Settings from './pages/Settings'
import { fetchFlaggedAssets, fetchCurrentUser } from './api/client'

const NAV = [
  { key: 'dashboard', label: 'Dashboard',   icon: '▣' },
  { key: 'rules',     label: 'Rules',        icon: '⚙' },
  { key: 'approvals', label: 'Approvals',    icon: '✓' },
  { key: 'audit',     label: 'Audit Log',    icon: '≡' },
  { key: 'settings',  label: 'Settings',     icon: '◎' },
]

const PAGES = {
  dashboard: Dashboard,
  rules:     Rules,
  approvals: Approvals,
  audit:     AuditLog,
  settings:  Settings,
}

export default function App() {
  const [page, setPage] = useState('dashboard')
  const [pendingCount, setPendingCount] = useState(0)
  const [user, setUser] = useState({ name: '', initials: '…', isAdmin: false })

  const refreshBadge = () => {
    fetchFlaggedAssets()
      .then(assets => {
        const n = assets.filter(a =>
          ['RECOMMENDED_BLOCK', 'RECOMMENDED_DELETE', 'RECOMMENDED_KEEP'].includes(a.reviewStatus)
        ).length
        setPendingCount(n)
      })
      .catch(() => {})
  }

  useEffect(() => { refreshBadge() }, [page])

  useEffect(() => {
    fetchCurrentUser()
      .then(u => setUser(u))
      .catch(() => setUser({ name: 'SAP Demo User', initials: 'U', isAdmin: false }))
  }, [])

  // Non-admins cannot open the Approvals page — bounce them to the dashboard
  useEffect(() => {
    if (!user.isAdmin && page === 'approvals') setPage('dashboard')
  }, [user.isAdmin, page])

  const visibleNav = NAV.filter(n => n.key !== 'approvals' || user.isAdmin)

  const Page = PAGES[page]

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-logo">
          <div className="header-logo-icon">S</div>
          Asset Master Data Monitor
        </div>
        <div className="header-spacer" />
        <div className="header-user">
          <span>{user.name}</span>
          <div className="user-avatar">{user.initials}</div>
        </div>
      </header>

      <div className="app-body">
        <nav className="sidebar">
          <div className="sidebar-section-title">Navigation</div>
          {visibleNav.map(({ key, label, icon }) => (
            <button
              key={key}
              className={`sidebar-item${page === key ? ' active' : ''}`}
              onClick={() => setPage(key)}
            >
              <span className="item-icon">{icon}</span>
              <span className="item-label">{label}</span>
              {key === 'approvals' && pendingCount > 0 && (
                <span className="sidebar-badge">{pendingCount}</span>
              )}
            </button>
          ))}
        </nav>

        <main className="content">
          <Page onNavigate={setPage} onBadgeRefresh={refreshBadge} isAdmin={user.isAdmin} />
        </main>
      </div>
    </div>
  )
}
