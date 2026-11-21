import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { detectPersistentMatte } from '../server/matte-framing.mjs';

const [api, ...ids] = process.argv.slice(2);
assert.ok(api && ids.length, 'Usage: node scripts/verify-matte-delivery.mjs <api> <completed legacy padded job ID> […]');
const run = promisify(execFile);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const read = async (route, options) => {
  const response = await fetch(new URL(route, api), { ...options, signal: AbortSignal.timeout(40_000) });
  assert.ok(response.ok, `${route}: ${response.status}`);
  return response;
};
const info = async (route, tracks) => {
  const { stdout } = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', new URL(route, api).href, ...tracks, '-'], { encoding: 'buffer' });
  return hash(stdout);
};
const specimen = { width: 192, height: 256, frames: 3 };
const alignment = { ...specimen, left: 0, right: 0, top: 32, bottom: 32, contentWidth: 192, contentHeight: 192 };
const [w, h] = [specimen.width / 4, specimen.height / 4];
const solid = Buffer.alloc(w * h * 3 * specimen.frames, 164);
assert.equal(detectPersistentMatte(solid, alignment, specimen).top, 24);
const entering = Buffer.from(solid);
entering.fill(20, ((w*h) + w + 8)*3, ((w*h) + w + 14)*3); // one frame intrudes into the original top matte
assert.equal(detectPersistentMatte(entering, alignment, specimen).top, 0);
assert.equal(detectPersistentMatte(entering, alignment, specimen).bottom, 24);
assert.equal(detectPersistentMatte(solid.subarray(0, solid.length - 1), alignment, specimen), null);

const results = [];
for (const id of ids) {
  const { job: original } = await read(`/api/jobs/${id}`).then((r) => r.json());
  const canonical = original.outputs['9:16'];
  const sha256 = async (route) => hash(Buffer.from(await read(route).then((r) => r.arrayBuffer())));
  const audio = ['-map', '0:a:0', '-c:a', 'copy', '-f', 'adts'];
  const subtitle = ['-map', '0:s:0', '-f', 'webvtt'];
  const [originalHash, audioHash, subtitleHash, vttHash] = await Promise.all([sha256(canonical.videoUrl), info(canonical.videoUrl, audio), info(canonical.videoUrl, subtitle), sha256(canonical.captionsUrl)]);
  const item = { id, name: original.product.name, canonicalPreserved: false, outputs: {} };
  for (const [format, size] of [['9:16', '576x1024'], ['1:1', '768x768'], ['16:9', '1024x576']]) {
    const recompose = () => read(`/api/jobs/${id}/recompose`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ format, style: 'soft-matte' }) }).then((r) => r.json());
    const { job, output } = await recompose();
    assert.equal(job.videoUrl, canonical.videoUrl);
    assert.deepEqual(job.attempts, original.attempts);
    assert.deepEqual(job.logs, original.logs);
    assert.notEqual(output.videoUrl, canonical.videoUrl);
    assert.equal(output.format, format);
    assert.equal(output.framing.length, original.selectedShots.length);
    assert.ok(output.framing.every(({ crop }) => crop?.verifiedFrames === original.profile.frames));
    const file = new URL(output.videoUrl, api).href;
    const [[a, s, vtt], { stdout, stderr }] = await Promise.all([
      Promise.all([info(output.videoUrl, audio), info(output.videoUrl, subtitle), sha256(output.captionsUrl)]),
      run(ffmpeg, ['-hide_banner', '-i', file, '-map', '0:v:0', '-progress', 'pipe:1', '-f', 'null', '-']),
    ]);
    assert.deepEqual([a, s, vtt], [audioHash, subtitleHash, vttHash]);
    assert.ok(stderr.includes(size));
    assert.equal([...stdout.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1], String(original.duration * 24));
    assert.equal((await recompose()).reused, true);
    item.outputs[format] = { videoUrl: output.videoUrl, size, framing: output.framing, frames: original.duration * 24, renderMs: output.renderMs, framingMs: output.framingMs, identicalTracks: true };
  }
  assert.equal(await sha256(canonical.videoUrl), originalHash);
  item.canonicalPreserved = true;
  results.push(item);
}
console.log(JSON.stringify({ usesExistingWanTakes: true, fallbackIntrusionPreserved: true, results }, null, 2));
