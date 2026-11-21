import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';

const [api, jobId] = process.argv.slice(2);
if (!api || !jobId) throw new Error('Usage: node scripts/verify-delivery.mjs <api-base> <completed-15s-job-id>');
const execFile = promisify(execFileCallback);
const render = async (format) => {
  const response = await fetch(`${api}/api/jobs/${jobId}/recompose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format }), signal: AbortSignal.timeout(90_000) });
  const body = await response.json();
  assert.ok(response.ok, body.error);
  return body;
};
const { output: primary } = await render('9:16');
const base = `${api}${primary.videoUrl}`;
const decodeTrack = (file, args) => execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', file, ...args, '-'], { encoding: 'buffer' }).then(({ stdout }) => stdout);
const [audio, captions] = await Promise.all([decodeTrack(base, ['-map', '0:a:0', '-c:a', 'copy', '-f', 'adts']), decodeTrack(base, ['-map', '0:s:0', '-f', 'webvtt'])]);
assert.ok(audio.length > 0);
assert.match(captions.toString(), / --> /);
for (const [format, dimensions] of [['1:1', '768x768'], ['16:9', '1024x576']]) {
  const { job, output } = await render(format);
  assert.equal(job.videoUrl, primary.videoUrl, 'export must not replace the primary experiment video');
  assert.equal(job.selectedShots.length, 2);
  const file = `${api}${output.videoUrl}`;
  const { stderr } = await execFile(ffmpegPath, ['-hide_banner', '-i', file, '-f', 'null', '-']);
  assert.match(stderr, /Duration: 00:00:15\.00/);
  assert.ok(stderr.includes(dimensions));
  assert.deepEqual(await decodeTrack(file, ['-map', '0:a:0', '-c:a', 'copy', '-f', 'adts']), audio);
  assert.deepEqual(await decodeTrack(file, ['-map', '0:s:0', '-f', 'webvtt']), captions);
  assert.equal((await render(format)).reused, true);
  console.log(`${format}: ${dimensions}, 15 s, identical AAC and subtitle cues; cached version reusable.`);
}
