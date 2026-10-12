import { Fragment } from 'react'
import type { ReactNode } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import clsx from 'clsx'
import { useApi } from '../../lib/api'
import { useAuth } from '../../lib/auth'
import { BrandMark } from '../ui'

interface RailItem { path: string; match: string; label: string; icon: string; admin?: boolean }
// Icon paths follow the prototype rail.
const RAIL: RailItem[] = [
  { path: '/chat', match: '/chat', label: '问答', icon: 'M4 5h16v11H9l-5 4z' },
  { path: '/knowledge', match: '/knowledge', label: '知识库', icon: 'M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z' },
  { path: '/memory', match: '/memory', label: '记忆', icon: 'M12 3a6 6 0 0 0-6 6c0 2.2 1.2 3.6 2.4 4.7.9.8 1.6 1.8 1.6 3V19h4v-2.3c0-1.2.7-2.2 1.6-3C16.8 12.6 18 11.2 18 9a6 6 0 0 0-6-6zM10 22h4' },
  { path: '/evaluation', match: '/evaluation', label: '评测', icon: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3', admin: true },
  { path: '/admin/reviews', match: '/admin', label: '管理', icon: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z', admin: true },
  { path: '/settings', match: '/settings', label: '设置', icon: 'M4 7h10M18 7h2M4 17h4M12 17h8M14 4v6M8 14v6', admin: true },
]

export function useReviewCount(enabled = true): number {
  const count = useApi<{ total: number }>('/admin/reviews/count', { enabled, poll: 30000 })
  return count.data?.total ?? 0
}

/** Primary navigation: icon over label, the account avatar at the bottom. */
export function Rail() {
  const { user } = useAuth()
  const admin = user?.role === 'admin'
  const { pathname } = useLocation()
  const pending = useReviewCount(admin)
  const name = user?.display_name || user?.username || '?'
  return <header className="tm-rail">
    <Link to="/chat" className="tm-rail-logo" aria-label="TraceMind 首页"><BrandMark size={36} /></Link>
    <nav aria-label="主要导航">
      {RAIL.filter(item => admin || !item.admin).map(item => {
        const active = pathname === item.match || pathname.startsWith(`${item.match}/`)
        const badge = item.match === '/admin' && pending > 0
        return <Link key={item.path} to={item.path} className="tm-rail-item" aria-current={active ? 'page' : undefined} aria-label={badge ? `${item.label}，${pending} 项待审批` : item.label}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={item.icon} /></svg>
          <span aria-hidden="true">{item.label}</span>
          {badge && <span className="tm-rail-badge" aria-hidden="true">{pending > 99 ? '99+' : pending}</span>}
        </Link>
      })}
    </nav>
    <NavLink to="/account" className="tm-rail-me" title={`${name} · 我的账户`} aria-label="我的账户">{name.slice(0, 1)}</NavLink>
  </header>
}

export interface SideEntry { to: string; label: ReactNode; count?: ReactNode; badge?: number; sub?: ReactNode; end?: boolean; title?: string; current?: boolean }

/** Module sidebar: an optional heading, then links and grey group labels. */
export function SideNav({ title, label, header, groups, footer }: {
  title?: string; label: string; header?: ReactNode; footer?: ReactNode
  groups: { label?: string; items: SideEntry[] }[]
}) {
  return <nav className="tm-side" aria-label={label}>
    {header}
    {title && <h2>{title}</h2>}
    {groups.filter(group => group.items.length).map((group, index) => <Fragment key={group.label ?? index}>
      {group.label && <div className="tm-side-group">{group.label}</div>}
      {group.items.map(item => <SideLink key={item.to} {...item} />)}
    </Fragment>)}
    {footer && <><span className="tm-side-spacer" />{footer}</>}
  </nav>
}

export function SideLink({ to, label, count, badge, sub, end, title, current }: SideEntry) {
  const body = sub !== undefined ? <><span className="tm-si-label">{label}</span><span className="tm-si-sub">{sub}</span></>
    : <><span className="tm-si-label">{label}</span>
      {badge ? <span className="tm-si-badge">{badge}</span> : count !== undefined && <span className="tm-si-count">{count}</span>}</>
  const className = clsx('tm-si', sub !== undefined && 'tm-si-two')
  // Links that differ only by query string say whether they are current; the rest follow the route.
  if (current !== undefined) return <Link to={to} title={title} className={className} aria-current={current ? 'page' : undefined}>{body}</Link>
  return <NavLink to={to} end={end} title={title} className={className}>{body}</NavLink>
}

export interface Crumb { to: string; label: string }

/** Top bar + body for one page; `side` is the module sidebar. The main column hosts drawers. */
export function Page({ side, title, crumbs, meta, actions, children, bodyClassName, bare = false }: {
  side?: ReactNode; title: ReactNode; crumbs?: Crumb[]; meta?: ReactNode; actions?: ReactNode; children: ReactNode; bodyClassName?: string; bare?: boolean
}) {
  return <>
    {side}
    <main id="main-content" className="tm-main" data-drawer-host>
      <header className="tm-top">
        {crumbs?.map(crumb => <Fragment key={crumb.to}><Link className="tm-top-crumb" to={crumb.to}>{crumb.label}</Link><span className="tm-top-sep" aria-hidden="true">/</span></Fragment>)}
        <h1>{title}</h1>
        {meta}
        {actions && <div className="tm-top-actions">{actions}</div>}
      </header>
      {bare ? children : <div className={clsx('tm-body', bodyClassName)}>{children}</div>}
    </main>
  </>
}
