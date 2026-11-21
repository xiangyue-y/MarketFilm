import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';

const baseUrl = process.env.API_BASE_URL || `http://127.0.0.1:${process.env.API_PORT || 4188}`;
const schema = JSON.parse(await fs.readFile(new URL('../protocol/storyboard.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const statusResponse = await fetch(`${baseUrl}/api/status`);
assert.equal(statusResponse.status, 200, 'API must be reachable');
const status = await statusResponse.json();
assert.equal(status.service.status, 'ready', 'Wan/ComfyUI must be ready');
assert.equal(status.planner.status, 'ready', 'Qwen3-VL must be ready');

const product = {
  name: '样例随行杯', audience: '城市通勤人群', benefit: '磨砂质感，轻松随行',
  callToAction: '了解产品', tone: '自然日常', hook: '把轻松带在身边',
  prompt: 'A clean product shot with soft daylight and slow camera motion.',
};
for (const duration of [7, 15]) {
  const response = await fetch(`${baseUrl}/api/plan`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ product, duration, strategy: 'daily' }),
  });
  assert.equal(response.status, 200, `${duration}s plan should succeed`);
  const result = await response.json();
  assert.ok(['qwen3-vl-2b', 'editable_template'].includes(result.source), 'planning must use Qwen or its documented editable fallback');
  if (result.source === 'editable_template') assert.ok(result.reason, 'fallback should explain why model planning was unavailable');
  assert.ok(validate(result.storyboard), 'plan must conform to the storyboard schema');
  assert.ok(result.storyboard.shots.every((shot) => typeof shot.voiceover === 'string' && shot.voiceover.trim()), 'each planned shot should include editable voiceover copy');
  assert.equal(result.storyboard.shots.at(-1).end_seconds, duration);
  const wanShots = result.storyboard.shots.filter((shot) => shot.kind === 'wan');
  assert.equal(wanShots.length, duration === 15 ? 2 : 1, `${duration}s plan should contain the expected number of generated clips`);
  if (duration === 15) {
    assert.deepEqual(result.storyboard.shots.map((shot) => shot.id), ['hook', 'hero', 'detail', 'cta']);
    assert.notEqual(wanShots[0].visual_prompt, wanShots[1].visual_prompt, '15s generated shots should have distinct prompts');
    assert.equal(wanShots[0].end_seconds, wanShots[1].start_seconds, 'generated shots should be continuous');
  }
}

const invalid = await fetch(`${baseUrl}/api/generate`, { method: 'POST', body: new FormData() });
assert.equal(invalid.status, 400, 'generation must reject a missing storyboard');

const historyResponse = await fetch(`${baseUrl}/api/jobs`);
assert.equal(historyResponse.status, 200);
const jobs = (await historyResponse.json()).jobs;
const completedJob = jobs.find((job) => job.status === 'completed');
if (completedJob) {
  const controller = new AbortController();
  const streamResponse = await fetch(`${baseUrl}/api/jobs/${completedJob.id}/events`, { signal: controller.signal });
  assert.equal(streamResponse.status, 200, 'job event stream should open');
  assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/);
  const reader = streamResponse.body.getReader();
  const { value } = await reader.read();
  const initialEvent = new TextDecoder().decode(value);
  assert.match(initialEvent, /event: snapshot/);
  const snapshotLine = initialEvent.split('\n').find((line) => line.startsWith('data: '));
  assert.equal(JSON.parse(snapshotLine.slice(6)).id, completedJob.id, 'event stream should send the selected job snapshot');
  controller.abort();
  await reader.cancel().catch(() => {});
}
const keys = new Set(jobs.filter((job) => job.status === 'completed').map((job) => job.experimentKey).filter(Boolean));
const pairKey = [...keys].find((key) => jobs.some((job) => job.experimentKey === key && job.mode === 'baseline' && job.status === 'completed')
  && jobs.some((job) => job.experimentKey === key && job.mode === 'audit' && job.status === 'completed'));
if (pairKey) {
  const pair = jobs.filter((job) => job.experimentKey === pairKey && job.status === 'completed');
  const baseline = pair.find((job) => job.mode === 'baseline');
  const audit = pair.find((job) => job.mode === 'audit');
  assert.equal(baseline.seed, audit.seed);
  assert.equal(baseline.experimentKey, audit.experimentKey);
}

console.log(`Smoke passed: Wan and Qwen ready; 7s/15s plans valid; invalid generation rejected; ${pairKey ? 'matched A/B pair present' : 'no matched A/B pair yet'}.`);
