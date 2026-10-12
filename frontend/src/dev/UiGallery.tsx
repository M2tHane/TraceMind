// Development-only gallery of the shared components (mounted at /__ui when import.meta.env.DEV).
import { useState } from 'react'
import { Plus } from 'lucide-react'
import {
  Button, CiteMarker, CollapsedPanel, DataTable, Drawer, FactList, FactStrip, Highlight, ImportanceMeter, PanelHeader, Pager,
  ResizeHandle, ScopeTag, SearchableSelect, Segmented, StatusTag, StepBar, Tag, documentSteps, type TagTone,
} from '../components/ui'

const TONES: TagTone[] = ['neutral', 'ok', 'run', 'wait', 'err', 'warn', 'platform', 'personal', 'ink']
const ROWS = Array.from({ length: 6 }, (_, index) => ({ id: String(index + 1), name: `sample-${index + 1}.pdf`, status: ['ready', 'parsing', 'failed', 'queued', 'embedding', 'ready'][index], chunks: 40 + index * 13 }))
const OPTIONS = Array.from({ length: 12 }, (_, index) => ({ value: String(index), label: `选项 ${index + 1}`, group: index < 9 ? '平台' : '个人' }))

export function UiGallery() {
  const [seg, setSeg] = useState('all')
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(10)
  const [selected, setSelected] = useState<Set<string>>(new Set(['2']))
  const [one, setOne] = useState('0')
  const [many, setMany] = useState<string[]>([])
  const [drawer, setDrawer] = useState(false)
  const [width, setWidth] = useState(280)
  const [open, setOpen] = useState(true)
  return <div className="flex min-h-dvh">
    {open ? <aside className="relative bg-sidebar border-r border-line flex flex-col" style={{ width }}>
      <PanelHeader toggle={{ side: 'left', expanded: true, onToggle: () => setOpen(false), name: '示例面板' }}><h2>示例面板</h2></PanelHeader>
      <p className="p-3 tm-muted">宽 {width}px</p>
      <ResizeHandle edge="right" value={width} min={200} max={360} onChange={setWidth} label="拖动调整示例面板宽度" />
    </aside> : <CollapsedPanel side="left" onToggle={() => setOpen(true)} name="示例面板" className="bg-sidebar border-r border-line" />}
    <main className="flex-1 min-w-0 relative" data-drawer-host>
      <header className="h-bar bg-app border-b border-line flex items-center gap-3 px-6"><h1 className="m-0 text-title font-semibold">组件</h1><span className="flex-1" /><Button variant="secondary">次要</Button><Button><Plus size={14} />主要</Button></header>
      <div className="p-6 flex flex-col gap-5">
        <section className="flex flex-wrap items-center gap-2">
          <Button>通过并开始解析</Button><Button variant="secondary">上传新版本</Button><Button variant="ghost">复制引文</Button><Button variant="danger">驳回并删除原文件</Button>
          <Button size="sm" variant="secondary">重新处理</Button><Button variant="icon" aria-label="新增"><Plus size={15} /></Button><Button busy>保存</Button><Button variant="secondary" disabled>只重试失败项</Button>
        </section>
        <section className="flex flex-wrap items-center gap-2">{TONES.map(tone => <Tag key={tone} tone={tone}>{tone}</Tag>)}<ScopeTag scope="platform" /><ScopeTag scope="personal" /><StatusTag value="pending" /><StatusTag value="failed" /></section>
        <section className="flex flex-wrap items-center gap-3">
          <Segmented label="状态" value={seg} onChange={setSeg} items={[{ value: 'all', label: '全部', count: 12 }, { value: 'ready', label: '已就绪', count: 9 }, { value: 'run', label: '处理中', count: 2 }, { value: 'fail', label: '失败', count: 1 }]} />
          <SearchableSelect label="知识库" options={OPTIONS} multiple value={many} onChange={setMany} />
          <SearchableSelect label="状态" options={OPTIONS.slice(0, 4)} value={one} onChange={setOne} />
          <Button variant="secondary" onClick={() => setDrawer(true)}>打开抽屉</Button>
        </section>
        <FactStrip items={[{ label: '文档', value: '12 份' }, { label: '分块', value: '1,284' }, { label: 'Embedding', value: <span className="tm-mono">qwen3.7-text-embedding</span> }, { label: '分块长度 / 重叠', value: '800 / 120' }, { label: '默认检索', value: '混合 + 重排' }, { label: '索引版本', value: 'v3' }]} />
        <section className="flex flex-wrap items-center gap-5">
          {['queued', 'parsing', 'embedding', 'failed', 'ready'].map(stage => { const s = documentSteps(stage === 'failed' ? 'failed' : stage === 'ready' ? 'ready' : 'processing', stage === 'failed' ? 'chunking' : stage); return <span key={stage} className="inline-flex items-center gap-2"><StepBar steps={s.steps} label={s.current} /><span className="tm-faint text-xs">{s.current}</span></span> })}
          {[1, 3, 5].map(value => <ImportanceMeter key={value} value={value} />)}
        </section>
        <p className="text-md m-0 max-w-[640px]"><Highlight>最晚可以顺延到次年 3 月 31 日，逾期作废</Highlight><CiteMarker n={1} active onClick={() => undefined} />。属于「满 1 年不满 10 年」<CiteMarker n={2} onClick={() => undefined} />。</p>
        <div className="tm-panel">
          <DataTable label="示例表格" rows={ROWS.slice((page - 1) * size, page * size)} rowKey={row => row.id} selectedKey="3" onRowClick={() => setDrawer(true)}
            selection={{ selected, onChange: setSelected, label: key => `sample-${key}.pdf` }}
            columns={[
              { key: 'name', header: '文件名', cell: row => <button type="button" className="tm-linkbtn" onClick={() => setDrawer(true)}>{row.name}</button> },
              { key: 'status', header: '状态', cell: row => <StatusTag value={row.status} /> },
              { key: 'steps', header: '进度', cell: row => { const s = documentSteps(row.status === 'ready' || row.status === 'failed' ? row.status : 'processing', row.status); return <StepBar steps={s.steps} label={s.current} size="sm" /> } },
              { key: 'chunks', header: '分块', cell: row => row.chunks },
            ]} />
          <Pager total={1284} page={page} pageSize={size} onPageChange={setPage} onPageSizeChange={setSize} />
        </div>
      </div>
      <Drawer open={drawer} onOpenChange={setDrawer} title="remote-work.md" leading={<Tag tone="run">文档</Tag>} position="1 / 3" onPrev={() => undefined} onNext={() => undefined}
        footer={<div className="flex justify-end gap-2"><Button variant="danger">驳回并删除原文件</Button><Button>通过并开始解析</Button></div>}>
        <FactList items={[{ label: '提交到', value: '员工手册（平台）' }, { label: '申请人', value: '李娜，员工' }, { label: '格式', value: 'Markdown，1 页' }, { label: '大小', value: '3.2 KB' }]} />
      </Drawer>
    </main>
  </div>
}
