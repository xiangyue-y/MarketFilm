import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';

const [base = 'http://127.0.0.1:4188', jobId = 'b700de96-1ee1-413f-8b3a-ec62a9d91549'] = process.argv.slice(2);
const call = async (route, payload, expected = 200) => {
  const response = await fetch(`${base}${route}`, payload === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(240_000),
  });
  const data = await response.json();
  assert.equal(response.status, expected, data.error || route);
  return data;
};
const audioTime = performance.now();
const before = await call('/api/status');
assert.equal(before.narration.available, true, 'MLX model must be fully installed');
await call('/api/narration/preview', { text: '　', voice: 'serena', duration: 2 }, 400);
const trial = await call('/api/narration/preview', { text: '把温暖带在身边。', voice: 'serena', duration: 2 });
assert.ok(trial.audio.startsWith('data:audio/wav;base64,'));
assert.equal(trial.fits, true, 'short sample line should fit its two-second slot');
assert.ok(trial.naturalSeconds > 0.45 && trial.naturalSeconds < 3);
const coldSeconds = ((performance.now() - audioTime) / 1000).toFixed(2);
const second = await call('/api/narration/preview', { text: '把温暖带在身边。', voice: 'vivian', duration: 2 });
assert.notEqual(second.audio, trial.audio, 'distinct voice presets should not return the same waveform');
const after = await call('/api/status');
assert.equal(after.narration.ready, true);

const route = `/api/jobs/${jobId}`;
const { job: original } = await call(route);
const beforePairs = await call('/api/experiments');
const lines = { hook: '把温暖带在身边。', hero: '北屿随行杯，磨砂质感，轻松随行。', detail: '换个角度，看看杯身细节。', cta: '轻松出发。' };
const { job, version } = await call(`${route}/narration`, { voice: 'serena', lines }, 201);
assert.equal(job.videoUrl, original.videoUrl);
assert.equal(job.experimentKey, original.experimentKey);
assert.equal(version.cues.length, 4);
assert.equal(version.cues.filter((cue) => cue.spoken).length, 4, version.warnings.join(' '));
assert.deepEqual((await call('/api/experiments')).pairs, beforePairs.pairs, 'redubbing must not change any experimental results or media');
const inspect = async (name, ...args) => promisify(execFile)(ffmpeg, ['-hide_banner', '-i', `${base}${name}`, ...args], { timeout: 30_000 });
const hash = async (name, kind) => (await inspect(name, '-map', `0:${kind}:0`, '-c', 'copy', '-f', 'hash', '-')).stdout;
const source = original.outputs?.['9:16']?.videoUrl || original.videoUrl;
const result = version.outputs['9:16'].videoUrl;
assert.equal(await hash(source, 'v'), await hash(result, 'v'));
assert.notEqual(await hash(source, 'a'), await hash(result, 'a'));
for (const [format, resolution] of Object.entries({ '9:16': '576x1024', '1:1': '768x768', '16:9': '1024x576' })) {
  const { output } = await call(`${route}/recompose`, { format, voiceVersionId: version.id });
  const stats = await inspect(output.videoUrl, '-f', 'null', '-');
  assert.match(stats.stderr, /Duration: 00:00:15\.00/);
  assert.ok(stats.stderr.includes(resolution));
  assert.match(stats.stderr, /Audio: aac/);
  assert.match(stats.stderr, /Subtitle: mov_text/);
  assert.equal(await hash(output.videoUrl, 'a'), await hash(result, 'a'));
  assert.equal(output.captionsUrl, version.outputs['9:16'].captionsUrl);
}
console.log(JSON.stringify({ coldSeconds, version }, null, 2));
