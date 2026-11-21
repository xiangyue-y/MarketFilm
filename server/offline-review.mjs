import { reviewMetrics, receiptFormat, receiptBundleFormat } from '../protocol/blind-review.mjs';

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const options = '<option value="">选择评分</option>' + [1, 2, 3, 4, 5].map((score) => `<option value="${score}">${score} 分</option>`).join('');

export function renderOfflineReview(review) {
  return renderOfflineReviewSet([review]);
}

export function renderOfflineReviewSet(reviews) {
  const multiple = reviews.length > 1;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>MarketFilm · 视频盲评</title>
<style>
:root{color-scheme:light;font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#343a53;background:#f3f4fa}*{box-sizing:border-box}body{margin:0}main{width:min(100% - 32px,1032px);margin:24px auto 48px}h1,h2,p{margin:0}h1{font-size:28px;line-height:1.3}h2{font-size:18px}p,small{line-height:1.6}.eyebrow{color:#5047c7;font-weight:600;font-size:12px;letter-spacing:.03em}.intro{display:grid;gap:8px;margin-bottom:16px}.card{background:#fff;border:1px solid #fff;border-radius:24px;padding:16px;box-shadow:0 12px 32px #545c971f}.reference{display:flex;align-items:center;gap:16px;margin-bottom:16px}.reference img{width:min(28%,120px);max-height:108px;object-fit:contain;border-radius:16px;background:#f3f4fa}.reference ul{margin:4px 0;padding-left:18px;color:#555f77}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.clip{display:grid;gap:12px;min-width:0}video{display:block;width:100%;height:min(49vh,440px);background:#eeedf6;border-radius:16px}.scores{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.controls{display:grid;grid-template-columns:minmax(120px,.4fr) minmax(0,1fr);gap:12px;align-items:start;margin-top:14px}.control,label{min-width:0;display:grid;gap:5px;font-size:13px;color:#4d5772}select,textarea{min-height:44px;max-width:100%;width:100%;min-width:0;border:0;border-radius:16px;background:#f1f2f9;padding:8px 10px;font:inherit;color:#333956}button{min-height:44px;border:0;border-radius:16px;padding:0 16px;background:#5249cb;color:white;font:inherit;font-weight:600;cursor:pointer;box-shadow:0 10px 26px #5950e337;transition:transform .2s,box-shadow .2s}button:hover{transform:translateY(-2px);box-shadow:0 15px 28px #5950e34d}button:active{transform:translateY(0) scale(.98)}:focus-visible{outline:2px solid #5251c9;outline-offset:3px}.actions{display:flex;flex-wrap:wrap;align-items:center;gap:12px;grid-column:1/-1}.actions p{color:#3c5268;font-size:13px}.rubric{margin-top:12px;padding:10px 14px;border-radius:16px;background:#ebeafb;color:#42496a;font-size:13px}.rubric details{display:grid}.rubric summary{cursor:pointer}.rubric p{margin-top:6px}small{color:#5f6880}@media(max-width:650px){.pair,.controls{grid-template-columns:minmax(0,1fr)}video{height:min(59vh,425px)}}[hidden]{display:none!important}.review-step{margin:0 0 12px;padding:10px 14px;border-radius:16px;background:#eae9fc;color:#424077;font-size:14px;font-weight:600}.secondary{background:#eeedf9;color:#45447e;box-shadow:none}@media(prefers-reduced-motion:reduce){button{transition:none}}
</style>
</head>
<body><main>
<section class="intro"><span class="eyebrow">MarketFilm 测评</span><h1>视频质量盲评</h1><p>先看参考图，再完整观看视频 A 和 B。请依据画面与确认的卖点，分别给两段视频打分。</p><small>${multiple ? `共 ${reviews.length} 组。每组单独评价，全部完成后只需回传一个评分文件。` : '此文件可离线打开。完成后只需回传下载的评分文件。'}</small></section>
${reviews.map(({ id, product, reference, clips }, group) => `<form ${group === 0 ? 'id="blind-review"' : ''} class="review-form" data-token="${escape(id)}"${group ? ' hidden' : ''}>
${multiple ? `<p class="review-step" tabindex="-1">第 ${group + 1} / ${reviews.length} 组</p>` : ''}
<section class="card reference"><img src="data:image/jpeg;base64,${reference}" alt="商品参考图"><div><h2>${escape(product.name)}</h2><ul>${product.facts.map((fact) => `<li>${escape(fact)}</li>`).join('')}</ul></div></section>
<div class="pair">${clips.map((clip, index) => {
    const slot = ['A', 'B'][index];
    return `<section class="card clip"><h2>视频 ${slot}</h2><video controls playsinline preload="metadata" aria-label="视频 ${slot}" src="data:video/mp4;base64,${clip}"></video><div class="scores">${reviewMetrics.map(([key, label]) => `<label>${label}<select required aria-label="视频 ${slot} ${label}" name="${slot}_${key}">${options}</select></label>`).join('')}</div></section>`;
  }).join('')}</div>
<div class="rubric"><details><summary>评分参考：1 分最低，5 分最高</summary>${reviewMetrics.map(([, label, detail]) => `<p><strong>${label}：</strong>${detail}</p>`).join('')}</details></div>
<div class="card controls"><label>整体偏好<select required name="preference"><option value="">选择偏好</option><option value="A">视频 A</option><option value="B">视频 B</option><option value="tie">无明显差别</option></select></label><label>备注（选填）<textarea rows="2" maxlength="1000" name="note" placeholder="如有明显问题，可以说明出现的时间"></textarea></label><div class="actions">${group ? '<button type="button" class="secondary" data-back>上一组</button>' : ''}<button type="submit">${group < reviews.length - 1 ? '下一组' : '下载评分文件'}</button><p ${group === 0 ? 'id="result"' : ''} role="status" data-result></p></div></div>
</form>`).join('')}</main>
<script>
const forms = [...document.querySelectorAll('.review-form')];
const metrics = ${JSON.stringify(reviewMetrics.map(([key]) => key))};
function showStep(index) {
  forms.forEach((form, i) => { form.hidden = i !== index; if (i !== index) for (const video of form.querySelectorAll('video')) video.pause(); });
  forms[index].querySelector('.review-step')?.focus();
}
function collect(form) {
  const data = new FormData(form);
  const ratings = Object.fromEntries(['A', 'B'].map(slot => [slot, Object.fromEntries(metrics.map(key => [key, Number(data.get(slot + '_' + key))]))]));
  return { format: '${receiptFormat}', token: form.dataset.token, ratings, preference: data.get('preference'), note: data.get('note').trim() };
}
forms.forEach((form, index) => {
  form.querySelector('[data-back]')?.addEventListener('click', () => showStep(index - 1));
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (index < forms.length - 1) { showStep(index + 1); return; }
    const incomplete = forms.findIndex((item) => !item.checkValidity());
    if (incomplete >= 0) { showStep(incomplete); forms[incomplete].reportValidity(); return; }
    const receipts = forms.map(collect);
    const receipt = forms.length === 1 ? receipts[0] : { format: '${receiptBundleFormat}', receipts };
    const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(receipt, null, 2)], { type: 'application/json' }));
    const download = document.createElement('a');
    download.href = objectUrl;
    download.download = 'MarketFilm-评分-' + receipts[0].token.slice(0, 8) + '.json';
    document.body.appendChild(download);
    download.click();
    download.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
    form.querySelector('[data-result]').textContent = '评分文件已生成，请把 JSON 文件交回。';
  });
});
</script></body></html>`;
}
