import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { applyEndingEvidence, inspectEnding } from '../server/ending-review.mjs';
import { chooseReviewedAttempt } from '../server/shot-selection.mjs';
import { plannerConfig } from '../server/model-config.mjs';

const [id, port] = process.argv.slice(2);
if (!/^[a-f0-9-]{36}$/.test(id || '') || (port && !/^\d{1,5}$/.test(port))) throw new Error('用法：node --env-file-if-exists=.env scripts/replay-ending-review.mjs <旧质检任务 ID> [Qwen 本机端口]');
const planner = plannerConfig(process.cwd(), port ? { ...process.env, PLANNER_BASE_URL: '', PLANNER_PORT: port } : process.env);
const storage = path.resolve(process.env.AD_STUDIO_STORAGE || 'storage');
const job = JSON.parse(await fs.readFile(path.join(storage, 'jobs', `${id}.json`)));
const ask = async ({ prompt, imagePaths, maxTokens, temperature, schema }) => {
  const content = [{ type: 'text', text: prompt }];
  for (const { path: image, label, maxEdge } of imagePaths) {
    const bytes = await sharp(image).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg().toBuffer();
    content.push({ type: 'text', text: label }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${bytes.toString('base64')}` } });
  }
  const response = await fetch(new URL('chat/completions', planner.baseUrl), { method: 'POST', headers: { 'content-type': 'application/json', ...(planner.token ? { Authorization: `Bearer ${planner.token}` } : {}) }, body: JSON.stringify({ model: planner.modelId, messages: [{ role: 'user', content }], temperature, max_tokens: maxTokens, response_format: { type: 'json_schema', json_schema: { name: 'market_film', strict: true, schema } } }), signal: AbortSignal.timeout(30_000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `模型响应 ${response.status}`);
  return JSON.parse(data.choices[0].message.content);
};
const attempts = [];
for (const attempt of job.attempts) {
  const review = attempt.review;
  if (review?.status !== 'completed' || !review.frames?.length) continue;
  const last = review.frames.at(-1);
  const mediaPath = path.join(storage, last.url);
  const start = performance.now();
  const ending = await inspectEnding(ask, { productName: job.product.name, facts: job.storyboard.campaign.source_facts, referencePath: job.referencePath, frame: { path: mediaPath, time: last.time } });
  const checked = applyEndingEvidence(review, ending);
  attempts.push({ ...attempt, review: checked, ms: Math.round(performance.now() - start), previous: { productIdentityScore: review.productIdentityScore, approved: review.approved, issueTimes: review.issues.map(({ time_seconds }) => time_seconds) } });
}
if (!attempts.length) throw new Error('这个任务没有可回放的历史质检记录');
const replay = [...new Set(attempts.map(({ shotId }) => shotId))].map((shotId) => {
  const [first, second] = attempts.filter((a) => a.shotId === shotId);
  const pick = second ? chooseReviewedAttempt(first, second) : { attempt: first };
  return { shotId, couldRetry: first.review.retrySupported, chosenRoundIfBothRun: pick.attempt.shotAttempt, reason: pick.reason || null };
});
console.log(JSON.stringify({ type: 'historical review replay; no new video', id, attempts: attempts.map(({ shotId, shotAttempt, ms, previous, review }) => ({ shotId, shotAttempt, ms, previous, ending: review.endingCheck, productIdentityScore: review.productIdentityScore, approved: review.approved, retrySupported: review.retrySupported, unsupported: review.unsupportedScoreFields })), replay }, null, 2));
