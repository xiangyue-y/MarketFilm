import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ChevronRight, ImagePlus, LoaderCircle, Package, Plus, Trash2 } from 'lucide-react';
import { batchFormats, createBatchArchive, deliverableJobs } from './batch-export.mjs';

const newRow = () => ({ id: crypto.randomUUID(), assetId: '', name: '', benefit: '', audience: '', callToAction: '' });
const terminal = (status) => ['completed', 'failed'].includes(status);
const statusLabel = (job) => job.status === 'failed' ? '失败' : job.compositionWarning ? '合成异常' : job.needsReview && job.status === 'completed' ? '待复核' : job.status === 'completed' ? '完成' : job.status === 'queued' ? '排队中' : `${job.progress || 0}%`;

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请重试。');
  return data;
}

export default function BatchWorkspace({ active, ready, plannerReady, onOpenRun, onAssetSaved }) {
  const [rows, setRows] = useState(() => [newRow(), newRow()]);
  const [assets, setAssets] = useState([]);
  const [batches, setBatches] = useState([]);
  const [currentBatchId, setCurrentBatchId] = useState('');
  const [serviceError, setServiceError] = useState('');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [failure, setFailure] = useState(false);
  const [uploading, setUploading] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [opening, setOpening] = useState('');
  const [mode, setMode] = useState('audit');
  const [duration, setDuration] = useState(15);
  const [narration, setNarration] = useState(true);
  const [deliveryFormat, setDeliveryFormat] = useState('9:16');
  const [deliveryBusy, setDeliveryBusy] = useState(false);
  const [deliveryStatus, setDeliveryStatus] = useState(null);
  const input = useRef(null);
  const uploadRow = useRef(null);

  const loadBatches = useCallback(async () => {
    try {
      const result = await requestJson('/api/batches');
      setBatches(result.batches);
      setServiceError('');
    } catch { setServiceError('批量记录暂时无法读取，正在重试。'); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    if (!active) return undefined;
    void requestJson('/api/assets').then((data) => setAssets(data.assets)).catch(() => { setFailure(true); setMessage('素材库暂时无法读取。'); });
    void loadBatches();
    const timer = window.setInterval(loadBatches, 2500);
    return () => window.clearInterval(timer);
  }, [active, loadBatches]);

  const batch = batches.find((item) => item.id === currentBatchId) || batches[0];
  const done = batch?.jobs.filter((job) => terminal(job.status)).length || 0;
  const exportable = deliverableJobs(batch);
  const reviewCount = exportable.filter((job) => job.needsReview).length;
  const exportStatus = deliveryStatus?.batchId === batch?.id && deliveryStatus?.format === deliveryFormat ? deliveryStatus : null;
  const editable = !uploading && !submitting && !deliveryBusy;
  const valid = rows.every((row) => row.name.trim() && row.benefit.trim() && row.assetId);
  const update = (id, patch) => setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  function notify(text, error = false) { setMessage(text); setFailure(error); }

  async function saveImage(file) {
    const rowId = uploadRow.current;
    if (!file || !rowId || uploading) return;
    setUploading(rowId);
    notify('正在保存参考图…');
    try {
      const body = new FormData();
      body.append('reference', file);
      const { asset, reused } = await requestJson('/api/assets', { method: 'POST', body });
      setAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)]);
      update(rowId, { assetId: asset.id });
      onAssetSaved(asset);
      notify(reused ? '相同图片已在素材库，本次直接复用。' : '参考图已保存，下一次可以直接选择。');
    } catch (error) { notify(error.message, true); }
    finally { setUploading(''); }
  }

  async function submit(event) {
    event.preventDefault();
    if (!editable || !valid) return;
    setSubmitting(true);
    notify('正在提交批量任务…');
    try {
      const result = await requestJson('/api/batches', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, duration, narration, items: rows.map(({ assetId, name, benefit, audience, callToAction }) => ({ assetId, product: { name, benefit, audience, callToAction } })) }),
      });
      setCurrentBatchId(result.batchId);
      await loadBatches();
      notify(`已提交 ${result.jobIds.length} 件商品，按队列顺序处理。`);
    } catch (error) { notify(error.message, true); }
    finally { setSubmitting(false); }
  }

  async function openJob(id) {
    setOpening(id);
    try { onOpenRun((await requestJson(`/api/jobs/${id}`)).job); }
    catch (error) { notify(error.message, true); }
    finally { setOpening(''); }
  }

  async function downloadBatch() {
    if (!exportable.length || deliveryBusy || submitting) return;
    setCurrentBatchId(batch.id);
    setDeliveryBusy(true);
    const report = (text, error = false) => setDeliveryStatus({ batchId: batch.id, format: deliveryFormat, text, error });
    try {
      const archive = await createBatchArchive({ batch, format: deliveryFormat, onProgress: (progress) => report(progress.packing
        ? `正在打包 ${progress.total} 条成片…`
        : `正在准备 ${progress.index}/${progress.total}：${progress.name}`) });
      const archiveUrl = URL.createObjectURL(new Blob([archive.data], { type: 'application/zip' }));
      const link = document.createElement('a');
      link.href = archiveUrl;
      link.download = archive.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(archiveUrl), 60_000);
      report(`打包完成，已发起下载：${archive.count} 条成片，${archive.captionCount} 份字幕。`);
    } catch (error) { report(error.message, true); }
    finally { setDeliveryBusy(false); }
  }

  return <main className="batch-workspace" hidden={!active}>
    <form className="batch-form sidebar-panel" onSubmit={submit}>
      <div className="batch-heading"><div><span className="panel-kicker">批量工作台</span><h2>多商品制作</h2><p>为每件商品填写卖点并选择参考图。提交后逐件生成，已保存的素材可以继续用。</p></div></div>
      <input ref={input} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void saveImage(event.target.files?.[0]); event.target.value = ''; }} />
      <div className="batch-rows">{rows.map((row, index) => {
        const asset = assets.find((item) => item.id === row.assetId);
        return <fieldset key={row.id} className="batch-row" disabled={!editable}>
          <legend>商品 {index + 1}</legend>
          <div className="batch-image-field">
            {asset ? <img src={asset.url} alt={`商品 ${index + 1} 的参考图`} /> : <span className="batch-image-placeholder"><ImagePlus size={20} /></span>}
            <label className="field-label">参考图<select aria-label={`商品 ${index + 1} 参考图`} required value={row.assetId} onChange={(event) => update(row.id, { assetId: event.target.value })}><option value="">从素材库选择</option>{assets.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.width}×{item.height}</option>)}</select></label>
            <button type="button" className="button button-secondary" aria-label={`上传商品 ${index + 1} 图片`} onClick={() => { uploadRow.current = row.id; input.current?.click(); }}><ImagePlus size={15} />{uploading === row.id ? '上传中' : '上传'}</button>
          </div>
          <div className="batch-fields"><label className="field-label">名称<input required maxLength={48} value={row.name} onChange={(event) => update(row.id, { name: event.target.value })} placeholder="商品名称" /></label><label className="field-label">卖点<input required maxLength={90} value={row.benefit} onChange={(event) => update(row.id, { benefit: event.target.value })} placeholder="已确认的卖点" /></label><label className="field-label">受众 <small>可选</small><input maxLength={80} value={row.audience} onChange={(event) => update(row.id, { audience: event.target.value })} placeholder="面向谁" /></label><label className="field-label">行动引导 <small>可选</small><input maxLength={90} value={row.callToAction} onChange={(event) => update(row.id, { callToAction: event.target.value })} placeholder="默认：了解产品" /></label></div>
          {rows.length > 2 && <button className="icon-button batch-remove" type="button" aria-label={`移除商品 ${index + 1}`} onClick={() => setRows((current) => current.filter((item) => item.id !== row.id))}><Trash2 size={15} /></button>}
        </fieldset>;
      })}</div>
      <button className="button button-secondary batch-add" type="button" disabled={rows.length >= 8 || !editable} onClick={() => setRows((current) => [...current, newRow()])}><Plus size={15} />添加商品</button>
      <div className="batch-actions"><label className="field-label">时长<select value={duration} disabled={!editable} onChange={(event) => setDuration(Number(event.target.value))}><option value={7}>7 秒</option><option value={15}>15 秒</option></select></label><label className="field-label">策略<select value={mode} disabled={!editable} onChange={(event) => setMode(event.target.value)}><option value="audit">质检闭环</option><option value="baseline">单向基线</option></select></label><label className="batch-voice"><input type="checkbox" checked={narration} disabled={!editable} onChange={(event) => setNarration(event.target.checked)} />旁白与字幕</label><button className="button button-primary" disabled={!editable || !valid || !ready || (mode === 'audit' && !plannerReady)} type="submit">{submitting ? '正在提交' : `生成 ${rows.length} 条短片`}</button></div>
      {message && <p className={failure ? 'batch-notice warning-copy' : 'batch-notice'} role="status">{message}</p>}
    </form>
    <section className="batch-progress sidebar-panel" aria-label="批量任务进度">
      <div className="batch-heading"><div><span className="panel-kicker">出片进度</span><h2>批次记录</h2></div>{batch && <span className="process-percent">{done}/{batch.jobs.length}</span>}</div>
      {serviceError && <p className="warning-copy" role="status">{serviceError}</p>}
      {batch ? <><label className="field-label">查看批次<select disabled={deliveryBusy} value={batch.id} onChange={(event) => setCurrentBatchId(event.target.value)}>{batches.map((item) => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString('zh-CN')} · {item.jobs.length} 件商品</option>)}</select></label>
      <div className="batch-delivery">
        <div className="batch-delivery-heading"><span className="batch-delivery-icon"><Package size={17} aria-hidden="true" /></span><div><h3>批量导出</h3><p>{exportable.length ? `${exportable.length}/${batch.jobs.length} 条可导出${reviewCount ? `，${reviewCount} 条待复核` : ''}。已重配音的成片会使用最新版本。` : '成片就绪后，可按画幅打包视频及已有字幕。'}</p></div></div>
        <div className="batch-delivery-controls"><label className="field-label">导出画幅<select value={deliveryFormat} disabled={deliveryBusy || !exportable.length} onChange={(event) => setDeliveryFormat(event.target.value)}>{Object.entries(batchFormats).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="button button-primary" type="button" disabled={deliveryBusy || submitting || !exportable.length} onClick={downloadBatch}>{deliveryBusy ? <LoaderCircle size={15} aria-hidden="true" className="spin" /> : <ArrowDownToLine size={15} aria-hidden="true" />}{deliveryBusy ? '正在导出' : '下载 ZIP'}</button></div>
        <div role="status" className={exportStatus?.error ? 'warning-copy' : undefined}>{exportStatus?.text}</div>
      </div><div className="batch-job-list">{batch.jobs.map((job) => <article className="batch-job" key={job.id}><div className="batch-job-title"><strong>{job.name}</strong><span className={`batch-job-status ${job.status}`}>{statusLabel(job)}</span></div><progress className="process-progress" aria-label={`${job.name} 进度`} value={job.progress || 0} max="100" /><p>{job.error || job.compositionWarning || job.message}</p><div className="batch-job-actions"><button className="text-button" type="button" disabled={Boolean(opening)} onClick={() => openJob(job.id)}>{opening === job.id ? <LoaderCircle size={14} className="spin" /> : <ChevronRight size={14} />}查看过程</button>{job.videoUrl && !job.compositionWarning && <a className="text-button" href={job.videoUrl} download={job.fileName}><ArrowDownToLine size={14} />下载</a>}</div></article>)}</div></> : <p className="batch-notice">{loading ? '正在读取…' : '暂无批次。提交后可在这里查看每件商品的进度。'}</p>}
    </section>
  </main>;
}
