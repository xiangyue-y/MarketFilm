import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { maxReviewGroups } from '../protocol/blind-review.mjs';

const [api, destination, ...keys] = process.argv.slice(2);
assert.ok(api && destination && keys.length >= 2 && keys.length <= maxReviewGroups && new Set(keys).size === keys.length,
  'Usage: node scripts/package-review-bundles.mjs <api> <new-output-dir> <2–4 distinct experiment keys>');
const get = (route, options) => fetch(new URL(route, api), { ...options, signal: AbortSignal.timeout(45_000) });
const { pairs } = await get('/api/experiments').then((res) => res.json());
const chosen = keys.map((key) => pairs.find((pair) => pair.key === key));
assert.ok(chosen.every((pair) => pair?.method === chosen[0]?.method && pair?.baseline.output && pair?.audit.output));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const videosByPair = await Promise.all(chosen.map((pair) => Promise.all(['baseline', 'audit'].map(async (mode) => {
  const response = await get(pair[mode].output.videoUrl);
  assert.ok(response.ok);
  return hash(Buffer.from(await response.arrayBuffer()));
}))));
const expected = videosByPair.flat().sort();
assert.equal(new Set(expected).size, expected.length, 'Confirm each assigned video is different');
const readme = `# 广告成片盲评\n\n1. 解压后用浏览器打开「广告成片盲评.html」，无需连网。\n2. 每组先看商品图和确认的卖点，再完整观看 A、B，分别给三项 1–5 分、选整体偏好。评分前请独立观看。\n3. 点「下一组」继续。做完全部 ${keys.length} 组后下载并交回一个 JSON，不要改动内容。\n\n每份压缩包只交给一位评阅人。\n`;
const tokens = new Set();
async function createReview() {
  const result = await get('/api/experiments/offline-bundle', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keys }),
  });
  if (result.status !== 201) throw new Error(`Bundle request: ${result.status} ${await result.text()}`);
  assert.match(result.headers.get('content-type'), /^text\/html/);
  const html = await result.text();
  const found = [...html.matchAll(/data-token="([a-f0-9]{48})"/g)].map((match) => match[1]);
  assert.equal(found.length, keys.length);
  for (const token of found) { assert.ok(!tokens.has(token)); tokens.add(token); }
  const serialized = [...html.matchAll(/data:video\/mp4;base64,([A-Za-z0-9+/=]+)/g)].map((match) => hash(Buffer.from(match[1], 'base64')));
  assert.deepEqual([...serialized].sort(), expected);
  for (let index = 0; index < serialized.length; index += 2) {
    assert.ok(videosByPair.some((pair) => pair.includes(serialized[index]) && pair.includes(serialized[index + 1])));
  }
  assert.doesNotMatch(html, /\/api\/|单向基线|质检闭环|同源画质/);
  return { html, a: new Set(serialized.filter((_, index) => index % 2 === 0)) };
}
const first = await createReview();
let complement;
// With a small panel, independent random draws can put the same version first for everybody.
// Keep the first draw random, then use the opposite within each pair for at least one other reviewer.
for (let attempt = 0; attempt < 100 && !complement; attempt++) {
  const sample = await createReview();
  if ([...sample.a].every((hash) => !first.a.has(hash))) complement = sample;
}
assert.ok(complement, 'Could not find a balanced A/B assignment; retry before distributing');
const packages = [first, complement, await createReview()];
await mkdir(destination);
for (const [index, pack] of packages.entries()) {
  const archive = zipSync({ '广告成片盲评.html': strToU8(pack.html), '阅读说明.md': strToU8(readme) }, { level: 0 });
  const file = path.join(destination, `双商品盲评-${String(index + 1).padStart(2, '0')}.zip`);
  await writeFile(file, archive, { flag: 'wx' });
  console.log(`${file}: ${keys.length} verified groups, ${archive.length} bytes`);
}
console.log(`Three independently issued packages with both A/B orders for each pair. No votes submitted.`);
