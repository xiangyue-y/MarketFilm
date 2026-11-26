import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import BatchWorkspace from './BatchWorkspace.jsx';
import JobHistory from './JobHistory.jsx';
import ProcessWorkspace from './ProcessWorkspace.jsx';
import { clockLabel, imageAsset, StatusDot } from './ui.jsx';
import { actionCutSeconds, defaultProduct, isActionCut, storyboardToScenes } from '../protocol/storyboard.mjs';
import { VoicePreview } from './NarrationStudio.jsx';
import { ExportPage, NarrationPage, PageBack, ResultPage, ShotComparisonPage, ShotEditPage } from './JourneyPages.jsx';
import ExperimentWorkspace, { BlindReview } from './ExperimentWorkspace.jsx';
import {
  ArrowRight,
  CircleAlert,
  ChevronDown,
  Clapperboard,
  History,
  ImagePlus,
  Images,
  LoaderCircle,
  Maximize2,
  RefreshCw,
  ScanEye,
  Settings2,
  Sparkles,
  X,
} from 'lucide-react';

function DraftPreview({ referenceUrl, scene, product }) {
  if (!referenceUrl) return <div className="process-video-empty"><Clapperboard size={28} /><strong>{scene.label}</strong><span>按场景描述生成</span></div>;
  return <>
    <img className="preview-media preview-still" src={referenceUrl} alt="商品参考画面" />
    <div className="preview-vignette" />
    <div className="preview-copy">
      {scene.id === 'cta' ? <><strong>{product.name}</strong><span>{scene.text}</span></> : <>
        <span>{product.name}</span><strong>{scene.text}</strong>
      </>}
    </div>
    <span className="preview-watermark">分镜 {scene.order}</span>
  </>;
}

function App() {
  const [product, setProduct] = useState(defaultProduct);
  const [storyboard, setStoryboard] = useState(null);
  const [creativeProposals, setCreativeProposals] = useState([]);
  const [proposalMs, setProposalMs] = useState(null);
  const [selectedProposal, setSelectedProposal] = useState(null);
  const [activeScene, setActiveScene] = useState('hero');
  const [referenceFile, setReferenceFile] = useState(null);
  const [referenceUrl, setReferenceUrl] = useState(imageAsset);
  const [referenceAsset, setReferenceAsset] = useState(null);
  const [uploadingDetail, setUploadingDetail] = useState(false);
  const [libraryAssets, setLibraryAssets] = useState([]);
  const [serverStatus, setServerStatus] = useState(null);
  const [job, setJob] = useState(null);
  const [historyJobs, setHistoryJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState('brief');
  const [plannedGoal, setPlannedGoal] = useState(null);
  const [voiceVersionId, setVoiceVersionId] = useState('');
  const [listBack, setListBack] = useState('brief');
  const [runFrom, setRunFrom] = useState(null);
  const menu = useRef(null);
  const shell = useRef(null);
  const firstScreen = useRef(true);
  const [notice, setNotice] = useState('');
  const [historyState, setHistoryState] = useState('loading');
  const [historyView, setHistoryView] = useState({ filter: 'all', expanded: false });
  const [reconnecting, setReconnecting] = useState(false);
  const [strategy, setStrategy] = useState('daily');
  const [duration, setDuration] = useState('7 秒');
  const creativeDuration = Number.parseInt(duration, 10) === actionCutSeconds;
  const [generationMode, setGenerationMode] = useState('audit');
  const [narrationEnabled, setNarrationEnabled] = useState(true);
  const [experimentSeed, setExperimentSeed] = useState(() => crypto.getRandomValues(new Uint32Array(1))[0] % (2 ** 31 - 1) + 1);
  const [planInfo, setPlanInfo] = useState({ source: 'template', reason: '' });
  const fileInput = useRef(null);
  const detailFileInput = useRef(null);
  const zoomDialog = useRef(null);
  const settingsDialog = useRef(null);

  const scenes = useMemo(() => storyboard ? storyboardToScenes(storyboard) : [], [storyboard]);
  const activeSceneData = scenes.find((scene) => scene.id === activeScene) || scenes[1];
  const activeSceneTiming = storyboard?.shots.find((shot) => shot.id === activeScene);
  const actionCut = isActionCut(storyboard);
  const videoModel = (actionCut ? serverStatus?.creativeVideoModel : serverStatus?.videoModel) || 'Wan 2.2 TI2V 5B';
  const usesProductReference = videoModel === 'MiniMax H3 Ref2VA';
  const requiresStartImage = videoModel === 'Wan 2.2 I2V A14B FP8';
  const detailRef = storyboard?.shots.find((shot) => shot.id === 'detail')?.reference_asset_id;
  const detailMode = storyboard?.shots.find((shot) => shot.id === 'detail')?.reference_mode;
  const sceneMode = activeScene === 'cta' ? detailMode : activeSceneTiming?.reference_mode;
  const sceneReferenceUrl = sceneMode === 'scene' ? null : actionCut && detailRef && activeScene !== 'hero' ? `/api/assets/${detailRef}/image` : referenceUrl;
  const busy = ['queued', 'preparing', 'generating', 'reviewing', 'revising', 'composing'].includes(job?.status);
  const voiceVersion = job?.narrationVersions?.find((item) => item.id === voiceVersionId);
  const goal = (product.creativeGoal || '').trim();
  const draftCurrent = Boolean(storyboard) && goal === plannedGoal;
  const inJourney = ['brief', 'proposals', 'storyboard', 'result'].includes(workspaceTab);
  const inJobDetail = ['process', 'revise', 'compare-shot', 'narration', 'export'].includes(workspaceTab);
  const inLibrary = ['history', 'batch', 'experiments'].includes(workspaceTab);
  const getStatus = useCallback(async () => {
    try {
      const response = await fetch('/api/status');
      if (!response.ok) throw new Error('服务状态不可用');
      setServerStatus(await response.json());
    } catch {
      setServerStatus({ service: { status: 'error', message: '本地服务未启动', error: '运行 npm run dev 启动前后端' }, videoModel: 'Wan 2.2 TI2V 5B' });
    }
  }, []);

  useEffect(() => {
    getStatus();
    const timer = window.setInterval(getStatus, 4000);
    return () => window.clearInterval(timer);
  }, [getStatus]);

  const getHistory = useCallback(async () => {
    try {
      const response = await fetch('/api/jobs');
      if (!response.ok) throw new Error('无法获取运行记录');
      setHistoryJobs((await response.json()).jobs || []);
      setHistoryState('ready');
    } catch { setHistoryState('error'); }
  }, []);

  const getAssets = useCallback(async () => {
    try {
      const result = await fetch('/api/assets');
      if (result.ok) setLibraryAssets((await result.json()).assets || []);
    } catch { /* A library error does not block uploading a reference file. */ }
  }, []);
  useEffect(() => { if (workspaceTab === 'brief') void getAssets(); }, [workspaceTab, getAssets]);

  useEffect(() => {
    getHistory();
    const timer = window.setInterval(getHistory, 4000);
    return () => window.clearInterval(timer);
  }, [getHistory]);

  useEffect(() => {
    if (!job?.id || !busy) return undefined;
    if (window.EventSource) {
      const stream = new EventSource(`/api/jobs/${job.id}/events`);
      const updateJobFromEvent = (event) => {
        try {
          const nextJob = JSON.parse(event.data);
          if (nextJob.id !== job.id) return;
          setJob(nextJob);
          setHistoryJobs((current) => current.map((item) => item.id === nextJob.id ? nextJob : item));
        } catch {
          setNotice('生成进度数据读取失败');
        }
      };
      stream.addEventListener('snapshot', updateJobFromEvent);
      stream.addEventListener('update', updateJobFromEvent);
      stream.onopen = () => setNotice('');
      return () => stream.close();
    }

    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${job.id}`);
        if (!response.ok) return;
        const body = await response.json();
        if (!stopped) setJob(body.job);
      } catch {
        // The next poll retries a brief connection failure.
      }
    };
    void poll();
    const timer = window.setInterval(poll, 1800);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [job?.id, busy]);

  useEffect(() => {
    if (job?.status === 'completed') void getStatus();
  }, [job?.id, job?.status, getStatus]);

  useEffect(() => () => {
    if (referenceUrl.startsWith('blob:')) URL.revokeObjectURL(referenceUrl);
  }, [referenceUrl]);

  function setProductField(field, value) {
    setProduct((current) => ({ ...current, [field]: value }));
  }

  function updateShot(shotId, field, value) {
    setStoryboard((current) => ({ ...current, shots: current.shots.map((shot) => shot.id === shotId ? { ...shot, [field]: value } : shot) }));
  }

  function updatePrompt(shotId, value) {
    if (shotId === 'hero') setProductField('prompt', value);
    updateShot(shotId, 'visual_prompt', value);
  }

  async function regeneratePlan(nextDuration = duration, nextStrategy = strategy, proposal = selectedProposal) {
    setLoading(true);
    setNotice('');
    try {
      const seconds = Number.parseInt(nextDuration, 10);
      let asset = referenceAsset;
      if (seconds === actionCutSeconds && referenceFile) {
        asset = await saveReference(referenceFile);
        setReferenceAsset(asset);
        setReferenceFile(null);
        setReferenceUrl(asset.url);
      }
      const response = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ product, strategy: nextStrategy, duration: seconds, assetId: asset?.id, proposal }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '策划失败');
      setDuration(nextDuration);
      setStrategy(nextStrategy);
      if (isActionCut(result.storyboard) && detailRef) {
        const detail = result.storyboard.shots.find((shot) => shot.id === 'detail');
        if (!detail.reference_mode) detail.reference_asset_id = detailRef;
      }
      setStoryboard(result.storyboard);
      setSelectedProposal(result.selectedProposal);
      const primaryPrompt = result.storyboard.shots.find((shot) => shot.kind === 'wan')?.visual_prompt || product.prompt;
      setProduct((current) => ({ ...current, prompt: primaryPrompt, hook: result.storyboard.shots[0].copy }));
      setPlanInfo({ source: result.source, model: result.model, reason: result.reason || '', elapsedMs: result.elapsedMs });
      setActiveScene('hero');
      const acceptedGoal = goal ? result.storyboard.campaign.objective : '';
      setPlannedGoal(acceptedGoal);
      if (goal !== acceptedGoal) setProductField('creativeGoal', acceptedGoal);
      navigate('storyboard');
    } catch (error) {
      setNotice(error.message || '创意脚本生成失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  async function generateCreativeProposals() {
    setLoading(true);
    setNotice('');
    try {
      let asset = referenceAsset;
      if (!asset && referenceFile) {
        asset = await saveReference(referenceFile);
        setReferenceAsset(asset);
        setReferenceFile(null);
        setReferenceUrl(asset.url);
      }
      const response = await fetch('/api/creative-proposals', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ product, assetId: asset?.id }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '创意提案生成失败');
      setCreativeProposals(result.proposals);
      setProposalMs(result.elapsedMs);
      setSelectedProposal(null);
      setStoryboard(null);
      setDuration('8 秒');
      navigate('proposals');
    } catch (error) {
      setNotice(error.message || '创意提案生成失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  function chooseProposal(proposal) {
    void regeneratePlan('8 秒', strategy, proposal);
  }

  async function submitGeneration(mode = generationMode) {
    if (busy || loading || submitting || !draftCurrent) return;
    setSubmitting(true);
    setNotice('');
    try {
      const form = new FormData();
      form.append('product', JSON.stringify(product));
      form.append('storyboard', JSON.stringify({ ...storyboard, shots: storyboard.shots.map((shot) => ({ ...shot, voiceover: shot.voiceover?.trim() })) }));
      form.append('mode', mode);
      if (mode === 'creative-compare') {
        form.append('proposal', JSON.stringify(selectedProposal));
        form.append('strategy', strategy);
        form.append('proposalMs', String(proposalMs));
        form.append('storyboardMs', String(planInfo.elapsedMs));
      }
      form.append('seed', String(experimentSeed));
      form.append('narration', String(narrationEnabled));
      if (referenceFile) {
        form.append('reference', referenceFile);
      } else if (referenceAsset) {
        form.append('assetId', referenceAsset.id);
      }
      const response = await fetch('/api/generate', { method: 'POST', body: form });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || '无法创建生成任务');
      openRun(body.job, null);
      void getHistory();
    } catch (error) {
      setNotice(error.message || '提交失败');
      await getStatus();
    } finally {
      setSubmitting(false);
    }
  }

  function handleImage(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setNotice('请上传 JPG、PNG 或 WebP 图片');
      return;
    }
    if (file.size > 18 * 1024 * 1024) {
      setNotice('图片需要小于 18 MB');
      return;
    }
    setReferenceFile(file);
    setReferenceAsset(null);
    setReferenceUrl(URL.createObjectURL(file));
    setPlannedGoal(null);
    setSelectedProposal(null);
    setCreativeProposals([]);
  }

  async function saveReference(file) {
    const form = new FormData();
    form.append('reference', file);
    const response = await fetch('/api/assets', { method: 'POST', body: form });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '无法保存参考图。');
    setLibraryAssets((current) => [result.asset, ...current.filter((asset) => asset.id !== result.asset.id)]);
    return result.asset;
  }

  async function uploadDetailReference(file) {
    if (!file || uploadingDetail) return;
    setUploadingDetail(true);
    setNotice('');
    try {
      const asset = await saveReference(file);
      updateShot('detail', 'reference_asset_id', asset.id);
    } catch (error) {
      setNotice(error.message);
    } finally {
      setUploadingDetail(false);
    }
  }

  function selectScene(id) { setActiveScene(id); }

  function openZoom() { zoomDialog.current?.showModal(); }

  function navigate(page) {
    menu.current?.removeAttribute('open');
    setNotice('');
    setWorkspaceTab(page);
  }

  useEffect(() => {
    if (firstScreen.current) { firstScreen.current = false; return; }
    const next = shell.current?.querySelector('.journey-heading h1, main:not([hidden]) h1, main:not([hidden]) h2');
    if (next) { next.tabIndex = -1; next.focus({ preventScroll: true }); }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }, [workspaceTab]);

  function openLibrary(page) {
    if (!inLibrary) setListBack(inJobDetail ? 'result' : workspaceTab);
    navigate(page);
  }

  function openRun(run, origin = inLibrary ? workspaceTab : null) {
    setJob(run);
    setVoiceVersionId('');
    setRunFrom(origin);
    navigate('result');
  }

  async function openSource() {
    const id = job?.userRevision?.sourceJobId;
    try {
      const response = await fetch(`/api/jobs/${id}`);
      if (!response.ok) throw new Error('原版成片暂时无法打开。');
      const { job: source } = await response.json();
      openRun(source, runFrom);
      const voice = source.narrationVersions?.find((item) => item.outputs?.['9:16']?.videoUrl === job.userRevision.sourceOutput.videoUrl);
      setVoiceVersionId(voice?.id || '');
    } catch (error) { setNotice(error.message); }
  }

  function updateBriefField(field, value) {
    setPlannedGoal(null);
    setSelectedProposal(null);
    setCreativeProposals([]);
    setProductField(field, value);
  }

  function updateActiveJob(next) {
    setJob((current) => current?.id === next.id ? next : current);
    void getHistory();
  }

  const videoService = (actionCut ? serverStatus?.creativeService : null) || serverStatus?.service;
  const modelReady = videoService?.status === 'ready';
  const modelError = videoService?.status === 'error';
  const plannerReady = serverStatus?.planner?.status === 'ready';
  const canGenerate = modelReady && (generationMode === 'baseline' || plannerReady);
  const canCompareCreative = actionCut && usesProductReference && selectedProposal && plannerReady &&
    storyboard.shots.every((shot) => !shot.reference_mode && !shot.reference_asset_id);

  return (
    <div className="app-shell" ref={shell}>
      <header className="topbar">
        <div className="topbar-inner">
          <button className="brand-lockup journey-brand" type="button" aria-label="MarketFilm 广告制作首页" onClick={() => navigate('brief')}><span className="brand-mark"><Clapperboard size={20} /></span><span className="brand-name">Market<span>Film</span></span></button>
          <nav className="journey-nav" aria-label="主导航">
            <button className="text-button" type="button" aria-current={inJourney || inJobDetail ? 'page' : undefined} onClick={() => navigate('brief')}>广告制作</button>
            <button className="text-button" type="button" aria-current={workspaceTab === 'history' ? 'page' : undefined} onClick={() => openLibrary('history')}><History size={16} />运行记录</button>
            <details ref={menu} className="journey-menu"><summary>更多<ChevronDown size={15} /></summary><div><button className="text-button" type="button" onClick={() => openLibrary('batch')}><Images size={16} />批量制作</button><button className="text-button" type="button" onClick={() => openLibrary('experiments')}><ScanEye size={16} />实验对照</button></div></details>
          </nav>
        </div>
      </header>

      {inJourney && <nav className="journey-steps" aria-label="广告制作步骤">
        {[['brief', '填写需求'], ...(creativeDuration ? [['proposals', '选创意']] : []), ['storyboard', '确认分镜'], ['result', '成片']].map(([page, label], index) => <button key={page} type="button" aria-current={workspaceTab === page ? 'step' : undefined} disabled={(page === 'proposals' && !creativeProposals.length) || (page === 'storyboard' && !draftCurrent) || (page === 'result' && !job)} onClick={() => navigate(page)}><span>{index + 1}</span>{label}</button>)}
      </nav>}
      {inJobDetail && <PageBack onClick={() => navigate('result')}>{busy ? '返回制作进度' : '返回成片'}</PageBack>}
      {inLibrary && <PageBack onClick={() => navigate(listBack)}>{listBack === 'result' ? '返回成片' : listBack === 'storyboard' ? '返回分镜' : '返回广告制作'}</PageBack>}
      {workspaceTab === 'result' && runFrom && <PageBack onClick={() => navigate(runFrom)}>{runFrom === 'batch' ? '返回批量制作' : runFrom === 'experiments' ? '返回实验对照' : '返回运行记录'}</PageBack>}
      {notice && workspaceTab !== 'process' && <div className="journey-alert" role="alert"><CircleAlert size={17} />{notice}</div>}

      {workspaceTab === 'brief' && <main className="journey-page journey-brief">
        <form className="journey-card journey-form" onSubmit={(event) => { event.preventDefault(); if (creativeDuration) void generateCreativeProposals(); else void regeneratePlan(duration, strategy, null); }}>
          <div><span className="panel-kicker">第一步</span><h1 tabIndex={-1}>这条广告想拍什么？</h1><p>先告诉我们你想呈现的画面，再确认 AI 写好的分镜。</p></div>
          <label className="field-label journey-goal">广告目标 <small>可以用中文描述 · 选填</small>
            <textarea name="creativeGoal" value={product.creativeGoal || ''} maxLength={120} rows={3} disabled={loading} onChange={(event) => updateBriefField('creativeGoal', event.target.value)} placeholder="例如：拍给上班族。固定机位拍一只手把随行杯从桌上提起，杯子始终完整入镜。" />
          </label>
          <fieldset className="journey-fields" disabled={loading}>
            <legend>商品资料</legend>
            <label className="field-label">商品名称
              <input value={product.name} maxLength={32} onChange={(event) => updateBriefField('name', event.target.value)} />
            </label>
            <label className="field-label">目标受众
              <input value={product.audience} maxLength={36} onChange={(event) => updateBriefField('audience', event.target.value)} />
            </label>
            <label className="field-label">核心卖点
              <textarea value={product.benefit} rows={2} maxLength={90} onChange={(event) => updateBriefField('benefit', event.target.value)} />
            </label>
            <div className="field-row">
              <label className="field-label">视频时长
                <select value={duration} onChange={(event) => { setDuration(event.target.value); setPlannedGoal(null); setSelectedProposal(null); setCreativeProposals([]); }} disabled={loading}>
                  <option>7 秒</option><option value={`${actionCutSeconds} 秒`}>8 秒 · 创意广告</option><option>15 秒</option>
                </select>
              </label>
              <label className="field-label">画面风格
                <select value={product.tone} onChange={(event) => updateBriefField('tone', event.target.value)}>
                  <option>清新日常</option><option>极简质感</option>
                </select>
              </label>
            </div>
            <label className="field-label">行动引导
              <input value={product.callToAction} maxLength={32} onChange={(event) => updateBriefField('callToAction', event.target.value)} />
            </label>
          </fieldset>
          <div className="journey-actions">
            <button className="button button-primary" disabled={loading || !product.name.trim() || !product.benefit.trim()} type="submit">{loading ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}{loading ? '正在策划…' : creativeDuration ? '生成 3 个创意' : '生成分镜'}{!loading && <ArrowRight size={16} />}</button>
            {creativeDuration && <button className="button button-secondary" type="button" disabled={loading || !product.name.trim() || !product.benefit.trim()} onClick={() => void regeneratePlan(duration, strategy, null)}><Clapperboard size={17} />直接生成分镜</button>}
          </div>
        </form>
        <aside className="journey-card journey-asset">
          <div><h2>商品参考图</h2><p>选一张能看清商品外观的照片，也可以先用示例图试做。</p></div>
          <button className="reference-upload" type="button" disabled={loading} onClick={() => fileInput.current?.click()} aria-label="更换商品参考图">
            <img src={referenceUrl} alt="商品参考图" />
            <span className="image-edit"><ImagePlus size={16} /> 更换图片</span>
          </button>
          <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { handleImage(event.target.files?.[0]); event.target.value = ''; }} />
          <div className="upload-hint"><span>商品参考图</span><span>PNG / JPG / WebP</span></div>
          {libraryAssets.length > 0 && <label className="field-label reference-library">已保存的参考图<select disabled={loading} value={referenceAsset?.id || ''} onChange={(event) => { const asset = libraryAssets.find((item) => item.id === event.target.value); setReferenceFile(null); setReferenceAsset(asset || null); setReferenceUrl(asset?.url || imageAsset); setPlannedGoal(null); setSelectedProposal(null); setCreativeProposals([]); }}><option value="">选择素材</option>{libraryAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label}</option>)}</select></label>}

        </aside>
      </main>}

      {workspaceTab === 'proposals' && <main className="journey-page proposal-page">
        <section className="journey-heading"><div><span className="panel-kicker">第二步</span><h1 tabIndex={-1}>先选一条广告主线</h1><p>三个提案共用商品和 8 秒时长，但开场、动作和卖点揭示方式不同。选定后 GPT 会据此生成分镜。</p></div><button className="button button-secondary" type="button" onClick={() => void generateCreativeProposals()} disabled={loading}>{loading ? '生成中…' : '重新生成 3 个创意'}</button></section>
        <section className="proposal-grid" aria-label="广告创意提案">
          {creativeProposals.map((proposal) => <article className={`journey-card proposal-card${selectedProposal?.id === proposal.id ? ' selected' : ''}`} key={proposal.id}>
            <h2>{proposal.title}</h2>
            <dl><div><dt>开场</dt><dd>{proposal.opening}</dd></div><div><dt>关键动作</dt><dd>{proposal.action}</dd></div><div><dt>卖点结果</dt><dd>{proposal.payoff}</dd></div></dl>
            <button className="button button-primary" type="button" onClick={() => chooseProposal(proposal)} disabled={loading}>{selectedProposal?.id === proposal.id ? '已选，生成分镜' : '选择这条主线'}<ArrowRight size={16} /></button>
          </article>)}
        </section>
      </main>}

      {workspaceTab === 'storyboard' && activeSceneData && <>
        <div className="journey-page journey-heading">
          <div><span className="panel-kicker">分镜</span><h1 tabIndex={-1}>确认分镜</h1><p>{selectedProposal ? selectedProposal.title : goal || '点击时间线，检查每镜的画面指令、文案和口播。'}</p></div>
          <div className="journey-actions">
            <button className="button button-secondary" type="button" aria-haspopup="dialog" onClick={() => settingsDialog.current?.showModal()}><Settings2 size={17} />生成配置</button>
            {selectedProposal && usesProductReference && <button className="button button-secondary" type="button" title="同一参考图、8 秒、Seed 和质检规则，制作直接分镜与选创意两版" onClick={() => void submitGeneration('creative-compare')} disabled={busy || loading || submitting || uploadingDetail || !modelReady || !canCompareCreative || !draftCurrent}><ScanEye size={17} />制作创意对照</button>}
            <button className="button button-primary" type="button" onClick={() => void submitGeneration()} disabled={busy || loading || submitting || uploadingDetail || !canGenerate || !draftCurrent}>{submitting ? <LoaderCircle size={17} className="spin" /> : <Sparkles size={17} />}{busy ? '有任务正在生成' : submitting ? '正在提交…' : '生成广告视频'}</button>
          </div>
        </div>
        {!canGenerate && <div className="journey-alert" role="status"><CircleAlert size={17} />{modelReady && !plannerReady ? `${serverStatus?.planner?.message || '闭环生成需要 GPT 就绪。'} 也可在生成配置中切换为单向基线。` : videoService?.message || '正在连接模型服务…'}{(modelError || (modelReady && !plannerReady)) && <button type="button" className="text-button" disabled={reconnecting} onClick={async () => { setReconnecting(true); try { await fetch('/api/reconnect', { method: 'POST' }); await getStatus(); } catch { setNotice('连接失败，请稍后重试。'); } finally { setReconnecting(false); } }}>{reconnecting ? '连接中…' : '重试连接'}</button>}</div>}
        <main className="journey-page journey-storyboard">
          <section className="preview-panel" aria-label="分镜预览">
            <div className="preview-heading"><h2>分镜预览</h2><button className="icon-button" type="button" title="放大预览" aria-label="放大预览" onClick={openZoom}><Maximize2 size={16} /></button></div>
            <div className="preview-stage"><DraftPreview referenceUrl={sceneReferenceUrl} scene={activeSceneData} product={product} /></div>
            <div className="preview-meta"><strong>选择要查看的分镜</strong><span>{clockLabel(Number.parseInt(duration, 10))} 总时长</span></div>
            <div className="timeline" role="group" aria-label="分镜时间线">{scenes.map((scene) => <button key={scene.id} className="timeline-clip journey-timeline-clip" type="button" aria-pressed={activeScene === scene.id} onClick={() => selectScene(scene.id)}><span>{scene.label}</span><small>{scene.time}</small></button>)}</div>
          </section>
        <aside className="sidebar-panel storyboard-panel">
          <div className="panel-heading storyboard-heading">
            <span className="section-icon" aria-hidden="true"><Clapperboard size={18} /></span><h2>编辑分镜</h2>
            <button className="text-button plan-button" type="button" onClick={() => regeneratePlan()} disabled={loading || uploadingDetail}>
              {loading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
              {loading ? '策划中' : '重新策划'}
            </button>
          </div>
          <div className="strategy-toolbar">
            <div className="segmented-control" role="group" aria-label="创意类型">
              {[['daily', '日常种草'], ['feature', '卖点展示'], ['offer', '活动转化']].map(([value, label]) => <button key={value} type="button" aria-pressed={strategy === value} disabled={loading} onClick={() => { if (strategy !== value) void regeneratePlan(duration, value); }}>{label}</button>)}
            </div>
          </div>
          <div className="plan-source"><Sparkles size={13} /><span>{planInfo.source === 'gpt' ? `${planInfo.model || 'GPT'} 策划` : '模板分镜'}</span>{planInfo.reason && <button className="text-button" type="button" title={planInfo.reason} aria-label="查看策划回退原因" onClick={() => setNotice(planInfo.reason)}><CircleAlert size={15} /></button>}</div>

          <div className="active-scene-editor">
            {actionCut && <label className="field-label">创意主线
              <textarea className="prompt-editor" rows={2} maxLength={90} value={storyboard.campaign.creative_concept || ''} onChange={(event) => { const value = event.target.value; setStoryboard((current) => ({ ...current, campaign: { ...current.campaign, creative_concept: value || undefined } })); }} />
            </label>}
            {actionCut && activeSceneData.kind === 'wan' && <label className="field-label">镜头素材
              <select value={sceneMode || 'reference'} disabled={uploadingDetail} onChange={(event) => {
                const reference_mode = event.target.value === 'scene' ? 'scene' : undefined;
                setStoryboard((current) => ({ ...current, shots: current.shots.map((shot) => shot.id === activeScene ? { ...shot, reference_mode, reference_asset_id: reference_mode ? undefined : shot.reference_asset_id } : shot) }));
              }}>
                <option value="reference">{usesProductReference ? '参考商品外观' : '用参考图起拍'}</option>
                {!requiresStartImage && <option value="scene">从场景描述生成</option>}
              </select>
            </label>}
            {actionCut && activeScene === 'detail' && !sceneMode && <>
              <label className="field-label">特写参考图<select value={detailRef || ''} disabled={uploadingDetail} onChange={(event) => updateShot('detail', 'reference_asset_id', event.target.value || undefined)}>
                <option value="">沿用商品参考图</option>
                {libraryAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.label}</option>)}
              </select></label>
              <button className="button button-secondary" type="button" disabled={uploadingDetail} onClick={() => detailFileInput.current?.click()}><ImagePlus size={16} />{uploadingDetail ? '正在上传…' : '上传特写图'}</button>
              <input ref={detailFileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { void uploadDetailReference(event.target.files?.[0]); event.target.value = ''; }} />
            </>}
            <label className="editor-header" htmlFor="copy-editor">{activeSceneData.label}画面文案</label>
            <textarea id="copy-editor" className="prompt-editor" rows={2} maxLength={90} value={activeSceneData?.text || ''} onChange={(event) => updateShot(activeScene, 'copy', event.target.value)} />
            {activeSceneData.kind === 'wan' ? (
              <><label className="editor-header" htmlFor="shot-editor">画面指令（英文）</label><textarea id="shot-editor" className="prompt-editor" rows={4} value={activeSceneData.detail} onChange={(event) => updatePrompt(activeScene, event.target.value)} /></>
            ) : null}
            <label className="editor-header" htmlFor="voiceover-editor">旁白与字幕</label>
            <textarea id="voiceover-editor" className="prompt-editor" rows={3} maxLength={120} value={activeSceneData?.voiceover || ''} onChange={(event) => updateShot(activeScene, 'voiceover', event.target.value)} placeholder="填写本镜头要朗读并显示的内容" />
            {activeSceneData && <VoicePreview key={activeScene} text={activeSceneData.voiceover ?? activeSceneData.text} duration={activeSceneTiming ? activeSceneTiming.end_seconds - activeSceneTiming.start_seconds : 0} voice={serverStatus?.narration?.voice} disabled={!serverStatus?.narration?.available} />}
          </div>

        </aside>
        </main>
      </>}

      {workspaceTab === 'result' && job && <ResultPage job={job} voiceVersion={voiceVersion} busy={busy} onNavigate={navigate} onSource={openSource} onExperiments={() => openLibrary('experiments')} />}
      {workspaceTab === 'revise' && job && <ShotEditPage key={job.id} job={job} voiceVersion={voiceVersion} servicesReady={modelReady && plannerReady} onSubmit={(next) => { openRun(next, runFrom); void getHistory(); }} />}
      {workspaceTab === 'compare-shot' && job?.userRevision && <ShotComparisonPage job={job} onSource={openSource} />}
      {workspaceTab === 'narration' && job && <NarrationPage job={job} voiceVersion={voiceVersion} status={serverStatus?.narration} onSaved={(next, version) => { updateActiveJob(next); setVoiceVersionId(version.id); navigate('result'); }} />}
      {workspaceTab === 'export' && job && <ExportPage key={job.id} job={job} voiceVersion={voiceVersion} onVoiceChange={setVoiceVersionId} onUpdate={updateActiveJob} />}
      {workspaceTab === 'process' && job && <ProcessWorkspace key={job.id} job={job} />}
      <BatchWorkspace active={workspaceTab === 'batch'} ready={serverStatus?.service?.status === 'ready'} plannerReady={plannerReady} onOpenRun={openRun} onAssetSaved={(asset) => setLibraryAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)])} />
      {workspaceTab === 'experiments' && <ExperimentWorkspace preferredKey={job?.experimentKey} onOpenRun={openRun} />}

      {activeSceneData && <dialog ref={zoomDialog} className="zoom-dialog" aria-labelledby="zoom-title" onClick={(event) => { if (event.target === event.currentTarget) zoomDialog.current?.close(); }}>
        <div className="zoom-content"><div className="zoom-heading"><strong id="zoom-title">{activeSceneData.label}</strong><button className="icon-button" type="button" aria-label="关闭放大预览" onClick={() => zoomDialog.current?.close()}><X size={20} /></button></div><div className="preview-stage zoom-stage"><DraftPreview referenceUrl={sceneReferenceUrl} scene={activeSceneData} product={product} /></div></div>
      </dialog>}

      <dialog ref={settingsDialog} className="settings-dialog" aria-labelledby="settings-title" onClick={(event) => { if (event.target === event.currentTarget) settingsDialog.current?.close(); }}>
        <div className="zoom-heading"><h2 id="settings-title">生成配置</h2><button className="icon-button" type="button" aria-label="关闭生成配置" onClick={() => settingsDialog.current?.close()}><X size={20} /></button></div>
        <div className="mode-toolbar">
          <div className="segmented-control" role="group" aria-label="模型生成策略">
            <button type="button" aria-pressed={generationMode === 'baseline'} onClick={() => setGenerationMode('baseline')}>单向基线</button>
            <button type="button" aria-pressed={generationMode === 'audit'} onClick={() => setGenerationMode('audit')}>双模型质检闭环</button>
            <button type="button" aria-pressed={generationMode === 'compare'} onClick={() => setGenerationMode('compare')}>A/B 对照</button>
          </div>
          <div className="mode-caption">{generationMode === 'baseline' ? '每镜头生成一次，无质检' : generationMode === 'compare' ? '共享分镜与素材，提交基线和闭环两条任务' : 'GPT 抽帧质检，每个问题镜头最多返工一次'}</div>
          <label className="narration-toggle"><input type="checkbox" checked={narrationEnabled} onChange={(event) => setNarrationEnabled(event.target.checked)} /><span><strong>中文旁白与字幕</strong><small>{serverStatus?.narration?.available ? 'Mac 本地 Qwen3-TTS；口播超长时保留字幕并提示' : '未安装本地语音模型时，仍可制作带字幕的无声视频'}</small></span></label>
          <label className="seed-field">实验 Seed<input type="number" min="1" max="2147483646" value={experimentSeed} onChange={(event) => setExperimentSeed(Math.trunc(Math.min(2147483646, Math.max(1, Number(event.target.value) || 1))))} /></label>
          <div className="model-detail" title={serverStatus?.planner?.message}>
            <span><StatusDot state={videoService?.status} />{videoModel} {modelReady ? '在线' : modelError ? '离线' : '连接中'}</span>
            <span><StatusDot state={serverStatus?.planner?.status} />{serverStatus?.planner?.model || 'GPT'} {plannerReady ? `在线 · ${serverStatus.planner.reasoningEffort}` : serverStatus ? '未就绪' : '连接中'}</span>
          </div>
        </div>
      </dialog>

      {workspaceTab === 'history' && <JobHistory historyJobs={historyJobs} historyState={historyState} activeJobId={job?.id} view={historyView} setView={setHistoryView} openRun={openRun} />}

      <footer className="bottom-bar"><span><StatusDot state={videoService?.status} />{videoService?.message || (modelReady ? '视频生成服务正常' : '正在连接视频生成服务')}</span><span>MarketFilm · AI 广告制作</span></footer>
    </div>
  );
}

export default function Root() {
  const blindToken = window.location.pathname.match(/^\/blind\/([a-f0-9]{48})\/?$/)?.[1];
  return blindToken ? <BlindReview token={blindToken} /> : <App />;
}
