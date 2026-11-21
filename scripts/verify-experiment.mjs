import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { chooseReviewedAttempt, revisionPolicy } from '../server/shot-selection.mjs';

const [api, baselineId, auditId] = process.argv.slice(2);
if (!api || !baselineId || !auditId) throw new Error('用法：node scripts/verify-experiment.mjs <API 地址> <基线 ID> <闭环 ID>');
const execFile = promisify(execFileCallback);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fetchResource = async (route) => {
  assert.ok(route?.startsWith('/') && !route.startsWith('//'), '预期本地资源路径');
  const response = await fetch(new URL(route, api), { signal: AbortSignal.timeout(15_000) });
  assert.ok(response.ok, `${route}: HTTP ${response.status}`);
  return response;
};
const getJob = (id) => fetchResource(`/api/jobs/${encodeURIComponent(id)}`).then((response) => response.json()).then(({ job }) => job);
const media = async (route, args) => {
  assert.match(route, /^\/media\/[\w.-]+\.mp4$/);
  return execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', new URL(route, api).href, ...args, '-'], { timeout: 90_000, encoding: 'buffer' }).then(({ stdout }) => stdout);
};
const frames = async (route) => {
  const manifest = (await media(route, ['-map', '0:v:0', '-f', 'framehash'])).toString().trim().split('\n');
  const rows = manifest.filter((line) => line && !line.startsWith('#'));
  assert.ok(rows.length > 0, '缺少可解码视频帧');
  return { count: rows.length, timeBase: manifest.find((line) => line.startsWith('#tb '))?.split(': ').at(-1), dimensions: manifest.find((line) => line.startsWith('#dimensions '))?.split(': ').at(-1), hash: sha256(rows.join('\n')) };
};
const track = (route, ...args) => media(route, args).then((bytes) => {
  assert.ok(bytes.length > 0, '输出轨道为空');
  return sha256(bytes);
});
const [baseline, audit, { pairs }] = await Promise.all([getJob(baselineId), getJob(auditId), fetchResource('/api/experiments').then((response) => response.json())]);
assert.equal(baseline.mode, 'baseline');
assert.equal(audit.mode, 'audit');
assert.ok(baseline.experimentKey);
for (const field of ['experimentKey', 'pairedRunId', 'product', 'storyboard', 'assetId', 'seed', 'profile', 'narrationEnabled', 'narrationEngine', 'narrationVoice', 'referencePolicy', 'revisionPolicy', 'renderPolicy']) {
  assert.deepEqual(audit[field], baseline[field], `两组字段不同：${field}`);
}
const pair = pairs.find((item) => item.baseline.jobId === baseline.id && item.audit.jobId === audit.id);
assert.ok(pair, '对照页没有找到这两条成片的配对');
assert.equal(pair.duration, 15);
const shotIds = baseline.storyboard.shots.filter((shot) => shot.kind === 'wan').map((shot) => shot.id);
assert.equal(shotIds.length, 2);
const outputs = [baseline, audit].map((job) => {
  assert.equal(job.status, 'completed');
  assert.equal(job.stage, 'ready');
  assert.equal(job.duration, 15);
  assert.ok(!job.compositionWarning);
  assert.deepEqual(job.selectedShots.map(({ shotId }) => shotId), shotIds);
  const output = job.outputs['9:16'];
  assert.ok(output.videoUrl && output.captionsUrl);
  assert.deepEqual([output.width, output.height], [576, 1024]);
  return output;
});
assert.equal(Boolean(baseline.conditioning), Boolean(audit.conditioning));
let conditioningMatched = null;
if (baseline.referencePolicy) {
  assert.ok(baseline.conditioning?.url && audit.conditioning?.url);
  const conditions = [baseline, audit].map((job) => job.conditioning.url);
  const [a, b] = await Promise.all(conditions.map((route) => fetchResource(route).then((response) => response.arrayBuffer()).then((value) => sha256(Buffer.from(value)))));
  assert.equal(a, b, 'Wan 实际输入图片不同');
  conditioningMatched = true;
}
const clips = [];
for (const shotId of shotIds) {
  const [direct, ...extra] = baseline.attempts.filter((item) => item.shotId === shotId);
  const attempts = audit.attempts.filter((item) => item.shotId === shotId);
  const [first, retry] = attempts;
  assert.equal(extra.length, 0);
  assert.equal(attempts.length <= 2, true);
  assert.equal(first.seed, direct.seed);
  assert.equal(first.prompt, direct.prompt);
  assert.equal(direct.review, undefined, '基线不应执行质检');
  assert.equal(baseline.selectedShots.find((s) => s.shotId === shotId)?.videoUrl, direct.videoUrl);
  const pick = audit.selectedShots.find((s) => s.shotId === shotId);
  const chosen = attempts.find((a) => a.number === pick.attemptNumber);
  assert.equal(chosen?.videoUrl, pick.videoUrl);
  if (audit.revisionPolicy === revisionPolicy) {
    for (const attempt of attempts.filter((item) => item.videoUrl)) {
      const review = attempt.review;
      assert.equal(review?.status, 'completed', `缺少 ${shotId} 第 ${attempt.shotAttempt} 轮质检结果`);
      assert.ok(review.endingCheck?.observation, '缺少结尾抽帧观察');
      assert.equal(review.endingCheck.time, review.frames.at(-1)?.time);
      assert.ok(review.issues.every((issue) => review.frames.some((frame) => frame.time === issue.time_seconds)), '存在无法定位到抽帧的问题');
    }
    if (retry) assert.equal(first.review.retrySupported, true, '未记录自动返工依据');
    else assert.equal(chosen, first);
  }
  if (retry) {
    assert.equal(retry.seed, direct.seed);
    assert.notEqual(retry.prompt, first.prompt, '返工指令没有改变');
    assert.equal(first.review?.approved, false);
    if (retry.videoUrl && audit.revisionPolicy === revisionPolicy) {
      const replay = chooseReviewedAttempt(first, retry);
      assert.equal(pick.attemptNumber, replay.attempt.number, '成片采用结果与政策回放不一致');
      assert.equal(pick.decision, replay.reason);
    }
  }
  const [baseFrames, firstFrames] = await Promise.all([direct.videoUrl, first.videoUrl].map(frames));
  assert.equal(baseFrames.count, baseline.profile.frames);
  assert.equal(firstFrames.count, baseline.profile.frames);
  clips.push({
    shotId, seed: direct.seed, identicalFirstAttempt: baseFrames.hash === firstFrames.hash, chosenRound: chosen.shotAttempt, decision: pick.decision || null,
    attempts: attempts.map(({ shotAttempt, error, review, reviewMs }) => ({
      round: shotAttempt, error: error || null, review: review?.status || null, approved: review?.approved ?? null,
      scores: review?.status === 'completed' ? [review.productIdentityScore, review.promptMatchScore, review.motionClarityScore, review.artifactScore] : null,
      ...(review?.endingCheck && { ending: review.endingCheck, supportedRetry: review.retrySupported, unsupportedScores: review.unsupportedScoreFields, reviewMs }),
    })),
  });
}
const final = await Promise.all(outputs.map(async ({ videoUrl, captionsUrl }) => {
  const video = await frames(videoUrl);
  assert.deepEqual([video.count, video.timeBase, video.dimensions], [360, '1/24', '576x1024']);
  const [audio, subtitle, vtt] = await Promise.all([
    track(videoUrl, '-map', '0:a:0', '-c:a', 'copy', '-f', 'adts'),
    track(videoUrl, '-map', '0:s:0', '-f', 'webvtt'),
    fetchResource(captionsUrl).then((response) => response.text()),
  ]);
  assert.match(vtt, /^WEBVTT\r?\n[\s\S]+-->/);
  return { video: video.hash, audio, subtitle, vtt: sha256(vtt) };
}));
const compare = (field) => final[0][field] === final[1][field];
const [b, a] = [pair.baseline, pair.audit];
console.log(JSON.stringify({
  pair: pair.key, seed: pair.seed, baselineId, auditId, revisionPolicy: audit.revisionPolicy || null, referencePolicy: audit.referencePolicy || null,
  conditioningMatched, clips, final: { sameVideo: compare('video'), sameAudio: compare('audio'), sameSubtitle: compare('subtitle') && compare('vtt') },
  officialVotes: pair.votes, baseline: { wanCalls: b.wanCalls, wanSeconds: b.wanSeconds, wallSeconds: b.wallSeconds }, audit: { wanCalls: a.wanCalls, wanSeconds: a.wanSeconds, wallSeconds: a.wallSeconds, qwenSeconds: a.qwenSeconds, needsReview: a.needsReview },
  delta: { wanCalls: a.wanCalls - b.wanCalls, wanSeconds: +(a.wanSeconds - b.wanSeconds).toFixed(3), wallSeconds: a.wallSeconds == null || b.wallSeconds == null ? null : +(a.wallSeconds - b.wallSeconds).toFixed(3) },
}, null, 2));
