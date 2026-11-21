import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, BadgeCheck, Check, ChevronRight, CircleAlert, Film, FileVideo2, LoaderCircle, RefreshCw, ScanEye } from 'lucide-react';
import { clockLabel, imageAsset, originalOutputs, StatusDot } from './ui.jsx';

const workflowSteps = [
  { key: 'prepare', label: '素材与工作流', model: 'STUDIO', description: '校验商品素材，提交 Wan 工作流' },
  { key: 'wan', label: '主镜头生成', model: 'WAN 2.2', description: '在 RTX 3090 上生成商品动作镜头' },
  { key: 'review', label: '画面质检', model: 'QWEN3-VL', description: '抽取关键帧并检查商品、动作与画质' },
  { key: 'revision', label: '提示词返工', model: 'QWEN3-VL', description: '根据可定位问题改写镜头指令' },
  { key: 'narration', label: '配音与字幕', model: 'Qwen3-TTS', description: '在 Mac 上按分镜生成中文旁白，并同步字幕' },
  { key: 'compose', label: '合成与导出', model: 'FFMPEG', description: '拼接片头、主镜头、细节与 CTA' },
];

function getWorkflowStepState(job, key) {
  if (!job) return 'idle';
  const status = job.status;
  const attempts = job.attempts || [];
  const reviews = attempts.map((attempt) => attempt.review).filter(Boolean);
  const terminal = ['completed', 'failed'].includes(status);
  if (key === 'prepare') {
    if (['queued', 'preparing'].includes(status)) return 'current';
    return job.progress > 0 || terminal ? 'done' : 'idle';
  }
  if (key === 'wan') {
    if (status === 'generating') return 'current';
    if (attempts.some((attempt) => attempt.videoUrl) || ['reviewing', 'revising', 'composing', 'completed'].includes(status)) return 'done';
    return status === 'failed' ? 'error' : 'idle';
  }
  if (key === 'review') {
    if (job.mode === 'baseline') return 'skipped';
    if (status === 'reviewing') return 'current';
    if (reviews.length) {
      const selectedReviews = (job.selectedShots || []).map((selected) => attempts.find((attempt) => attempt.number === selected.attemptNumber)).filter((attempt) => !attempt?.reused).map((attempt) => attempt?.review);
      if (selectedReviews.length) return selectedReviews.every((review) => review?.status === 'completed' && review.approved) ? 'done' : 'warning';
      const latestReview = reviews.at(-1);
      return latestReview?.status === 'completed' && latestReview.approved ? 'done' : 'warning';
    }
    if (['composing', 'completed'].includes(status)) return 'skipped';
    return status === 'failed' ? 'error' : 'idle';
  }
  if (key === 'revision') {
    if (job.mode === 'baseline') return 'skipped';
    if (status === 'revising') return 'current';
    if (attempts.some((attempt) => attempt.shotAttempt > 1) || job.logs?.some((entry) => entry.message.includes('返工指令已更新'))) return 'done';
    if (reviews.at(-1)?.approved) return 'skipped';
    if (terminal || status === 'composing') return 'warning';
    return 'idle';
  }
  if (key === 'narration') {
    if (!job.narrationEnabled) return 'skipped';
    if (job.logs?.some((entry) => entry.stage === 'narration' && entry.message === '中文旁白与字幕已就绪')) return 'done';
    if (status === 'composing' && job.stage === 'narration') return 'current';
    if (['completed', 'composing'].includes(status)) return job.narration?.warnings?.length ? 'warning' : 'done';
    return status === 'failed' ? 'error' : 'idle';
  }
  if (key === 'compose') {
    if (status === 'composing' && job.stage !== 'narration') return 'current';
    if (status === 'completed') return job.compositionWarning ? 'warning' : 'done';
    return status === 'failed' ? 'error' : 'idle';
  }
  return 'idle';
}

function buildOutputSegments(job) {
  const shots = job?.storyboard?.shots || [];
  if (shots.length < 3) return [];
  const generatedDuration = (job.profile?.frames || 73) / 24;
  const segments = shots.flatMap((shot) => {
    const duration = shot.end_seconds - shot.start_seconds;
    if (shot.kind !== 'wan') return [{ shotId: shot.id, label: shot.label, kind: shot.id === 'cta' ? 'cta' : 'title', start: shot.start_seconds, duration }];
    const raw = Math.min(duration, generatedDuration);
    const remaining = duration - raw;
    return [
      { shotId: shot.id, label: `${shot.label} · Wan`, kind: 'ai-video', start: shot.start_seconds, duration: raw },
      ...(remaining > 0.02 ? [{ shotId: shot.id, label: `${shot.label} · 画面细节`, kind: 'detail', start: shot.start_seconds + raw, duration: remaining }] : []),
    ];
  });
  return segments.filter((segment) => segment.duration > 0);
}

function WorkflowStep({ step, state, active, onClick, duration }) {
  const indicator = state === 'done' ? <Check size={14} /> : state === 'current' ? <LoaderCircle size={14} className="spin" /> : state === 'warning' || state === 'error' ? <CircleAlert size={14} /> : <span>{state === 'skipped' ? '–' : step.index}</span>;
  return <button type="button" className={`workflow-step ${state} ${active ? 'active' : ''}`} aria-pressed={active} onClick={onClick}>
    <span className="workflow-indicator">{indicator}</span>
    <span className="workflow-copy"><span className="workflow-title"><strong>{step.label}</strong><small>{step.model}</small></span><span>{state === 'current' ? duration || step.description : state === 'done' ? '已完成 · 点击检查结果' : state === 'skipped' ? '本次未执行' : state === 'warning' ? '需要人工复核' : state === 'error' ? '执行失败' : step.description}</span></span>
    <ChevronRight size={16} className="workflow-chevron" />
  </button>;
}

export default function ProcessWorkspace({ job }) {
  const player = useRef(null);
  const pendingSeek = useRef(null);
  const [stageOverride, setSelectedStage] = useState(null);
  const [mediaMode, setMediaMode] = useState('final');
  const [attemptNumber, setAttemptNumber] = useState(null);
  const [evidenceFrame, setEvidenceFrame] = useState(null);
  const [currentTime, setCurrentTime] = useState(0);
  const finalAttempt = job?.attempts?.find((attempt) => attempt.number === job.selectedAttempt) || job?.attempts?.at(-1);
  const output = originalOutputs(job)['9:16'];
  const activeFinalUrl = output?.videoUrl;
  const hasFinal = Boolean(activeFinalUrl);
  const showingFinal = hasFinal && mediaMode === 'final';
  const selectedAttempt = (showingFinal ? finalAttempt : job?.attempts?.find((attempt) => attempt.number === attemptNumber)) || finalAttempt;
  const showingEvidence = mediaMode === 'evidence' && Boolean(evidenceFrame);
  const mediaUrl = showingFinal ? activeFinalUrl : showingEvidence ? null : selectedAttempt?.videoUrl;
  const review = selectedAttempt?.review;
  const frames = review?.frames || [];
  const duration = Number(job?.duration || job?.storyboard?.shots?.at(-1)?.end_seconds || job?.profile?.frames / 24 || 0);
  const rawDuration = Number(job?.profile?.frames || 73) / 24;
  const timelineDuration = showingFinal ? duration : rawDuration;
  const segments = buildOutputSegments(job);
  const selectedStage = stageOverride || workflowSteps.find((step) => getWorkflowStepState(job, step.key) === 'current')?.key
    || (job?.status === 'completed' ? 'compose' : 'prepare');
  const activeStep = workflowSteps.find((step) => step.key === selectedStage) || workflowSteps[0];
  function filteredLogsForStage(stage) {
    return (job?.logs || []).filter((entry) => {
      if (stage === 'prepare') return entry.stage === 'system';
      if (stage === 'wan') return entry.stage === 'wan';
      if (stage === 'review') return entry.stage === 'qwen' && !entry.message.includes('返工');
      if (stage === 'revision') return entry.stage === 'qwen' && entry.message.includes('返工');
      if (stage === 'narration') return entry.stage === 'narration';
      return entry.stage === 'ffmpeg';
    });
  }
  const filteredLogs = filteredLogsForStage(selectedStage);

  function applyPendingSeek() {
    if (pendingSeek.current == null || !player.current || player.current.readyState < 1) return;
    player.current.currentTime = Math.min(pendingSeek.current, player.current.duration || pendingSeek.current);
    pendingSeek.current = null;
  }

  useEffect(() => { applyPendingSeek(); }, [mediaUrl]);

  function seek(seconds, offset = 0) {
    const target = Math.max(0, seconds + offset);
    pendingSeek.current = target;
    applyPendingSeek();
    window.requestAnimationFrame(applyPendingSeek);
  }

  function selectReviewFrame(frame) {
    player.current?.pause();
    pendingSeek.current = null;
    setSelectedStage('review');
    setEvidenceFrame(frame);
    setAttemptNumber(selectedAttempt?.number);
    setMediaMode('evidence');
    setCurrentTime(frame.time);
  }

  function changeMediaMode(nextMode, attempt = selectedAttempt, baseTime = currentTime) {
    const nextUrl = nextMode === 'final' ? activeFinalUrl : attempt?.videoUrl;
    const shotStart = segments.find((segment) => segment.shotId === attempt?.shotId && segment.kind === 'ai-video')?.start || 0;
    const target = nextMode === 'final' ? (showingFinal ? baseTime : shotStart + Math.max(0, baseTime)) : (showingFinal ? Math.max(0, baseTime - shotStart) : Math.max(0, baseTime));
    pendingSeek.current = nextUrl ? target : null;
    if (nextUrl !== mediaUrl) setCurrentTime(0);
    setAttemptNumber(nextMode === 'final' ? null : attempt?.number);
    setMediaMode(nextMode);
    if (nextUrl === mediaUrl) {
      applyPendingSeek();
      window.requestAnimationFrame(applyPendingSeek);
    }
  }

  function openAttempt(attempt) {
    setSelectedStage('wan');
    changeMediaMode('raw', attempt, 0);
  }

  const stepDuration = (stage) => {
    const ms = filteredLogsForStage(stage).reduce((sum, entry) => sum + (entry.elapsedMs || 0), 0);
    return ms ? `${(ms / 1000).toFixed(1)} 秒` : '';
  };

  return <main className="process-workspace">
    <section className="process-player-panel">
      <div className="process-panel-heading"><div><span className="panel-kicker">生成产物</span><h2>{job ? job.product?.name || '广告视频' : '视频与质检帧'}</h2></div>
        {job?.attempts?.length > 0 && <div className="attempt-selector" role="group" aria-label="选择镜头生成结果">{job.attempts.map((attempt) => <button key={attempt.number} type="button" aria-pressed={!showingFinal && selectedAttempt?.number === attempt.number} onClick={() => openAttempt(attempt)}>{`镜头 ${attempt.shotOrder || 1} · ${attempt.reused ? '沿用原片' : `第 ${attempt.shotAttempt || attempt.number} 次`}`}</button>)}</div>}
      </div>
      <div className="process-media-toolbar">
        <div className="media-selector" role="group" aria-label="选择视频版本">
          <button type="button" aria-pressed={showingFinal} disabled={!hasFinal} onClick={() => changeMediaMode('final')}>合成成片</button>
          <button type="button" aria-pressed={!showingFinal && Boolean(mediaUrl)} disabled={!selectedAttempt?.videoUrl} onClick={() => changeMediaMode('raw')}>Wan 原片</button>
        </div>
        <span className={`process-media-state ${job?.status === 'completed' ? 'ready' : job ? 'running' : ''}`}><StatusDot state={job?.status === 'failed' ? 'error' : job?.status === 'completed' ? 'ready' : job ? 'starting' : 'pending'} />{!job ? '等待任务' : job.status === 'completed' ? (job.compositionWarning ? '合成失败 · 展示原片' : '成片已完成') : job.status === 'failed' ? '任务失败' : job.message}</span>
      </div>
      <div className="process-video-frame">
        {showingEvidence ? <figure className="process-evidence-preview">
          <img src={evidenceFrame.url} alt={`原片 ${evidenceFrame.time.toFixed(2)} 秒质检抽帧`} />
          <figcaption><span>原片 {evidenceFrame.time.toFixed(2)} 秒 · 第 {selectedAttempt?.shotAttempt || selectedAttempt?.number || 1} 轮</span>{selectedAttempt?.videoUrl && <a className="text-button" href={`${selectedAttempt.videoUrl}#t=${evidenceFrame.time}`} target="_blank" rel="noreferrer">在新页查看原片 <ArrowUpRight size={14} /></a>}</figcaption>
        </figure> : mediaUrl ? <video key={mediaUrl} ref={player} src={mediaUrl} controls playsInline preload="metadata" onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={applyPendingSeek}>{showingFinal && (output?.captionsUrl || job.captionsUrl) && <track kind="subtitles" src={output?.captionsUrl || job.captionsUrl} srcLang="zh" label="简体中文" default />}</video> : <div className="process-video-empty">{job && ['queued', 'preparing', 'generating', 'reviewing', 'revising', 'composing'].includes(job.status) ? <><LoaderCircle size={28} className="spin" /><strong>{job.message}</strong><span>原片生成后会显示在这里</span></> : <><FileVideo2 size={30} /><strong>{job ? selectedAttempt?.error || job.error || '尚未生成可预览的视频' : '还没有选中的生成任务'}</strong><span>{job ? '可返回成片页选择下一步' : '创建一次生成任务，或从历史记录选择一个任务'}</span></>}</div>}
      </div>
      {mediaUrl && <>
        <div className="output-timeline-head"><strong>{showingFinal ? `成片片段 · ${job?.storyboard?.shots?.filter((shot) => shot.kind === 'wan').length || 1} 个 Wan 镜头` : `镜头 ${selectedAttempt?.shotOrder || 1} · 第 ${selectedAttempt?.shotAttempt || selectedAttempt?.number || 1} 次原片`}</strong><span>{clockLabel(Math.min(currentTime, timelineDuration))} / {clockLabel(timelineDuration)}</span></div>
        <div className="output-timeline" role="group" aria-label="视频片段导航">
          {showingFinal && segments.length ? segments.map((segment) => <button key={`${segment.kind}-${segment.start}`} type="button" className={`output-segment ${segment.kind}`} style={{ '--segment-duration': segment.duration }} title={`${segment.label} · ${segment.duration.toFixed(1)} 秒`} onClick={() => seek(segment.start)}><strong>{segment.label}</strong><small>{clockLabel(segment.start)}</small></button>) : <button type="button" className="output-segment ai-video" style={{ '--segment-duration': timelineDuration }} onClick={() => seek(0)}><strong>Wan 原始生成视频</strong><small>00:00</small></button>}
          <span className="output-playhead" style={{ left: `${Math.min(100, Math.max(0, currentTime / Math.max(timelineDuration, 1) * 100))}%` }} />
        </div>
      </>}
      {frames.length > 0 && <div className="qc-strip">
        <div className="qc-strip-heading"><strong><ScanEye size={15} /> 第 {selectedAttempt.number} 次质检抽帧</strong><span>{review?.model || 'Qwen3-VL'}</span></div>
        <div className="qc-frame-list">{frames.map((frame) => {
          const issue = review?.issues?.find((item) => Math.abs(Number(item.time_seconds) - frame.time) <= 0.5);
          const shotStart = segments.find((segment) => segment.shotId === selectedAttempt?.shotId && segment.kind === 'ai-video')?.start || 0;
          return <button key={frame.url} type="button" className={`qc-frame ${issue ? 'has-issue' : ''} ${Math.abs(currentTime - frame.time - (showingFinal ? shotStart : 0)) < 0.3 ? 'selected' : ''}`} onClick={() => selectReviewFrame(frame)}>
            <img src={frame.url} alt={`${frame.time.toFixed(2)} 秒质检画面`} loading="lazy" />
            <span>{frame.time.toFixed(2)}s{issue ? ' · 问题帧' : ''}</span>
          </button>;
        })}</div>
      </div>}
      {job?.attempts?.length > 0 && <div className="process-review-summary">
        {review?.status === 'completed' ? <>
          <ReviewScores review={review} />
          {review.endingCheck && <div className="review-evidence-list"><button className="ending-review-link" type="button" disabled={!frames.length} onClick={() => selectReviewFrame(frames.at(-1))}>
            <ScanEye size={15} /><span><strong>结尾抽帧 · {review.endingCheck.time.toFixed(2)} s · {endingStateLabels[review.endingCheck.state]}</strong>{review.endingCheck.observation}</span><ChevronRight size={15} />
          </button></div>}
          {review.issues?.some((issue) => issue.source !== 'ending-check') && <div className="review-evidence-list">{review.issues.filter((issue) => issue.source !== 'ending-check').map((issue, index) => <button key={`${issue.time_seconds}-${index}`} type="button" onClick={() => selectReviewFrame(frames.reduce((best, frame) => Math.abs(frame.time - issue.time_seconds) < Math.abs(best.time - issue.time_seconds) ? frame : best, frames[0]))} disabled={!frames.length}><CircleAlert size={15} /><span><strong>{issue.time_seconds}s · {issueLabels[issue.category] || issue.category}</strong>{issue.evidence}</span><ChevronRight size={15} /></button>)}</div>}
          {!review.endingCheck && !review.issues?.length && <div className="review-clear"><BadgeCheck size={16} />本轮抽样帧未发现需要返工的问题</div>}
        </> : review && <div className="manual-review"><CircleAlert size={15} />质检未完成：{review.reason || '需要人工复核'}</div>}
      </div>}
    </section>

    <section className="process-flow-panel">
      <div className="process-panel-heading"><div><span className="panel-kicker">生成过程</span><h2>模型协作路径</h2></div>{job && <span className="process-percent">{job.progress ?? 0}%</span>}</div>
      {job && <progress className={`process-progress ${job.status}`} aria-label="任务进度" max="100" value={job.progress ?? 0} />}
      <div className="workflow-list">{workflowSteps.map((step, index) => {
        const state = getWorkflowStepState(job, step.key);
        return <div className="workflow-node" key={step.key}>
          <WorkflowStep step={{ ...step, index: String(index + 1).padStart(2, '0') }} state={state} active={selectedStage === step.key} duration={stepDuration(step.key)} onClick={() => setSelectedStage(step.key)} />
          {index < workflowSteps.length - 1 && <span className={`workflow-link ${state === 'done' ? 'done' : ''}`} />}
        </div>;
      })}</div>
      {selectedStage === 'wan' && job?.attempts?.some((attempt) => attempt.shotAttempt > 1) && <div className="workflow-loop"><RefreshCw size={14} />Qwen 已根据对应镜头质检结果修改指令并触发返工</div>}
      <div className="step-inspector">
        <div className="step-inspector-heading"><span className={`model-label ${activeStep.model.toLowerCase().replaceAll('.', '').replaceAll(' ', '-')}`}>{activeStep.model}</span><strong>{activeStep.label}</strong>{job && <small>{stepDuration(selectedStage)}</small>}</div>
        {!job ? <p>选择一条运行记录后，可以查看实际模型输入、生成轮次、质检帧和合成结果。</p>
          : selectedStage === 'prepare' ? <div className="inspector-facts"><span>商品<strong>{job.product?.name || '未命名商品'}</strong></span><span>目标受众<strong>{job.product?.audience || '未指定'}</strong></span><span>画幅<strong>{job.profile?.width && job.profile?.height ? `${job.profile.width} × ${job.profile.height}` : '9:16 竖屏'}</strong></span><span>实验 Seed<strong>{job.seed}</strong></span>{job.conditioning && <details className="conditioning-preview"><summary>查看 Wan 实际参考帧</summary><div className="conditioning-images"><figure><img alt="原商品参考图" src={job.assetId ? `/api/assets/${job.assetId}/image` : imageAsset}/><figcaption>原图 · {job.conditioning.sourceWidth} × {job.conditioning.sourceHeight}</figcaption></figure><figure><img alt="Wan 实际收到的参考帧" src={job.conditioning.url}/><figcaption>{job.conditioning.padded ? '补边保全画面' : '同比例缩放'} · {job.conditioning.width} × {job.conditioning.height}</figcaption></figure></div></details>}</div>
            : selectedStage === 'wan' ? <div className="attempt-inspector">{(job.attempts || []).map((attempt) => <button key={attempt.number} type="button" aria-pressed={!showingFinal && selectedAttempt?.number === attempt.number} onClick={() => openAttempt(attempt)}>{`镜头 ${attempt.shotOrder || 1} · 第 ${attempt.shotAttempt || attempt.number} 次`}<span>{attempt.reused ? '沿用原片' : attempt.generationMs ? `${(attempt.generationMs / 1000).toFixed(1)} 秒` : attempt.videoUrl ? '已就绪' : attempt.error || '等待中'}</span></button>)}{selectedAttempt?.prompt && <details><summary>本轮画面指令</summary><p>{selectedAttempt.prompt}</p></details>}</div>
              : selectedStage === 'review' ? review ? <div className="review-inspector">{review.reason && <p>{review.reason}</p>}{review.consistencyWarning && <p className="warning-copy">{review.consistencyWarning}</p>}<span>检查项目：商品身份、指令匹配、动作清晰度、画面伪影</span></div> : <p>{job.mode === 'baseline' ? '基线组跳过 Qwen 质检。' : '质检开始后，这里会显示评分、证据帧和问题定位。'}</p>
              : selectedStage === 'revision' ? <div className="revision-inspector">
                {job.mode === 'baseline' ? <p>单向基线不执行质检返工。</p> : (job.storyboard?.shots || []).filter((shot) => shot.kind === 'wan').map((shot) => {
                  const attempts = (job.attempts || []).filter((attempt) => attempt.shotId === shot.id);
                  const adopted = job.selectedShots?.find((item) => item.shotId === shot.id);
                  return <article className="revision-shot" key={shot.id}>
                    <div className="revision-label"><strong>{shot.label}</strong>{adopted && <span>采用第 {attempts.find((attempt) => attempt.number === adopted.attemptNumber)?.shotAttempt || 1} 轮</span>}</div>
                    {adopted?.decision && <p>{adopted.decision}</p>}
                    <div className="revision-comparison">{attempts.map((attempt) => <div key={attempt.number}>
                      <div className="revision-label"><strong>第 {attempt.shotAttempt || 1} 轮</strong>{attempt.videoUrl && <button type="button" className="text-button" onClick={() => changeMediaMode('raw', attempt, 0)}><Film size={13} />原片</button>}</div>
                      <span>{attempt.error || (attempt.review?.status === 'completed' ? (attempt.review.approved ? '抽样质检通过' : '抽样质检需复核') : '等待有效质检')}</span>
                      {attempt.review?.issues?.length > 0 && <p>{attempt.review.issues[0].evidence}</p>}
                      <details><summary>画面指令</summary><p>{attempt.prompt}</p></details>
                    </div>)}</div>
                    {!attempts.length && <p>等待该镜头生成。</p>}
                  </article>;
                })}
                {job.retryFailure && <p className="warning-copy">{job.retryFailure}</p>}
              </div>
              : selectedStage === 'narration' ? <div className="composition-inspector"><span>{job.userRevision && job.narrationEnabled ? '沿用原版配音与字幕。' : job.narrationEnabled ? '配音可以在成片页单独编辑。' : '此任务未启用配音。'}</span>{job.narration?.warnings?.map((warning) => <p className="warning-copy" key={warning}>{warning}</p>)}</div>
              : <div className="composition-inspector">{job.fileName && <strong>{job.fileName}</strong>}<span>{job.duration ? `${job.duration} 秒 · ${job.outputFormat || '9:16'}` : '合成片头、镜头与行动引导'}</span>{job.compositionWarning && <p className="warning-copy">{job.compositionWarning}</p>}</div>}
        {filteredLogs.length > 0 && <div className="step-event-list">{filteredLogs.map((entry, index) => <div key={`${entry.time}-${index}`}><span /><p>{entry.message}</p><time>{entry.elapsedMs ? `${(entry.elapsedMs / 1000).toFixed(1)} 秒` : new Date(entry.time).toLocaleTimeString()}</time></div>)}</div>}
      </div>
      {job?.logs?.length > 0 && <details className="all-job-events"><summary>查看全部事件 · {job.logs.length}</summary><div>{job.logs.map((entry, index) => <p key={`${entry.time}-${index}`}><b>{entry.stage.toUpperCase()}</b>{entry.message}<time>{entry.elapsedMs ? `${(entry.elapsedMs / 1000).toFixed(1)}s` : new Date(entry.time).toLocaleTimeString()}</time></p>)}</div></details>}
    </section>
  </main>;
}

const endingStateLabels = { intact: '商品可辨认', partial: '商品大面积遮挡或裁切', absent: '商品出画', deformed: '疑似明显变形', unclear: '无法确认' };
const issueLabels = { product_identity: '商品一致', prompt_match: '指令匹配', motion_clarity: '动作清晰', artifact: '画面质量' };
const reviewScoreFields = [['productIdentityScore', '商品一致'], ['promptMatchScore', '指令匹配'], ['motionClarityScore', '动作清晰'], ['artifactScore', '画面质量']];

function ReviewScores({ review }) {
  return <div className="score-row">
    {reviewScoreFields.filter(([field]) => review[field] != null).map(([field, label]) => <span key={field}>{label} <b>{review.unsupportedScoreFields?.includes(field) ? '待核' : `${review[field]}/5`}</b></span>)}
    <strong className={review.approved ? 'approved' : 'needs-review'}>{review.approved ? '通过' : '需复核'}</strong>
  </div>;
}
