import { useState } from 'react';
import { Activity, ArrowDownToLine, ArrowLeft, AudioLines, ChevronRight, CircleAlert, Clapperboard, GitCompareArrows, LoaderCircle, PencilLine, RefreshCw } from 'lucide-react';
import NarrationStudio from './NarrationStudio.jsx';
import { originalOutputs } from './ui.jsx';
import { softMattePolicy } from '../protocol/presentation.mjs';

const formats = ['9:16', '1:1', '16:9'];
export function PageBack({ onClick, children = '返回成片' }) {
  return <div className="journey-back"><button className="text-button" type="button" onClick={onClick}><ArrowLeft size={16} />{children}</button></div>;
}

function Clip({ output, label }) {
  return <video key={output.videoUrl} className="journey-video" src={output.videoUrl} aria-label={label} controls playsInline preload="auto">
    {output.captionsUrl && <track kind="subtitles" src={output.captionsUrl} srcLang="zh" label="简体中文" default />}
  </video>;
}

function TaskLink({ icon: Icon, title, text, onClick }) {
  return <button type="button" className="journey-task-link" onClick={onClick}><span className="section-icon"><Icon size={17} /></span><span><strong>{title}</strong><small>{text}</small></span><ChevronRight size={17} /></button>;
}

export function ResultPage({ job, voiceVersion, busy, onNavigate, onSource }) {
  const output = voiceVersion?.outputs?.['9:16'] || originalOutputs(job)['9:16'];
  const revision = job.userRevision;
  if (busy) return <main className="journey-page journey-card journey-progress">
    <span className="section-icon"><LoaderCircle className="spin" size={22} /></span>
    <h1 tabIndex={-1}>{revision ? `正在修改「${revision.shotLabel}」` : '正在制作广告'}</h1>
    <p role="status">{job.message}</p>
    <div className="journey-progress-bar"><progress aria-label="生成进度" value={job.progress || 0} max="100" /><strong>{job.progress || 0}%</strong></div>
    <button className="button button-secondary" type="button" onClick={() => onNavigate('process')}><Activity size={16} />查看生成详情</button>
  </main>;
  if (!output) return <main className="journey-page journey-card journey-progress">
    <span className="section-icon"><CircleAlert size={22} /></span><h1 tabIndex={-1}>{job.status === 'failed' ? '生成未完成' : '成片尚未合成'}</h1>
    <p role="alert">{job.error || job.compositionWarning || job.message}</p>
    <div className="journey-actions"><button className="button button-primary" type="button" onClick={() => onNavigate('process')}>查看生成详情</button>{revision && <button className="button button-secondary" type="button" onClick={onSource}>打开未修改的版本</button>}{job.compositionWarning && job.videoUrl && <a className="button button-secondary" href={job.videoUrl} download={job.fileName}>下载已生成的原片</a>}{job.compositionWarning && <button className="button button-secondary" type="button" onClick={() => onNavigate('export')}>重新合成</button>}</div>
  </main>;
  return <main className="journey-page journey-result">
    <section className="journey-card journey-viewer">
      <div className="journey-frame"><Clip output={output} label="广告成片" /></div>
    </section>
    <section className="journey-card journey-result-info">
      <div><span className="panel-kicker">{revision ? '镜头修改版' : voiceVersion ? '新版配音' : '成片已完成'}</span><h1 tabIndex={-1}>{job.product.name}</h1><p>{job.duration} 秒 · 9:16</p></div>
      {revision && <p className="journey-note">已重做「{revision.shotLabel}」，原版仍可查看。</p>}
      {job.needsReview && <p className="journey-note" role="status">抽样质检有待确认，请观看成片检查效果。</p>}
      <a className="button button-primary" href={output.videoUrl} download={output.fileName || '广告成片.mp4'}><ArrowDownToLine size={17} />下载当前成片</a>
      <div className="journey-task-list">
        {revision && <TaskLink icon={GitCompareArrows} title="对比修改前后" text="查看这一镜的原片和新版" onClick={() => onNavigate('compare-shot')} />}
        {job.selectedShots?.length > 0 && <TaskLink icon={PencilLine} title="修改某个镜头" text="写下意见，只重做选中的动态镜头" onClick={() => onNavigate('revise')} />}
        <TaskLink icon={AudioLines} title="编辑配音" text="修改口播或换音色，保留画面" onClick={() => onNavigate('narration')} />
        <TaskLink icon={ArrowDownToLine} title="其他画幅与版本" text="切换版本，导出竖屏、方形或横屏" onClick={() => onNavigate('export')} />
        <TaskLink icon={Activity} title="查看生成详情" text="查看各镜头、质检证据与模型反馈" onClick={() => onNavigate('process')} />
      </div>
    </section>
  </main>;
}

export function ShotEditPage({ job, voiceVersion, servicesReady, onSubmit }) {
  const shots = job.storyboard.shots.filter((shot) => job.selectedShots?.some((entry) => entry.shotId === shot.id && entry.videoUrl));
  const [shotId, setShotId] = useState(shots[0]?.id || '');
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const clip = job.selectedShots.find((shot) => shot.shotId === shotId)?.videoUrl;
  async function submit(event) {
    event.preventDefault();
    setPending(true); setError('');
    try {
      const response = await fetch(`/api/jobs/${job.id}/shot-revisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shotId, feedback: feedback.trim(), voiceVersionId: voiceVersion?.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '修改未提交，请重试。');
      onSubmit(result.job);
    } catch (failure) { setError(failure.message); }
    finally { setPending(false); }
  }
  return <main className="journey-page journey-split">
    <form className="journey-card journey-form" onSubmit={submit}>
      <div><span className="panel-kicker">{job.product.name}</span><h1 tabIndex={-1}>修改某个镜头</h1><p>只重新生成这一镜。其他镜头、配音、字幕和原版都会保留。</p></div>
      <label className="field-label">想改哪一镜？<select value={shotId} onChange={(event) => setShotId(event.target.value)} disabled={pending}>{shots.map((shot) => <option key={shot.id} value={shot.id}>第 {shot.order} 镜 · {shot.label}（{shot.start_seconds}–{shot.end_seconds} 秒）</option>)}</select></label>
      <label className="field-label">希望怎么改？<textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} disabled={pending} rows={5} maxLength={300} required placeholder="例如：用固定机位拍，手从右侧把商品抬起，前后都保持商品完整入镜。" /></label>
      {!servicesReady && <p className="journey-note" role="status">生成服务尚未就绪，请稍等。</p>}
      {error && <p className="warning-copy" role="alert">{error}</p>}
      <div className="journey-actions"><button className="button button-primary" type="submit" disabled={pending || !shotId || !feedback.trim() || !servicesReady}>{pending ? <LoaderCircle className="spin" size={17} /> : <Clapperboard size={17} />}{pending ? '提交中…' : '只重做这一镜'}</button></div>
    </form>
    {clip && <section className="journey-card journey-viewer"><h2>当前镜头</h2><div className="journey-frame"><Clip output={{ videoUrl: clip }} label="当前镜头原片" /></div></section>}
  </main>;
}

export function ShotComparisonPage({ job, onSource }) {
  const revision = job.userRevision;
  const clip = job.selectedShots?.find((item) => item.shotId === revision.shotId)?.videoUrl;
  return <main className="journey-page journey-card journey-form">
    <div><span className="panel-kicker">单镜修改</span><h1 tabIndex={-1}>对比修改前后</h1><p>「{revision.shotLabel}」的两段原片。分别播放即可检查动作和构图。</p></div>
    <div className="journey-note"><strong>你的修改意见</strong><p>{revision.feedback}</p></div>
    <div className="journey-comparison"><section><h2>修改前</h2><div className="journey-frame"><Clip output={{ videoUrl: revision.originalClipUrl }} label="修改前镜头" /></div></section><section><h2>修改后</h2>{clip ? <div className="journey-frame"><Clip output={{ videoUrl: clip }} label="修改后镜头" /></div> : <p>新版镜头尚未生成。</p>}</section></div>
    {revision.revisedPrompt && <details className="journey-instructions"><summary>查看改写前后的画面指令</summary><dl><dt>修改前</dt><dd>{revision.originalPrompt}</dd><dt>修改后</dt><dd>{revision.revisedPrompt}</dd></dl></details>}
    <div className="journey-actions"><button className="button button-secondary" type="button" onClick={onSource}>打开原版成片</button></div>
  </main>;
}

export function NarrationPage({ job, voiceVersion, status, onSaved }) {
  return <main className="journey-page journey-card journey-form">
    <div><span className="panel-kicker">{job.product.name}</span><h1 tabIndex={-1}>编辑配音</h1><p>选镜头、改口播或换音色，试听后生成配音版。</p></div>
    <NarrationStudio key={voiceVersion?.id || 'original'} job={job} version={voiceVersion} status={status} onSaved={onSaved} />
  </main>;
}

export function ExportPage({ job, voiceVersion, onVoiceChange, onUpdate }) {
  const [format, setFormat] = useState('9:16');
  const [style, setStyle] = useState('original');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const originals = originalOutputs(job);
  const outputs = style === 'soft-matte' ? job.softenedOutputs?.[voiceVersion?.id || 'original'] : voiceVersion?.outputs || originals;
  const output = outputs?.[format];
  const canSoften = originals['9:16'] && job.conditioning?.padded && job.renderPolicy !== softMattePolicy;
  async function render() {
    setPending(true); setError('');
    try {
      const response = await fetch(`/api/jobs/${job.id}/recompose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format, style, voiceVersionId: voiceVersion?.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '视频合成未完成。');
      onUpdate(result.job);
    } catch (failure) { setError(failure.message); }
    finally { setPending(false); }
  }
  return <main className="journey-page journey-card journey-form">
    <div><span className="panel-kicker">{job.product.name}</span><h1 tabIndex={-1}>其他画幅与版本</h1><p>用当前镜头和配音重新排版，不调用视频生成模型。</p></div>
    {!!job.narrationVersions?.length && <label className="field-label">配音版本<select disabled={pending} value={voiceVersion?.id || ''} onChange={(event) => { onVoiceChange(event.target.value); setError(''); }}><option value="">最初配音</option>{job.narrationVersions.map((item, index) => <option key={item.id} value={item.id}>配音版 {index + 1} · {item.voice}</option>)}</select></label>}
    <label className="field-label">画幅<select value={format} disabled={pending} onChange={(event) => { setFormat(event.target.value); setError(''); }}>{formats.map((item, index) => <option key={item} value={item} disabled={!originals['9:16'] && index !== 0}>{['竖屏', '方形', '横屏'][index]} {item}</option>)}</select></label>
    {canSoften && <label className="field-label">成片背景<select value={style} disabled={pending} onChange={(event) => { setStyle(event.target.value); setError(''); }}><option value="original">保持原版</option><option value="soft-matte">柔化补边</option></select></label>}
    {error && <p className="warning-copy" role="alert">{error}</p>}
    <div className="journey-actions">{output ? <a className="button button-primary" href={output.videoUrl} download={output.fileName}><ArrowDownToLine size={17} />下载 {format}</a> : <button className="button button-primary" type="button" onClick={render} disabled={pending}>{pending ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}{pending ? '正在合成…' : `合成 ${format}`}</button>}</div>
  </main>;
}
