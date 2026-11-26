const states = ['intact', 'partial', 'absent', 'deformed', 'unclear'];
const issueScores = Object.freeze({ product_identity: 'productIdentityScore', prompt_match: 'promptMatchScore', motion_clarity: 'motionClarityScore', artifact: 'artifactScore' });
const labels = { absent: '商品在结尾抽帧中消失', partial: '商品在结尾抽帧中被大面积遮挡或裁切', deformed: '商品在结尾抽帧中明显变形' };
const schema = {
  type: 'object',
  properties: { state: { type: 'string', enum: states }, observation: { type: 'string' } },
  required: ['state', 'observation'], additionalProperties: false,
};
const clean = (value, max) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';

export async function inspectEnding(ask, { productName, facts, referencePath, frame }) {
  try {
    const result = await ask({
      prompt: `Check only the ending sample of a short product video. Compare the images. The required subject is ${productName} (${facts.join('；')}) shown in the reference. In the ending sample: absent = no product visible; partial = only a small clipped or mostly occluded part is visible; deformed = clearly changed geometry; intact = the actual product is recognizable. A recognizable close-up can be intact. Use unclear if you cannot decide. If only a plain desk/counter is visible, choose absent. A hand, wire or shadow alone is not the product. Return state and a single short Chinese observation about the ending image. Do not guess motion, branding, or events outside that image.`,
      imagePaths: [{ path: referencePath, label: 'Reference product', maxEdge: 768 }, { path: frame.path, label: `Ending sample (${frame.time}s)`, maxEdge: 768 }],
      maxTokens: 175, schema,
    });
    const observation = clean(result.observation, 260);
    if (!states.includes(result.state) || !observation) throw new Error('结尾检查未返回有效观察。');
    return { state: result.state, observation, time: frame.time };
  } catch (error) {
    return { state: 'unclear', observation: '结尾检查未成功，需人工检查该帧。', reason: error.message, time: frame.time };
  }
}

function normalizeIssues(issues, frames) {
  return issues.flatMap((issue) => {
    if (!Object.hasOwn(issueScores, issue.category) || !['minor', 'major'].includes(issue.severity) || !Number.isFinite(issue.time_seconds)) return [];
    const frame = frames.reduce((best, item) => Math.abs(item.time - issue.time_seconds) < Math.abs(best.time - issue.time_seconds) ? item : best);
    const evidence = clean(issue.evidence, 300);
    return Math.abs(frame.time - issue.time_seconds) <= 0.2 && evidence.length >= 6 ? [{ ...issue, time_seconds: frame.time, evidence, source: 'whole-shot' }] : [];
  });
}

export function applyEndingEvidence(review, endingCheck) {
  const { issues: rawIssues, frames } = review;
  const issues = normalizeIssues(rawIssues, frames);
  const isEndingDefect = Object.hasOwn(labels, endingCheck.state);
  if (isEndingDefect) issues.unshift({ time_seconds: endingCheck.time, category: 'product_identity', severity: 'major', evidence: `${labels[endingCheck.state]}：${endingCheck.observation}`, source: 'ending-check' });
  const combined = { ...review, issues, endingCheck };
  for (const issue of issues) {
    const field = issueScores[issue.category];
    const cap = issue.source === 'ending-check' && endingCheck.state === 'absent' ? 1 : issue.severity === 'major' ? 2 : 4;
    combined[field] = Math.min(combined[field], cap);
  }
  const unsupported = Object.entries(issueScores).flatMap(([category, field]) => {
    if (combined[field] >= (field === 'productIdentityScore' ? 4 : 3)) return [];
    return issues.some((issue) => issue.category === category && (combined[field] > 2 || issue.severity === 'major')) ? [] : [field];
  });
  const major = issues.some((issue) => issue.severity === 'major');
  const warnings = [];
  if (rawIssues.length > issues.filter((issue) => issue.source === 'whole-shot').length) warnings.push('有问题无法对应到实际抽帧，已忽略。');
  if (unsupported.length) warnings.push('部分低分没有同类的对应证据，不用于选片或触发返工。');
  if (endingCheck.state === 'unclear') warnings.push('商品在结尾的状态未确认，需人工复核。');
  combined.unsupportedScoreFields = unsupported;
  combined.approved = review.approved && !major && !unsupported.length && endingCheck.state === 'intact';
  if (review.approved && major) warnings.push('模型通过标记与严重问题冲突，已阻止自动通过。');
  if (warnings.length) combined.consistencyWarning = warnings.join('');
  combined.retrySupported = major || (combined.productIdentityScore < 4 && !unsupported.includes('productIdentityScore'));
  return combined;
}
