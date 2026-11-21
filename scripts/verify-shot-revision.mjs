import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const [api, id] = process.argv.slice(2);
if (!api || !id) throw new Error('Usage: node scripts/verify-shot-revision.mjs <api-base> <completed-voiced-shot-revision-id>');
const execFile = promisify(execFileCallback);
const load = async (jobId) => {
  const response = await fetch(`${api}/api/jobs/${jobId}`);
  assert.equal(response.status, 200);
  return (await response.json()).job;
};
const job = await load(id);
assert.equal(job.status, 'completed');
const revision = job.userRevision;
assert.ok(revision.revisedPrompt && revision.originalPrompt !== revision.revisedPrompt);
assert.ok(!job.experimentKey, 'human-edited revisions must stay outside the A/B cohort');
const source = await load(revision.sourceJobId);
assert.equal(source.duration, job.duration);
assert.notEqual(source.videoUrl, job.videoUrl);
assert.equal(job.attempts.filter((attempt) => !attempt.reused && attempt.videoUrl).length, 1);
for (const shot of source.selectedShots) {
  const newer = job.selectedShots.find((item) => item.shotId === shot.shotId);
  if (shot.shotId === revision.shotId) {
    assert.equal(shot.videoUrl, revision.originalClipUrl);
    assert.notEqual(newer.videoUrl, shot.videoUrl);
  } else assert.equal(newer.videoUrl, shot.videoUrl);
}
assert.equal(job.storyboard.shots.find((shot) => shot.id === revision.shotId).visual_prompt, revision.revisedPrompt);
assert.equal(job.captionsUrl, revision.sourceOutput.captionsUrl);
const track = async (url, ...args) => (await execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', `${api}${url}`, ...args, '-'], { encoding: 'buffer' })).stdout;
for (const args of [['-map', '0:a:0', '-c:a', 'copy', '-f', 'adts'], ['-map', '0:s:0', '-f', 'webvtt']]) {
  const [before, after] = await Promise.all([track(revision.sourceOutput.videoUrl, ...args), track(job.videoUrl, ...args)]);
  assert.ok(before.length > 0);
  assert.deepEqual(after, before);
}
console.log(`${job.duration} s version: one new Wan clip; other clips, AAC and subtitle track preserved; original and revision remain separate.`);
