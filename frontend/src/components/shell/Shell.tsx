import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { LogOut, Monitor, Moon, Sun } from 'lucide-react'
import { useApi } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { MODULES, moduleFor, tabFor, type Module, type ModuleTab } from '../../lib/nav'
import { THEME_LABELS, useTheme } from '../../lib/theme'
import { BrandMark } from '../ui'
import { guardNavigation } from './unsaved'

export function useReviewCount(enabled = true): number {
  const count = useApi<{ total: number }>('/admin/reviews/count', { enabled, poll: 30000 })
  return count.data?.total ?? 0
}

function NavItem({ module, active }: { module: Module; active: boolean }) {
  const Icon = module.icon
  return <Link to={module.to} className="tm-nav" aria-current={active ? 'page' : undefined} title={module.label} onClick={guardNavigation}>
    <Icon size={16} strokeWidth={1.7} aria-hidden="true" /><span>{module.label}</span>
  </Link>
}

/**
 * Workspace sidebar (216px): brand, the work itself at the top (grouped), governance and system pages flat at the
 * bottom, then the account row with the theme switch and sign-out. Nav items never carry numbers.
 */
export function Sidebar() {
  const { user, signOut } = useAuth()
  const { pathname } = useLocation()
  const { choice, next } = useTheme()
  const admin = user?.role === 'admin'
  const current = moduleFor(pathname)
  const visible = MODULES.filter(module => admin || !module.admin)
  const top = visible.filter(module => module.placement === 'top')
  const bottom = visible.filter(module => module.placement === 'bottom')
  const groups = [...new Set(top.map(module => module.group ?? ''))]
  const name = user?.display_name || user?.username || '?'
  const ThemeIcon = choice === 'dark' ? Moon : choice === 'light' ? Sun : Monitor
  const themeLabel = `主题：${THEME_LABELS[choice]}，点按切换`
  return <aside className="tm-side">
    <div className="tm-side-head"><Link to="/chat" className="tm-brand" aria-label="TraceMind 首页" onClick={guardNavigation}><BrandMark size={22} /><span>TraceMind</span></Link></div>
    <nav aria-label="主要导航" className="tm-side-nav">
      {groups.map(group => <div key={group} className="tm-nav-group">
        {group && <div className="tm-nav-label">{group}</div>}
        {top.filter(module => (module.group ?? '') === group).map(module => <NavItem key={module.key} module={module} active={current?.key === module.key} />)}
      </div>)}
      {bottom.length > 0 && <div className="tm-side-bottom">
        {bottom.map(module => <NavItem key={module.key} module={module} active={current?.key === module.key} />)}
      </div>}
    </nav>
    <div className="tm-side-foot">
      <Link to="/account/profile" className="tm-account" aria-current={current?.key === 'account' ? 'page' : undefined} title={`${name} · 我的账户`} aria-label="我的账户" onClick={guardNavigation}>
        <span className="tm-avatar" aria-hidden="true">{name.slice(0, 1)}</span>
        <span className="tm-user"><b>{name}</b><span>{user?.role === 'admin' ? '管理员' : '员工'}</span></span>
      </Link>
      <button type="button" className="tm-icon-btn" aria-label={themeLabel} title={themeLabel} onClick={next}><ThemeIcon size={16} strokeWidth={1.7} aria-hidden="true" /></button>
      <button type="button" className="tm-icon-btn" aria-label="退出登录" title="退出登录" onClick={event => { if (guardNavigation(event)) void signOut() }}><LogOut size={16} strokeWidth={1.7} aria-hidden="true" /></button>
    </div>
  </aside>
}

function TabCount({ tab }: { tab: ModuleTab }) {
  const pending = useReviewCount(tab.count === 'reviews-pending')
  const decided = useApi<{ total: number }>('/admin/reviews/history?limit=1', { enabled: tab.count === 'reviews-decided' })
  if (tab.count === 'reviews-pending') return pending > 0 ? <span className="tm-tab-badge">{pending > 99 ? '99+' : pending}</span> : null
  if (tab.count === 'reviews-decided' && decided.data) return <span className="tm-tab-count">{decided.data.total}</span>
  return null
}

/** A module's sub-pages as underline tabs, directly under the page header. */
function ModuleTabs({ module, current }: { module: Module; current: ModuleTab }) {
  const admin = useAuth().user?.role === 'admin'
  const tabs = (module.tabs ?? []).filter(tab => admin || !tab.admin)
  if (tabs.length < 2) return null
  return <nav className="tm-subnav tm-tabs" aria-label={`${module.label}导航`}>
    {tabs.map(tab => <NavLink key={tab.to} to={tab.to} end className="tm-tab" aria-current={tab === current ? 'page' : undefined} onClick={guardNavigation}>
      {tab.label}{tab.count && <TabCount tab={tab} />}
    </NavLink>)}
  </nav>
}

export interface Crumb { to: string; label: string }

/**
 * Page header (56px: module icon, breadcrumbs, title, actions) + module tabs + body.
 * The main column hosts drawers.
 */
export function Page({ title, crumbs, meta, actions, children, bodyClassName, bare = false }: {
  title: ReactNode; crumbs?: Crumb[]; meta?: ReactNode; actions?: ReactNode; children: ReactNode; bodyClassName?: string; bare?: boolean
}) {
  const { pathname } = useLocation()
  const module = moduleFor(pathname)
  const tab = tabFor(module, pathname)
  const Icon = module?.icon
  return <main id="main-content" className="tm-main" data-drawer-host>
    <header className="tm-top">
      {Icon && <Icon className="tm-top-icon" size={20} strokeWidth={1.7} aria-hidden="true" />}
      {crumbs?.map(crumb => <Fragment key={crumb.to}><Link className="tm-top-crumb" to={crumb.to} onClick={guardNavigation}>{crumb.label}</Link><span className="tm-top-sep" aria-hidden="true">/</span></Fragment>)}
      <h1>{title}</h1>
      {meta}
      {actions && <div className="tm-top-actions">{actions}</div>}
    </header>
    {module && tab && <ModuleTabs module={module} current={tab} />}
    {bare ? children : <div className={['tm-body', bodyClassName].filter(Boolean).join(' ')}>{children}</div>}
  </main>
}
