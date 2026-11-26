import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { deliverableJobs } from '../src/batch-export.mjs';

const [api, batchId, archiveDir] = process.argv.slice(2);
assert.ok(api && batchId && archiveDir, 'Usage: node scripts/verify-batch-delivery.mjs <api> <completed-15s-batch-id> <folder-with-all-three-ZIPs>');
const run = promisify(execFileCallback);
const get = async (rel, type = 'json') => {
  const response = await fetch(new URL(rel, api), { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `${rel}: ${response.status}`);
  return type === 'json' ? response.json() : Buffer.from(await response.arrayBuffer());
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sum = (values) => values.reduce((total, value) => total + value, 0);
const tracks = async (file, args) => run(ffmpeg, ['-v', 'error', '-i', file, ...args, '-'], { encoding: 'buffer' }).then(({ stdout }) => stdout);
const formats = [['9:16', '9x16', '576x1024'], ['1:1', '1x1', '768x768'], ['16:9', '16x9', '1024x576']];
const { batches } = await get('/api/batches');
const batch = batches.find((b) => b.id === batchId);
assert.ok(batch && batch.jobs.length >= 2, 'The batch must contain at least two products');
const listed = deliverableJobs(batch);
assert.equal(listed.length, batch.jobs.length, 'Every item in the 15-second batch must be deliverable');
const jobs = await Promise.all(listed.map(async (item) => (await get(`/api/jobs/${item.id}`)).job));
const result = { batchId, jobs: [], archives: {} };
for (const job of jobs) {
  assert.equal(job.mode, 'audit');
  assert.equal(job.duration, 15);
  assert.equal(job.storyboard.shots.length, 4);
  assert.equal(job.selectedShots.length, 2);
  assert.ok(job.planSource && job.logs.some((entry) => entry.message.includes('分镜')));
  assert.ok(job.assetId && job.conditioning?.url);
  const [actualInput, asset] = await Promise.all([get(job.conditioning.url, 'bytes'), get(`/api/assets/${job.assetId}/image`, 'bytes')]);
  const dimensions = await sharp(actualInput).metadata();
  assert.equal(dimensions.width, job.profile.width);
  assert.equal(dimensions.height, job.profile.height);
  assert.ok((await sharp(asset).metadata()).width > 0);
  for (const selection of job.selectedShots) assert.ok(job.attempts.some((attempt) => attempt.number === selection.attemptNumber && attempt.videoUrl === selection.videoUrl));
  for (const attempt of job.attempts) {
    assert.equal(attempt.review?.status, 'completed');
    assert.ok(attempt.review.frames.length >= 5 && attempt.review.endingCheck);
    assert.ok((await get(attempt.videoUrl, 'bytes')).length > 0);
  }
  const voiceVersion = job.narrationVersions?.at(-1);
  const narration = voiceVersion || job.narration;
  assert.match(narration.provider, /Qwen3-TTS/);
  assert.equal(narration.cues.filter((cue) => cue.spoken).length, 4);
  assert.equal(narration.warnings.length, 0);
  result.jobs.push({
    id: job.id, name: job.product.name, seed: job.seed, assetId: job.assetId, actualReferenceSha256: sha(actualInput),
    planSource: job.planSource, elapsedMs: job.elapsedMs, queueMs: Date.parse(job.timings.startedAt) - Date.parse(job.timings.queuedAt),
    wanMs: sum(job.attempts.map((attempt) => attempt.generationMs)), reviewMs: sum(job.attempts.map((attempt) => attempt.reviewMs)),
    needsReview: job.needsReview, narration: { provider: narration.provider, cues: narration.cues },
    attempts: job.attempts.map(({ shotId, shotAttempt, videoUrl, review }) => ({ shotId, shotAttempt, videoUrl, approved: review.approved, endingState: review.endingCheck?.state })),
    selectedShots: job.selectedShots,
  });
}
const tmp = await mkdtemp(path.join(tmpdir(), 'marketfilm-batch-verify-'));
const originals = new Map();
try {
  for (const [format, ratio, size] of formats) {
    const archiveName = `MarketFilm-${batchId.slice(0, 8)}-${ratio}.zip`;
    const archive = await readFile(path.join(archiveDir, archiveName));
    const files = unzipSync(archive);
    assert.equal(Object.keys(files).length, jobs.length * 2, 'Exactly one MP4 and one VTT per product');
    result.archives[format] = { archiveName, bytes: archive.length, videos: [] };
    for (const [index, job] of jobs.entries()) {
      const prefix = `${String(index + 1).padStart(2, '0')}-`;
      const filename = Object.keys(files).find((name) => name.startsWith(prefix) && name.endsWith(`-${ratio}.mp4`));
      assert.ok(filename, `Missing archive video for ${job.product.name}`);
      const [video, captions] = [Buffer.from(files[filename]), Buffer.from(files[filename.replace(/\.mp4$/, '.vtt')])];
      const output = (job.narrationVersions?.at(-1)?.outputs || job.outputs)[format];
      const [sourceMp4, sourceVtt] = await Promise.all([get(output.videoUrl, 'bytes'), get(output.captionsUrl, 'bytes')]);
      assert.equal(sha(video), sha(sourceMp4), 'Archive included the selected real output');
      assert.equal(sha(captions), sha(sourceVtt));
      assert.equal(captions.toString().match(/ --> /g)?.length, 4);
      const file = path.join(tmp, `${index}-${ratio}.mp4`);
      await writeFile(file, video);
      const probe = await run(ffmpeg, ['-hide_banner', '-i', file, '-map', '0:v:0', '-progress', 'pipe:1', '-f', 'null', '-']);
      assert.match(probe.stderr, /Duration: 00:00:15\.00/);
      assert.ok(probe.stderr.includes(size), `Expected ${size}`);
      assert.equal([...probe.stdout.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1], '360');
      const [aac, vtt] = await Promise.all([tracks(file, ['-map', '0:a:0', '-c:a', 'copy', '-f', 'adts']), tracks(file, ['-map', '0:s:0', '-f', 'webvtt'])]);
      assert.ok(aac.length);
      assert.equal(vtt.toString().match(/ --> /g)?.length, 4);
      const evidence = { aac: sha(aac), subtitleTrack: sha(vtt), vtt: sha(captions) };
      if (format === '9:16') originals.set(job.id, evidence);
      else assert.deepEqual(evidence, originals.get(job.id), 'All formats must preserve the delivery audio and subtitles');
      result.archives[format].videos.push({ jobId: job.id, resolution: size, frames: 360, seconds: 15, ...evidence });
    }
  }
} finally { await rm(tmp, { recursive: true, force: true }); }
console.log(JSON.stringify(result, null, 2));
