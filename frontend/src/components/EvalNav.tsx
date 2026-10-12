import { Link } from 'react-router-dom'

export function EvalNav({ current }: { current: 'runs' | 'datasets' | 'retrieval' | 'tuning' }) {
  const tabs = [
    { value: 'runs', path: '/evaluation', label: '评测运行' },
    { value: 'retrieval', path: '/evaluation/retrieval', label: '检索对比' },
    { value: 'tuning', path: '/evaluation/tuning', label: '检索调优' },
    { value: 'datasets', path: '/evaluation/datasets', label: '问题数据集' },
  ]
  return <nav className="tabs mb-6" aria-label="评测工作区">{tabs.map(tab =>
    <Link key={tab.value} className={`tab ${current === tab.value ? 'tab-active' : ''}`} aria-current={current === tab.value ? 'page' : undefined} to={tab.path}>{tab.label}</Link>
  )}</nav>
}
