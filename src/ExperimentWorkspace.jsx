import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUpRight, FileText, FileUp, ScanEye } from 'lucide-react';
import { reviewMetrics as metrics, maxReviewGroups, unpackReviewReceipts } from '../protocol/blind-review.mjs';
import { experimentMarkdown } from './experiment-report.mjs';

const displayed = (value) => value == null ? '—' : value.toFixed(1);
const runDate = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const methodLabels = { independent: '质检策略', 'shared-first-round': '同源画质', creative: '创意流程' };

function RecallGrading({ pair, onSave, busy }) {
  return <details className="review-bundle">
    <summary>判读卖点复述（{pair.audit.recallGraded}/{pair.votes} 份）</summary>
    <p>确认卖点为「{pair.facts.join('、')}」。准确复述须覆盖核心信息，意思相同即可。含明显错误、只记得商品名或想不起来的判为不准确。</p>
    {pair.recallResponses.map(({ id, answers, grading }) => <form className="recall-grading" key={id} onSubmit={(event) => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      onSave(id, ['A', 'B'].map((slot) => data.get(slot)));
    }}>
      {answers.map((answer, index) => {
        const slot = ['A', 'B'][index];
        return <label className="field-label" key={slot}>视频 {slot}<span>{answer}</span>
          <select required name={slot} defaultValue={grading?.[index] || ''} aria-label={`视频 ${slot} 复述是否准确`}><option value="" disabled>判定复述</option><option value="correct">准确</option><option value="incorrect">不准确</option></select>
        </label>;
      })}
      <button className="button button-secondary" type="submit" disabled={busy}>保存判读</button>
    </form>)}
  </details>;
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败。');
  return data;
}

export function BlindReview({ token }) {
  const [session, setSession] = useState(null);
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    jsonRequest(`/api/blind/${encodeURIComponent(token)}`).then(setSession).catch((error) => setMessage(error.message));
  }, [token]);
  async function submit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const ratings = Object.fromEntries(['A', 'B'].map((slot) => [slot, Object.fromEntries(metrics.map(([key]) => [key, Number(data.get(`${slot}_${key}`))]))]));
    setSaving(true);
    setMessage('');
    try {
      await jsonRequest(`/api/blind/${token}/vote`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ratings, preference: data.get('preference'), note: data.get('note') || '' }) });
      setSession((current) => ({ ...current, voted: true }));
      window.scrollTo({ top: 0 });
    } catch (error) { setMessage(error.message); }
    finally { setSaving(false); }
  }
  return <main className="experiment-workspace blind-workspace">
    <div className="experiment-heading"><div><span className="panel-kicker">MarketFilm 测评</span><h1>{session?.voted ? '评分已记录' : '广告短片盲评'}</h1><p>{session?.voted ? '两段视频的评分已保存。可以关闭这个页面。' : '播放 A 和 B，参考商品图与卖点给出评分。1 分表示问题明显，3 分表示基本可用，5 分表示表现出色。'}</p></div>{session && !session.voted && <div className="blind-reference"><img src={session.referenceUrl} alt="商品参考图"/><div><strong>{session.product.name}</strong><p>{session.product.facts.join('；')}</p></div></div>}</div>
    {message && <p className="warning-copy" role="status">{message}</p>}
    {!session && !message && <p className="batch-notice" role="status">正在读取盲评视频…</p>}
    {session && !session.voted && <form className="blind-form" onSubmit={submit}>
      <div className="comparison-grid">{session.clips.map(({ slot, url }) => <article className="comparison-run" key={slot}>
        <h2>视频 {slot}</h2><video className="comparison-video" src={url} controls playsInline preload="metadata" aria-label={`视频 ${slot}`} />
        <div className="blind-ratings">{metrics.map(([key, label]) => <label className="field-label" key={key}>{label}<select name={`${slot}_${key}`} defaultValue="" required aria-label={`视频 ${slot} ${label}`}><option value="" disabled>请选择</option>{[1, 2, 3, 4, 5].map((value) => <option key={value}>{value}</option>)}</select></label>)}</div>
      </article>)}</div>
      <details className="review-rubric"><summary>评分参考：1 分最低，5 分最高</summary>{metrics.map(([key, label, detail]) => <p key={key}><strong>{label}：</strong>{detail}</p>)}</details>
      <div className="comparison-run blind-submit"><label className="field-label">整体偏好<select name="preference" required defaultValue=""><option value="" disabled>请选择</option><option value="A">视频 A</option><option value="B">视频 B</option><option value="tie">没有明显差别</option></select></label><label className="field-label">备注 <small>可选</small><input maxLength={1000} name="note" placeholder="例如：第二个镜头的动作更清楚" /></label><button className="button button-primary" type="submit" disabled={saving}>{saving ? '保存中…' : '提交盲评'}</button></div>
    </form>}
  </main>;
}

export default function ExperimentWorkspace({ preferredKey, onOpenRun }) {
  const [pairs, setPairs] = useState([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [report, setReport] = useState(null);
  const receiptInput = useRef(null);
  const [link, setLink] = useState('');
  const [hourlyRate, setHourlyRate] = useState('');
  const [inspect, setInspect] = useState(false);
  const [bundleExtras, setBundleExtras] = useState([]);
  const load = useCallback(async () => {
    try { setPairs((await jsonRequest('/api/experiments')).pairs); setError(''); }
    catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); const timer = window.setInterval(load, 4000); return () => window.clearInterval(timer); }, [load]);
  const pair = pairs.find((item) => item.key === selectedKey) || pairs.find((item) => item.inputKey === preferredKey) || pairs[0];
  const shared = pair?.method === 'shared-first-round';
  const creative = pair?.method === 'creative';
  const bundleChoices = pairs.filter((item) => pair && item.method === pair.method && item.key !== pair.key);
  const included = bundleChoices.filter((item) => bundleExtras.includes(item.key));
  const rate = Number(hourlyRate);
  const cost = (seconds) => hourlyRate && Number.isFinite(rate) && rate >= 0 ? `¥${(rate * seconds / 3600).toFixed(3)}` : '—';
  function downloadFile(payload, filename) {
    const url = URL.createObjectURL(payload);
    const file = document.createElement('a');
    file.href = url;
    file.download = filename;
    document.body.appendChild(file);
    file.click();
    file.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  async function exportReport() {
    setBusy('report');
    setReport(null);
    try {
      const { pairs: fresh } = await jsonRequest('/api/experiments', { cache: 'no-store' });
      const now = new Date();
      const data = experimentMarkdown(fresh, { now, hourlyRate });
      downloadFile(new Blob([data], { type: 'text/markdown;charset=utf-8' }), `MarketFilm-实验报告-${now.toISOString().slice(0, 10)}.md`);
      setReport({ text: '已导出当前对照组、耗时与人工评分快照。' });
    } catch (error) { setReport({ text: error.message, failed: true }); }
    finally { setBusy(''); }
  }
  async function saveRecall(id, grading) {
    setBusy(id);
    try {
      await jsonRequest(`/api/experiments/recall/${id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grading }) });
      await load();
      setReport({ text: '复述判读已保存。' });
    } catch (failure) { setReport({ text: failure.message, failed: true }); }
    finally { setBusy(''); }
  }
  async function downloadOffline(endpoint, body) {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || '离线包生成失败。');
    if (!response.headers.get('content-type')?.startsWith('text/html')) throw new Error('本地服务尚未载入离线盲评功能。');
    downloadFile(await response.blob(), response.headers.get('content-disposition')?.match(/(MarketFilm-Review-[a-f0-9]{8}\.html)/)?.[1] || 'MarketFilm-Review.html');
    setReport({ text: '离线包已下载。每位评阅人单独下载一份，浏览器打开 HTML，评分后交回一个 JSON。' });
  }
  async function makeLink(format) {
    setBusy(format);
    setReport(null);
    try {
      if (format === 'bundle') await downloadOffline('/api/experiments/offline-bundle', { keys: [pair.key, ...included.map((item) => item.key)] });
      else if (format === 'offline') await downloadOffline(`/api/experiments/${pair.key}/blind`, { format });
      else {
        const session = await jsonRequest(`/api/experiments/${pair.key}/blind`, { method: 'POST' });
        setLink(`/blind/${session.id}`);
      }
    } catch (failure) { setReport({ text: failure.message, failed: true }); }
    finally { setBusy(''); }
  }
  async function openFirstRound() {
    setBusy('first-round');
    setReport(null);
    try {
      const { key } = await jsonRequest(`/api/experiments/${pair.key}/first-round`, { method: 'POST' });
      await load();
      setSelectedKey(key);
      setBundleExtras([]);
      setLink('');
      setInspect(true);
    } catch (failure) { setReport({ text: failure.message, failed: true }); }
    finally { setBusy(''); }
  }
  async function importReceipts(event) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (!files.length) return;
    setBusy('import');
    setReport(null);
    const imported = await Promise.all(files.map(async (file) => {
      try {
        if (file.size > 32 * 1024) throw new Error('评分文件过大。');
        let payload;
        try { payload = JSON.parse(await file.text()); }
        catch { throw new Error('文件不是有效的评分 JSON。'); }
        const receipts = unpackReviewReceipts(payload);
        const results = await Promise.allSettled(receipts.map((receipt) => jsonRequest('/api/experiments/votes/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(receipt) })));
        return { accepted: results.filter((result) => result.status === 'fulfilled').length, details: results.flatMap((result, i) => result.status === 'rejected' ? [`${file.name}${receipts.length > 1 ? `（第 ${i + 1} 组）` : ''}：${result.reason.message}`] : []) };
      } catch (error) { return { accepted: 0, details: [`${file.name}：${error.message}`] }; }
    }));
    const accepted = imported.reduce((total, file) => total + file.accepted, 0);
    const details = imported.flatMap((file) => file.details);
    setReport({ text: `已记录 ${accepted} 份评分。${details.length ? `有 ${details.length} 项未导入。` : ''}`, details, failed: !!details.length });
    await load();
    setBusy('');
  }
  return <main className="experiment-workspace">
    <section className="experiment-heading"><div><span className="panel-kicker">控制变量实验</span><h2>视频对照实验</h2></div><button className="button button-secondary experiment-export" type="button" disabled={Boolean(busy) || !pairs.length} onClick={exportReport}><FileText size={16} aria-hidden="true" />{busy === 'report' ? '正在导出…' : '导出 Markdown 报告'}</button></section>
    {pair && <div className="review-actions" aria-label="盲评操作">
      <button className="button button-primary" disabled={Boolean(busy)} type="button" onClick={() => makeLink('offline')}><ArrowDownToLine size={16} />{busy === 'offline' ? '正在打包…' : '下载离线盲评包'}</button>
      <button className="button button-secondary" disabled={Boolean(busy)} type="button" onClick={() => makeLink('online')}><ScanEye size={16} />{busy === 'online' ? '准备中…' : '创建盲评链接'}</button>
      <button className="button button-secondary" disabled={Boolean(busy)} type="button" onClick={() => receiptInput.current?.click()}><FileUp size={16} />{busy === 'import' ? '正在导入…' : '导入评分文件'}</button>
      <input ref={receiptInput} type="file" hidden multiple accept=".json,application/json" aria-label="选择离线盲评评分文件" onChange={importReceipts} />
      {['available', 'ready'].includes(pair.firstRound) && <button className="button button-secondary" disabled={Boolean(busy)} type="button" onClick={openFirstRound}>{busy === 'first-round' ? '正在合成首轮版…' : pair.firstRound === 'ready' ? '查看同源对照' : '制作同源对照'}</button>}
    </div>}
    {bundleChoices.length > 0 && <details className="review-bundle"><summary>合并多组离线盲评</summary>
      <p>{pair.name} · {methodLabels[pair.method]}。可再选 {maxReviewGroups - 1} 组。</p>
      <fieldset disabled={Boolean(busy)} aria-label="添加对照组">{bundleChoices.map((item) => {
        const checked = bundleExtras.includes(item.key);
        return <label key={item.key}><input type="checkbox" checked={checked} disabled={!checked && included.length >= maxReviewGroups - 1} onChange={() => setBundleExtras((keys) => checked ? keys.filter((key) => key !== item.key) : [...keys, item.key])} /><span>{item.name} · {item.duration || '—'} 秒 · {runDate.format(new Date(item.createdAt))} · Seed {item.seed}</span></label>;
      })}</fieldset>
      <button type="button" className="button button-secondary" disabled={Boolean(busy) || !included.length} onClick={() => makeLink('bundle')}><ArrowDownToLine size={16} />{busy === 'bundle' ? '正在打包…' : `下载合并盲评包${included.length ? `（${included.length + 1} 组）` : ''}`}</button>
    </details>}
    {report && <div role="status" className={`review-report${report.failed ? ' warning-copy' : ''}`}><p>{report.text}</p>{report.details?.length > 0 && <ul>{report.details.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}</div>}
    {error && <p role="status" className="warning-copy">{error}</p>}
    {link && <div className="experiment-link" role="status"><label className="field-label">单次盲评链接<input readOnly onFocus={(event) => event.target.select()} value={`${window.location.origin}${link}`} /></label><a className="button button-secondary" href={link} target="_blank" rel="noreferrer"><ArrowUpRight size={16} />打开盲评</a></div>}
    {!pair ? <section className="experiment-empty"><h2>{loading ? '正在读取配对…' : '暂无可评分的配对'}</h2><p>用相同输入分别生成一条单向基线与一条质检闭环成片。</p></section> : <>
      <div className="experiment-pair"><label className="field-label">选择对照组<select value={pair.key} onChange={(event) => { setSelectedKey(event.target.value); setBundleExtras([]); setLink(''); setInspect(false); setReport(null); }}>{pairs.map((item) => <option key={item.key} value={item.key}>{item.name} · {item.duration || '—'} 秒 · {methodLabels[item.method]} · {runDate.format(new Date(item.createdAt))} · Seed {item.seed}</option>)}</select></label>{!shared && <label className="field-label experiment-rate">GPU 折算单价（元/小时）<input type="number" min="0" step="0.1" placeholder="可选" value={hourlyRate} onChange={(event) => setHourlyRate(event.target.value)} /></label>}<span>{pairs.length} 组对照 · 本组 {pair.votes} 份评分</span></div>
      {creative && pair.votes > 0 && <RecallGrading key={pair.key} pair={pair} onSave={saveRecall} busy={Boolean(busy)} />}
      <div className="comparison-grid">{[['baseline', creative ? '固定双镜' : shared ? '首轮成片' : '单向基线'], ['audit', creative ? `选案 · ${pair.proposal.title}` : '质检闭环']].map(([mode, title]) => {
        const result = pair[mode];
        if (creative) return <article className="comparison-run" key={mode}>
          <div className="review-heading"><strong>{title}</strong><span>{result.needsReview ? '含待复核镜头' : ''}</span></div>
          <dl className="experiment-metrics">
            <div><dt>前两秒愿意续看</dt><dd>{pair.votes ? `${result.continueCount}/${pair.votes}` : '待盲评'}</dd></div>
            <div><dt>准确复述卖点</dt><dd>{result.recallGraded ? `${result.recallCorrect}/${result.recallGraded}` : '待判读'}</dd></div>
            <div><dt>提案生成</dt><dd>{result.proposalSeconds == null ? '—' : `${displayed(result.proposalSeconds)} 秒`}</dd></div>
            <div><dt>分镜策划</dt><dd>{displayed(result.storyboardSeconds)} 秒</dd></div>
            <div><dt>生成及交付</dt><dd>{displayed(result.afterPlanSeconds)} 秒</dd></div>
            <div><dt>H3 生成含返工</dt><dd>{displayed(result.wanSeconds)} 秒</dd></div>
            <div><dt>返工重拍</dt><dd>{result.retries} 次 · {displayed(result.retrySeconds)} 秒</dd></div>
            <div><dt>返工指令</dt><dd>{displayed(result.rewriteSeconds)} 秒</dd></div>
            <div><dt>GPU 折算</dt><dd>{cost(result.wanSeconds)}</dd></div>
          </dl>
          {inspect && <><video className="comparison-video" src={result.output.videoUrl} controls playsInline preload="metadata" /><button className="text-button" type="button" onClick={() => jsonRequest(`/api/jobs/${result.jobId}`).then(({ job }) => onOpenRun(job)).catch((failure) => setError(failure.message))}>查看生成过程</button></>}
        </article>;
        return <article key={mode} className="comparison-run"><div className="review-heading"><strong>{title}</strong><span>{result.needsReview ? '含待复核镜头' : ''}</span></div><dl className="experiment-metrics">{!shared && <><div><dt>单任务处理</dt><dd>{result.wallSeconds == null ? '未完整记录' : `${displayed(result.wallSeconds)} 秒`}</dd></div><div><dt>Wan 调用</dt><dd>{result.wanCalls} 次</dd></div><div><dt>Wan 调用耗时</dt><dd>{displayed(result.wanSeconds)} 秒</dd></div><div><dt>质检与返工指令</dt><dd>{result.plannerSeconds ? `${displayed(result.plannerSeconds)} 秒` : '—'}</dd></div><div><dt>配音与合成</dt><dd>{result.deliverySeconds == null ? '—' : `${displayed(result.deliverySeconds)} 秒`}</dd></div><div><dt>GPU 折算</dt><dd>{cost(result.wanSeconds)}</dd></div><div><dt>返工</dt><dd>{result.retries} 次</dd></div></>}{metrics.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{displayed(result.means[key])}</dd></div>)}<div><dt>被偏好</dt><dd>{pair.votes ? `${pair.winners[mode]} 次` : '—'}</dd></div></dl>{inspect && result.output && <><video className="comparison-video" src={result.output.videoUrl} controls playsInline preload="metadata">{result.output.captionsUrl && <track kind="subtitles" src={result.output.captionsUrl} srcLang="zh" label="简体中文" default />}</video>{result.jobId && <button className="text-button" type="button" onClick={() => jsonRequest(`/api/jobs/${result.jobId}`).then(({ job }) => onOpenRun(job)).catch((error) => setError(error.message))}>查看生成过程</button>}</>}</article>;
      })}</div>
      {!creative && <p className="batch-notice">{pair.votes ? `无法分出偏好：${pair.winners.tie} 票。` : '暂无人工评分。'} {shared ? '两版使用同一次生成的首轮镜头和相同音轨，只比较采用返工镜头后的成片；耗时和成本请看独立运行。' : pair.firstRound === 'unchanged' ? '闭环最终保留全部首轮镜头，因此没有同源画质差异可评分。' : 'GPU 折算按 Wan 调用耗时和所填单价估计，包含等待及传输。GPT 接口费用按服务商账单计算。'}</p>}
      <button className="button button-secondary" type="button" aria-expanded={inspect} onClick={() => setInspect((current) => !current)}>{inspect ? '收起策略公开成片' : '查看策略公开成片'}</button>
    </>}
  </main>;
}
