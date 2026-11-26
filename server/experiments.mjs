import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { reviewMetrics, receiptFormat, maxReviewGroups } from '../protocol/blind-review.mjs';
import { renderOfflineReview, renderOfflineReviewSet } from './offline-review.mjs';

const validToken = (value) => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
const scores = reviewMetrics.map(([key]) => key);
const average = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const isScore = (value) => Number.isInteger(value) && value >= 1 && value <= 5;

function usage(job) {
  const wanSeconds = (job.attempts || []).reduce((total, attempt) => total + (attempt.generationMs || 0), 0) / 1000;
  const retrySeconds = (job.attempts || []).reduce((total, attempt) => total + ((attempt.shotAttempt || attempt.number) > 1 ? (attempt.generationMs || 0) : 0), 0) / 1000;
  const retries = (job.attempts || []).filter((attempt) => (attempt.shotAttempt || attempt.number) > 1).length;
  const finishLogged = job.logs?.some((log) => log.stage === 'ffmpeg' && log.elapsedMs != null);
  const firstWan = job.logs?.find((log) => log.stage === 'wan')?.time;
  const clockStart = job.timings?.startedAt || firstWan;
  const reassembled = Boolean(job.recoveredComposition || (job.completedAt && clockStart && job.elapsedMs != null && Date.parse(job.completedAt) - Date.parse(clockStart) - job.elapsedMs > 60_000));
  const stageSeconds = (...stages) => (job.logs || []).reduce((total, log) => stages.includes(log.stage) ? total + (log.elapsedMs || 0) : total, 0) / 1000;
  const planningSeconds = (job.logs || []).filter((log) => log.stage === 'system' && ['GPT 广告分镜已生成', 'Qwen 广告分镜已生成', '已采用分镜模板'].includes(log.message)).reduce((seconds, log) => seconds + (log.elapsedMs || 0) / 1000, 0);
  const wallSeconds = finishLogged && job.elapsedMs != null && !reassembled ? job.elapsedMs / 1000 : null;
  return {
    wanSeconds, wanCalls: job.attempts?.filter((attempt) => attempt.videoUrl || attempt.error).length || 0, retries,
    wallSeconds, planningSeconds, afterPlanSeconds: wallSeconds == null ? null : Math.max(0, wallSeconds - planningSeconds),
    retrySeconds, rewriteSeconds: stageSeconds('gpt_revision'),
    plannerSeconds: stageSeconds('qwen', 'gpt_review', 'gpt_revision'), deliverySeconds: stageSeconds('narration', 'ffmpeg'),
    externalApiCost: job.plannerModel ? null : 0, needsReview: Boolean(job.needsReview),
  };
}

function firstRoundAttempts(job) {
  const shots = job.storyboard?.shots?.filter((shot) => shot.kind === 'wan') || [];
  return shots.map((shot) => job.attempts?.find((attempt) => attempt.shotId === shot.id && (attempt.shotAttempt ?? attempt.number) === 1 && attempt.videoUrl));
}

function firstRoundStatus(job) {
  const attempts = firstRoundAttempts(job);
  const selected = job.selectedShots || [];
  if (!attempts.length || !attempts.every(Boolean) || selected.length !== attempts.length) return 'unavailable';
  if (attempts.every((attempt) => selected.some((item) => item.shotId === attempt.shotId && item.videoUrl === attempt.videoUrl))) return 'unchanged';
  return job.firstRoundOutput ? 'ready' : 'available';
}

export function mountExperiments(app, { jobs, mediaRoot, evaluationsRoot, primaryOutput, renderFirstRound, renderOpening }) {
  const sessionPath = (token) => path.join(evaluationsRoot, `${token}.json`);
  const votePath = (token) => path.join(evaluationsRoot, `${token}.vote.json`);
  const read = async (file) => fs.readFile(file, 'utf8').then(JSON.parse).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const findSession = (token) => validToken(token) ? read(sessionPath(token)) : null;
  const comparisonOutput = (job) => job?.status === 'completed' && !job.compositionWarning && primaryOutput(job);
  function experimentPairs() {
    const grouped = new Map();
    const creativeGroups = new Map();
    const candidates = [...jobs.values()].filter((job) => job.experimentKey && ['audit', 'baseline'].includes(job.mode)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    for (const job of candidates) {
      if (job.creativeComparison) {
        const group = creativeGroups.get(job.pairedRunId) || {};
        group[job.creativeComparison.arm] = job;
        creativeGroups.set(job.pairedRunId, group);
        continue;
      }
      const groupKey = job.pairedRunId || job.experimentKey;
      const group = grouped.get(groupKey) || { baseline: [], audit: [] };
      group[job.mode].push(job);
      grouped.set(groupKey, group);
    }
    const pairs = [...grouped.values()].flatMap((group) => group.baseline.flatMap((baseline, index) => {
      const audit = group.audit[index];
      if (!comparisonOutput(baseline) || !comparisonOutput(audit) || baseline.experimentKey !== audit.experimentKey) return [];
      const key = crypto.createHash('sha256').update(`${baseline.id}:${audit.id}`).digest('hex');
      const qualityKey = crypto.createHash('sha256').update(`${key}:first-round-v1`).digest('hex');
      const firstRound = firstRoundStatus(audit);
      const output = { baseline: comparisonOutput(baseline), audit: comparisonOutput(audit) };
      const target = { key, inputKey: baseline.experimentKey, baseline, audit, output, firstRound, method: 'independent' };
      return [target, ...(firstRound === 'ready' ? [{ ...target, key: qualityKey, output: { ...output, baseline: audit.firstRoundOutput }, firstRound: undefined, method: 'shared-first-round' }] : [])];
    }));
    for (const { baseline, audit } of creativeGroups.values()) {
      const output = { baseline: comparisonOutput(baseline), audit: comparisonOutput(audit) };
      if (!output.baseline || !output.audit || baseline.experimentKey !== audit.experimentKey) continue;
      const key = crypto.createHash('sha256').update(`${baseline.id}:${audit.id}:creative-v1`).digest('hex');
      pairs.push({ key, inputKey: baseline.experimentKey, baseline, audit, output, method: 'creative' });
    }
    return pairs.sort((a, b) => b.audit.createdAt.localeCompare(a.audit.createdAt));
  }
  function publicSession(session, voted) {
    const job = jobs.get(session.order[0]);
    return { id: session.id, voted, creative: session.creative, product: { name: job.product.name, facts: job.storyboard.campaign.source_facts || [] }, referenceUrl: `/api/blind/${session.id}/reference`, clips: ['A', 'B'].map((slot) => ({ slot, url: `/api/blind/${session.id}/clip/${slot}`, opening: session.creative ? `/api/blind/${session.id}/opening/${slot}` : undefined })) };
  }

  app.get('/api/experiments', async (_request, response) => {
    const votes = await Promise.all((await fs.readdir(evaluationsRoot)).filter((file) => /^[a-f0-9]{48}\.vote\.json$/.test(file)).map(async (file) => {
      const id = file.slice(0, 48);
      const [vote, grading] = await Promise.all([read(votePath(id)), read(path.join(evaluationsRoot, `${id}.recall.json`))]);
      return vote && { ...vote, id, grading };
    }));
    const pairs = experimentPairs().map(({ key, inputKey, baseline, audit, method, firstRound, output }) => {
      const paired = votes.filter((vote) => vote?.key === key && vote.jobIds.baseline === baseline.id && vote.jobIds.audit === audit.id);
      const stats = (mode) => {
        const job = mode === 'baseline' ? baseline : audit;
        const graded = paired.filter((vote) => vote.grading);
        const creative = method === 'creative' ? {
          continueCount: paired.filter((vote) => vote.creative?.[mode].continueWatching === 'yes').length,
          recallCorrect: graded.filter((vote) => vote.grading[vote.order.indexOf(mode)] === 'correct').length,
          recallGraded: graded.length,
          proposalSeconds: job.creativeComparison.proposalMs == null ? null : job.creativeComparison.proposalMs / 1000,
          storyboardSeconds: job.creativeComparison.storyboardMs == null ? (mode === 'baseline' ? usage(job).planningSeconds : null) : job.creativeComparison.storyboardMs / 1000,
        } : {};
        return { ...(method !== 'shared-first-round' ? usage(job) : {}), ...creative, means: Object.fromEntries(scores.map((metric) => [metric, average(paired.map((vote) => vote.scores[mode][metric]))])) };
      };
      return {
        key, inputKey, method, firstRound, name: baseline.product.name, seed: baseline.seed, duration: baseline.duration, createdAt: audit.createdAt, votes: paired.length,
        revisionPolicy: audit.revisionPolicy || null, pairedSubmission: Boolean(baseline.pairedRunId && baseline.pairedRunId === audit.pairedRunId),
        baseline: { ...stats('baseline'), jobId: method === 'shared-first-round' ? null : baseline.id, output: output.baseline },
        audit: { ...stats('audit'), jobId: audit.id, output: output.audit },
        winners: { baseline: paired.filter((vote) => vote.preference === 'baseline').length, audit: paired.filter((vote) => vote.preference === 'audit').length, tie: paired.filter((vote) => vote.preference === 'tie').length },
        ...(method === 'creative' && {
          proposal: audit.creativeComparison.proposal,
          facts: audit.storyboard.campaign.source_facts,
          recallResponses: paired.map((vote) => ({
            id: vote.id,
            order: vote.order,
            continueWatching: vote.order.map((arm) => vote.creative[arm].continueWatching),
            answers: vote.order.map((arm) => vote.creative[arm].recall),
            grading: vote.grading,
          })),
        }),
      };
    });
    response.json({ pairs });
  });

  app.post('/api/experiments/:key/first-round', async (request, response) => {
    const pair = experimentPairs().find((entry) => entry.key === request.params.key && entry.method === 'independent');
    if (!pair || !renderFirstRound) return response.status(404).json({ error: '未找到可制作首轮基线的对照组。' });
    if (pair.firstRound === 'unchanged') return response.status(409).json({ error: '闭环成片已全部采用首轮镜头，无需重复发起同源盲评。' });
    if (pair.firstRound === 'unavailable') return response.status(409).json({ error: '首轮原片不完整，无法制作同源基线。' });
    try {
      if (pair.firstRound !== 'ready' && !(await renderFirstRound(pair.audit, firstRoundAttempts(pair.audit)))) return response.status(409).json({ error: '已有合成任务正在运行，请稍后重试。' });
      const controlled = experimentPairs().find((entry) => entry.baseline.id === pair.baseline.id && entry.audit.id === pair.audit.id && entry.method === 'shared-first-round');
      if (!controlled) throw new Error('未找到同源对照输出。');
      return response.status(pair.firstRound === 'ready' ? 200 : 201).json({ key: controlled.key });
    } catch (error) {
      console.error('首轮基线合成失败：', error.message);
      return response.status(500).json({ error: '首轮基线合成失败，请检查原片后重试。' });
    }
  });

  async function newSession(pair, channel) {
    const id = crypto.randomBytes(24).toString('hex');
    const order = [pair.baseline.id, pair.audit.id];
    if (crypto.randomInt(2)) order.reverse();
    const videos = order.map((jobId) => path.basename(pair.output[jobId === pair.baseline.id ? 'baseline' : 'audit'].videoUrl));
    const creative = pair.method === 'creative';
    const openings = creative ? await Promise.all(videos.map(renderOpening)) : undefined;
    return { id, key: pair.key, order, videos, creative, openings, createdAt: new Date().toISOString(), channel };
  }
  const storeSession = (session) => fs.writeFile(sessionPath(session.id), JSON.stringify(session), { flag: 'wx' });
  async function offlineMedia(sessions) {
    const filesBySession = sessions.map((session) => [...session.videos, ...(session.openings || [])].map((file) => path.join(mediaRoot, file)));
    const files = filesBySession.flat();
    const sizes = await Promise.all(files.map((file) => fs.stat(file).then((stat) => stat.size)));
    if (sizes.reduce((sum, size) => sum + size, 0) > 48 * 1024 * 1024) return null;
    return Promise.all(sessions.map(async (session, i) => {
      const original = jobs.get(session.order[0]);
      const [image, ...videos] = await Promise.all([sharp(original.referencePath).resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer(), ...filesBySession[i].map((file) => fs.readFile(file))]);
      const media = videos.map((video) => `data:video/mp4;base64,${video.toString('base64')}`);
      return { id: session.id, product: publicSession(session, false).product, reference: `data:image/jpeg;base64,${image.toString('base64')}`, clips: media.slice(0, 2), openings: session.creative ? media.slice(2) : undefined };
    }));
  }
  async function downloadOffline(response, sessions) {
    let html;
    try {
      const prepared = await offlineMedia(sessions);
      if (!prepared) return response.status(413).json({ error: '成片总大小超过离线包的 48 MB 上限，请减少对照组或使用在线盲评。' });
      html = prepared.length === 1 ? renderOfflineReview(prepared[0]) : renderOfflineReviewSet(prepared);
    } catch (error) {
      console.error('生成离线盲评包失败：', error.message);
      return response.status(409).json({ error: '参考图或至少一条成片无法读取。请先检查样片是否可播放。' });
    }
    await Promise.all(sessions.map(storeSession));
    return response.set('Cache-Control', 'no-store').status(201).attachment(`MarketFilm-Review-${sessions[0].id.slice(0, 8)}.html`).send(html);
  }
  app.post('/api/experiments/:key/blind', async (request, response) => {
    const pair = experimentPairs().find((entry) => entry.key === request.params.key);
    if (!pair) return response.status(404).json({ error: '没有可播放的匹配成片。' });
    const format = request.body?.format ?? 'online';
    if (!['online', 'offline'].includes(format)) return response.status(400).json({ error: '未知的盲评方式。' });
    const session = await newSession(pair, format);
    if (format === 'offline') return downloadOffline(response, [session]);
    await storeSession(session);
    return response.set('Cache-Control', 'no-store').status(201).json(publicSession(session, false));
  });
  app.post('/api/experiments/offline-bundle', async (request, response) => {
    const { keys } = request.body || {};
    if (!Array.isArray(keys) || keys.length < 2 || keys.length > maxReviewGroups || keys.some((key) => typeof key !== 'string') || new Set(keys).size !== keys.length) return response.status(400).json({ error: '请选择 2–4 个不同的对照组。' });
    const all = experimentPairs();
    const selected = keys.map((key) => all.find((pair) => pair.key === key));
    if (selected.some((pair) => !pair)) return response.status(404).json({ error: '至少一个对照组已经不可用，请重新选择。' });
    if (selected.some((pair) => pair.method !== selected[0].method)) return response.status(400).json({ error: '同源画质与独立运行请分别打包。' });
    // Randomize the product sequence as well as the A/B order within each group.
    for (let i = selected.length - 1; i > 0; i--) {
      const j = crypto.randomInt(i + 1);
      [selected[i], selected[j]] = [selected[j], selected[i]];
    }
    return downloadOffline(response, await Promise.all(selected.map((pair) => newSession(pair, 'offline'))));
  });

  app.get('/blind/:id', async (request, response, next) => {
    const session = await findSession(request.params.id);
    if (!session?.creative || session.channel !== 'online') return next();
    if (await read(votePath(session.id))) return response.type('html').send('<meta charset="utf-8"><h1>评分已记录</h1>');
    const { product, referenceUrl, clips } = publicSession(session, false);
    return response.set('Cache-Control', 'no-store').type('html').send(renderOfflineReview({
      id: session.id, product, reference: referenceUrl, clips: clips.map(({ url }) => url),
      openings: clips.map(({ opening }) => opening), submitUrl: `/api/blind/${session.id}/vote`,
    }));
  });

  app.get('/api/blind/:id', async (request, response) => {
    const session = await findSession(request.params.id);
    if (!session || !jobs.has(session.order[0])) return response.status(404).json({ error: '盲评链接不存在。' });
    response.set('Cache-Control', 'no-store').json(publicSession(session, Boolean(await read(votePath(session.id)))));
  });

  app.get('/api/blind/:id/clip/:slot', async (request, response) => {
    const index = ['A', 'B'].indexOf(request.params.slot);
    const session = await findSession(request.params.id);
    if (!session || index < 0) return response.status(404).end();
    return response.sendFile(path.join(mediaRoot, session.videos[index]));
  });

  app.get('/api/blind/:id/opening/:slot', async (request, response) => {
    const session = await findSession(request.params.id);
    const file = session?.openings?.[['A', 'B'].indexOf(request.params.slot)];
    if (!file) return response.status(404).end();
    return response.sendFile(path.join(mediaRoot, file));
  });

  app.get('/api/blind/:id/reference', async (request, response) => {
    const session = await findSession(request.params.id);
    const job = session && jobs.get(session.order[0]);
    if (!job?.referencePath) return response.status(404).end();
    return response.sendFile(job.referencePath);
  });

  async function submitVote(session, body, source, response) {
    if (!session || !session.order.every((id) => jobs.has(id))) return response.status(404).json({ error: '找不到这个盲评任务。请在发出盲评的工作台导入。' });
    if ((session.channel || 'online') !== source) return response.status(400).json({ error: '该盲评任务的提交方式不匹配。' });
    const { ratings, preference, note = '', creative } = body || {};
    if (!['A', 'B', 'tie'].includes(preference) || typeof note !== 'string' || note.length > 1000 || !['A', 'B'].every((slot) => scores.every((metric) => isScore(ratings?.[slot]?.[metric])))) return response.status(400).json({ error: '请填写两段视频的全部 1–5 分评分和偏好。' });
    if (session.creative && !['A', 'B'].every((slot) => ['yes', 'no'].includes(creative?.[slot]?.continueWatching) &&
      typeof creative[slot].recall === 'string' && creative[slot].recall.trim() && creative[slot].recall.length <= 300)) {
      return response.status(400).json({ error: '请分别填写两条视频的续看意愿和卖点复述。' });
    }
    const jobIds = {}, mappedScores = {}, mappedCreative = {};
    const order = session.order.map((id) => jobs.get(id));
    const arms = order.map((job) => session.creative ? job.creativeComparison.arm : job.mode);
    for (const [index, job] of order.entries()) {
      const arm = arms[index];
      const slot = ['A', 'B'][index];
      jobIds[arm] = job.id;
      mappedScores[arm] = Object.fromEntries(scores.map((metric) => [metric, ratings[slot][metric]]));
      if (session.creative) mappedCreative[arm] = { continueWatching: creative[slot].continueWatching, recall: creative[slot].recall.trim() };
    }
    const vote = { key: session.key, jobIds, scores: mappedScores, preference: preference === 'tie' ? 'tie' : arms[preference === 'A' ? 0 : 1], note: note.trim(), source, submittedAt: new Date().toISOString(), ...(session.creative && { creative: mappedCreative, order: arms }) };
    const temp = path.join(evaluationsRoot, `.vote-${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temp, JSON.stringify(vote), { flag: 'wx' });
      await fs.link(temp, votePath(session.id));
    } catch (error) {
      if (error.code === 'EEXIST') return response.status(409).json({ error: '这份盲评已经记录。' });
      throw error;
    } finally {
      await fs.rm(temp, { force: true });
    }
    return response.status(201).json({ saved: true });
  }

  app.post('/api/blind/:id/vote', async (request, response) => submitVote(await findSession(request.params.id), request.body, 'online', response));
  app.post('/api/experiments/recall/:id', async (request, response) => {
    const { id } = request.params;
    if (!validToken(id) || !(await read(votePath(id)))?.creative) return response.status(404).json({ error: '未找到创意盲评记录。' });
    const { grading } = request.body || {};
    if (!Array.isArray(grading) || grading.length !== 2 || !grading.every((score) => ['correct', 'incorrect'].includes(score))) return response.status(400).json({ error: '请判定两条复述是否准确。' });
    const file = path.join(evaluationsRoot, `${id}.recall.json`);
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(grading), { flag: 'wx' });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
    return response.json({ saved: true });
  });
  app.post('/api/experiments/votes/import', async (request, response) => {
    const receipt = request.body;
    if (receipt?.format !== receiptFormat || !validToken(receipt.token)) return response.status(400).json({ error: '请选择离线盲评下载的评分 JSON。' });
    return submitVote(await findSession(receipt.token), receipt, 'offline', response);
  });
}
