export const revisionPolicy = 'ending-evidence-v2';
const dimensions = [['productIdentityScore', '商品一致性'], ['promptMatchScore', '指令匹配'], ['motionClarityScore', '动作清晰度'], ['artifactScore', '伪影控制']];
const complete = (review) => review?.status === 'completed' && dimensions.every(([key]) => Number.isInteger(review[key]) && review[key] >= 1 && review[key] <= 5);
const endingGrade = { absent: 0, partial: 1, deformed: 1, intact: 2 };

export function chooseReviewedAttempt(first, retry) {
  if (!retry?.videoUrl || !complete(retry.review) || !complete(first?.review)) return { attempt: first, reason: '两轮缺少可比质检结果，保留首轮。' };
  const evidenceMode = Boolean(first.review.endingCheck || retry.review.endingCheck);
  if (evidenceMode) {
    const before = endingGrade[first.review.endingCheck?.state];
    const after = endingGrade[retry.review.endingCheck?.state];
    if (before == null || after == null) return { attempt: first, reason: '两轮结尾证据不可比，保留首轮。' };
    if (after < before) return { attempt: first, reason: '返工后商品在结尾的状态变差，保留首轮。' };
  }
  const incomparable = new Set(evidenceMode ? [...(first.review.unsupportedScoreFields || []), ...(retry.review.unsupportedScoreFields || [])] : []);
  const supported = dimensions.filter(([key]) => !incomparable.has(key));
  const regression = supported.filter(([key]) => retry.review[key] < first.review[key]).map(([, label]) => label);
  if (regression.length) return { attempt: first, reason: `${regression.join('、')}评分下降，保留首轮。` };
  const endingImproved = evidenceMode && endingGrade[retry.review.endingCheck.state] > endingGrade[first.review.endingCheck.state];
  const improved = endingImproved || supported.some(([key]) => retry.review[key] > first.review[key]);
  if ((first.review.approved && !retry.review.approved) || (!improved && first.review.approved === retry.review.approved)) return { attempt: first, reason: '质检未显示返工更好，保留首轮。' };
  return { attempt: retry, reason: endingImproved ? `返工后商品在结尾更易辨认。${retry.review.approved ? '' : '仍需人工复核。'}` : retry.review.approved ? '返工通过质检，且各项可比分数未下降。' : '返工有证据支持改善，且其他项未下降；仍需人工复核。' };
}
