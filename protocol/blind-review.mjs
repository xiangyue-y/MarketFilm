export const reviewMetrics = [
  ['productConsistency', '商品一致', '1：与参考图明显不同；3：整体相似，但细节有问题；5：可见外形、颜色和部件一致。'],
  ['promptMatch', '卖点匹配', '1：没体现确认的卖点；3：体现了部分；5：卖点都能清楚辨认。'],
  ['visualQuality', '画面观感', '1：严重抖动或变形；3：可看，有明显瑕疵；5：动作清楚自然，无明显画面问题。'],
];
export const receiptFormat = 'marketfilm-blind-v1';
export const receiptBundleFormat = 'marketfilm-blind-bundle-v1';
export const maxReviewGroups = 4;

export function unpackReviewReceipts(payload) {
  const bundled = payload?.format === receiptBundleFormat;
  const receipts = bundled ? payload.receipts : [payload];
  if (!Array.isArray(receipts) || !receipts.length || receipts.length > maxReviewGroups || (bundled && receipts.length < 2)
      || receipts.some((receipt) => receipt?.format !== receiptFormat || typeof receipt.token !== 'string' || !/^[a-f0-9]{48}$/.test(receipt.token))
      || new Set(receipts.map((receipt) => receipt.token)).size !== receipts.length) throw new Error('请选择离线盲评下载的评分 JSON。');
  return receipts;
}
