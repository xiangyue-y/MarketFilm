import { safeText } from './text.mjs';

const fields = { title: 20, opening: 100, action: 100, payoff: 100 };
const ids = ['situation', 'result', 'detail'];
const properties = Object.fromEntries(Object.keys(fields).map((field) => [field, { type: 'string' }]));
const schema = {
  type: 'object',
  properties: Object.fromEntries(ids.map((id) => [id, { type: 'object', properties, required: Object.keys(fields), additionalProperties: false }])),
  required: ids, additionalProperties: false,
};

export function creativeBrief(product) {
  const { name, audience, benefit, callToAction, tone, creativeGoal } = product;
  return { name, audience, benefit, callToAction, tone, creativeGoal };
}

export function normalizeProposal(value) {
  if (!ids.includes(value?.id) || Object.entries(fields).some(([key, limit]) =>
    typeof value[key] !== 'string' || !value[key].trim() || value[key].length > limit)) {
    throw new Error('请选择一条完整的创意提案。');
  }
  return { id: value.id, ...Object.fromEntries(Object.entries(fields).map(([key, limit]) => [key, safeText(value[key], limit)])) };
}

export async function proposeCreatives(askPlanner, product, referencePath) {
  const started = Date.now();
  const result = await askPlanner({
    system: '你是商品广告创意策划。尊重用户创作目标，依据商品资料和参考图写具体可见的广告提案。只使用确认卖点和可见外观。不要编造规格、性能、材质、品牌、价格或销量。',
    prompt: `给同一商品写三个可用本地 H3 拍成 8 秒的广告提案：situation 从一个具体的使用时刻进入，result 先给观众看一个可见的动作结果，detail 从商品一个可见细节引出它如何参与使用。这三案的第一眼画面、关键动作或揭示卖点的方式应有实质差异。每案用中文给出 title（20 字内）、opening（头两秒可见内容）、action（什么人或物如何和商品互动）、payoff（第二镜可见的结果或卖点）。每段最多 100 字。成片依次为 4 秒主镜、2 秒结果镜、2 秒片尾。为两个动态镜头各设计一个能在该档期内看清的动作。提案只描述可见画面，不在文案中标注镜头秒数。明确限制时优先尊重用户目标，并通过机位、画面起点或可见细节找差异。商品资料：${JSON.stringify(creativeBrief(product))}`,
    imagePaths: [{ path: referencePath, label: '实际商品参考图' }],
    maxTokens: 1100,
    schema,
  });
  const proposals = ids.map((id) => ({
    id,
    ...Object.fromEntries(Object.entries(fields).map(([field, length]) => [field, safeText(result[id]?.[field], length)])),
  }));
  if (proposals.some((item) => Object.keys(fields).some((field) => !item[field])) ||
      new Set(proposals.map(({ title }) => title)).size !== 3 ||
      new Set(proposals.map(({ opening, action, payoff }) => [opening, action, payoff].join('\n'))).size !== 3) {
    throw new Error('GPT 没有返回三个完整、不同的创意，请重试。');
  }
  return { proposals, elapsedMs: Date.now() - started };
}
