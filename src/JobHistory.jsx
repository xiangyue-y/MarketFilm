import { useMemo } from 'react';
import { ArrowDownToLine, ChevronDown, ChevronRight, Film, ListFilter } from 'lucide-react';
import { clockLabel } from './ui.jsx';

const previewLimit = 6;
const filters = [['all', '全部'], ['completed', '已完成'], ['active', '进行中'], ['failed', '失败']];
const matchesFilter = (job, filter) => filter === 'all'
  || (filter === 'active' ? !['completed', 'failed'].includes(job.status) : job.status === filter);

function dateLabel(value) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return '今天';
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
}

function HistoryRow({ job, active, onOpen }) {
  const name = job.product?.name || '商品视频';
  const status = job.status === 'completed' ? '已完成' : job.status === 'failed' ? '失败' : job.message || '进行中';
  const mode = job.mode === 'baseline' ? 'baseline' : 'audit';
  const kind = job.userRevision ? '单镜修改' : job.creativeComparison ? (job.creativeComparison.arm === 'baseline' ? '固定双镜' : '选案版') : mode === 'baseline' ? '单向基线' : '质检闭环';
  const time = new Date(job.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  return <article className={`history-item ${active ? 'active' : ''} ${job.status}`}>
    <button type="button" className="history-open" onClick={onOpen} aria-label={`查看${name}，${kind}，${status}`}>
      <span className={`history-mark ${mode}`}><Film size={17} /></span>
      <span className="history-copy">
        <span className="history-copy-top"><strong>{name}</strong><em className={mode}>{kind}</em></span>
        <small>{time} · Seed {job.seed ?? '—'}</small>
      </span>
      <span className="history-metrics"><span><b>{job.attempts?.length || 0}</b> 轮</span><span>{job.elapsedMs ? `耗时 ${clockLabel(job.elapsedMs / 1000)}` : '尚无耗时'}</span></span>
    </button>
    <span className={`history-status ${job.status}`}><i />{status}</span>
    {job.videoUrl
      ? <a className="history-download" href={job.videoUrl} download={job.fileName || 'ad-video.mp4'} aria-label={`下载${name}`} title="下载视频"><ArrowDownToLine size={17} /></a>
      : <button className="history-download history-open-action" type="button" onClick={onOpen} aria-label="查看任务详情" title="查看任务详情"><ChevronRight size={17} /></button>}
  </article>;
}

export default function JobHistory({ historyJobs, historyState, activeJobId, view, setView, openRun }) {
  const { filter, expanded } = view;
  const setFilter = (next) => setView({ filter: next, expanded: false });
  const counts = useMemo(() => Object.fromEntries(filters.map(([key]) => [key, historyJobs.filter((job) => matchesFilter(job, key)).length])), [historyJobs]);
  const { total, groups } = useMemo(() => {
    const filtered = historyJobs.filter((job) => matchesFilter(job, filter)).sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt));
    const visible = expanded ? filtered : filtered.slice(0, previewLimit);
    const groups = [];
    for (const job of visible) {
      const label = dateLabel(job.createdAt);
      const last = groups.at(-1);
      if (last?.label === label) last.jobs.push(job);
      else groups.push({ label, jobs: [job] });
    }
    return { total: filtered.length, groups };
  }, [historyJobs, filter, expanded]);
  const emptyMessage = historyState === 'loading' ? '正在读取运行记录…'
    : historyState === 'error' ? '暂时无法读取运行记录，正在自动重试。' : '还没有运行记录。';

  return <main className="experiment-history" aria-label="生成任务记录">
    <div className="history-header">
      <div className="history-title"><span className="panel-kicker">任务库</span><h2 tabIndex={-1}>运行记录</h2><span className="history-total">{historyJobs.length} 条记录</span></div>
      {historyJobs.length > 0 && <div className="history-filters" role="group" aria-label="筛选运行记录">
        <span><ListFilter size={15} />筛选</span>
        {filters.map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<small>{counts[key]}</small></button>)}
      </div>}
    </div>
    {groups.length > 0 ? <div className="history-groups">{groups.map(({ label, jobs }) => (
      <section className="history-group" key={label} aria-label={label}>
        <div className="history-group-title"><span>{label}</span><i /> <small>{jobs.length} 条</small></div>
        <div className="history-list">{jobs.map((job) => <HistoryRow key={job.id} job={job} active={activeJobId === job.id} onOpen={() => openRun(job)} />)}</div>
      </section>
    ))}</div> : <div className="history-empty" role="status">{historyJobs.length > 0
      ? <>当前筛选下没有任务。<button className="text-button" type="button" onClick={() => setFilter('all')}>查看全部</button></>
      : emptyMessage}</div>}
    {total > previewLimit && <button className="history-more" type="button" aria-expanded={expanded} onClick={() => setView((previous) => ({ ...previous, expanded: !previous.expanded }))}>
      {expanded ? '收起记录' : `查看其余 ${total - previewLimit} 条记录`}<ChevronDown size={16} className={expanded ? 'is-expanded' : ''} />
    </button>}
  </main>;
}
