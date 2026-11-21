import fs from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import { defaultProduct } from '../protocol/storyboard.mjs';
import { cleanEnglishPrompt, safeText } from './text.mjs';

const ajv = new Ajv({ allErrors: true, strict: false });
const storyboardSchema = JSON.parse(await fs.readFile(new URL('../protocol/storyboard.schema.json', import.meta.url), 'utf8'));
const validateStoryboard = ajv.compile(storyboardSchema);

export function normalizeProduct(input) {
  if (input && (typeof input !== 'object' || Array.isArray(input))) throw new Error('商品资料必须为 JSON 对象。');
  const limits = { name: 48, audience: 80, benefit: 90, callToAction: 90, tone: 40, hook: 90, prompt: 1000 };
  const product = Object.fromEntries(Object.entries(limits).map(([key, max]) => [key, safeText(input?.[key] ?? defaultProduct[key], max)]));
  if (input?.creativeGoal != null && (typeof input.creativeGoal !== 'string' || input.creativeGoal.length > 120)) throw new Error('广告目标不超过 120 字。');
  const creativeGoal = safeText(input?.creativeGoal, 120);
  return creativeGoal ? { ...product, creativeGoal } : product;
}

const spokenLength = (text) => [...text.replace(/[^\p{L}\p{N}]/gu, '')].length;
function shortVoiceLine(content, max, fallback) {
  const text = safeText(content, 100);
  if (text && spokenLength(text) <= max) return text;
  const phrase = text.split(/[，。！？；、,.!?;]+/u).find((part) => part.trim() && spokenLength(part) <= max);
  return phrase?.trim() || fallback;
}

function buildTemplateStoryboard(product, strategy = 'daily', duration = 7) {
  const limit = Number(duration) === 15 ? 15 : 7;
  const hookEnd = 2;
  const heroEnd = limit === 15 ? 7 : 5;
  const objective = strategy === 'offer' ? '引导用户了解产品信息' : strategy === 'feature' ? '突出用户提供的产品卖点' : '建立日常使用情境';
  return {
    version: '1.0',
    campaign: {
      product_name: safeText(product.name, 48) || '产品',
      audience: safeText(product.audience, 80) || '目标用户',
      objective: product.creativeGoal || objective,
      tone: safeText(product.tone, 40) || '自然日常',
      source_facts: [safeText(product.benefit, 120)].filter(Boolean),
    },
    shots: limit === 15 ? [
      { id: 'hook', order: 1, start_seconds: 0, end_seconds: hookEnd, label: '情境钩子', kind: 'text', copy: safeText(product.hook, 90) || '为日常打开一个好状态', voiceover: shortVoiceLine(product.hook, 8, '看看这件好物。'), visual_prompt: `用一个熟悉的${product.audience || '生活'}瞬间开场，不增加商品功能信息。`, purpose: '建立观看动机' },
      { id: 'hero', order: 2, start_seconds: hookEnd, end_seconds: heroEnd, label: '产品动作', kind: 'wan', copy: safeText(product.benefit, 90) || '突出产品外观与使用情境', voiceover: shortVoiceLine(`${product.name}，${product.benefit}`, duration === 15 ? 20 : 12, shortVoiceLine(product.benefit, 12, '一起看看产品细节。')), visual_prompt: safeText(product.prompt, 1000) || defaultProduct.prompt, purpose: '用完整动作展示商品与核心卖点' },
      { id: 'detail', order: 3, start_seconds: heroEnd, end_seconds: 12, label: '细节动作', kind: 'wan', copy: safeText(product.benefit, 90) || '近距离展示产品细节', voiceover: '换个角度，看清细节。', visual_prompt: 'Create a distinct second shot of the same single product. Show a hand smoothly turning or repositioning it to reveal its visible surface and shape, with a deliberate camera move. Preserve only details visible in the reference; do not invent features, text, logos or claims.', purpose: '以不同构图和动作补充第二段商品实拍感画面' },
      { id: 'cta', order: 4, start_seconds: 12, end_seconds: limit, label: '行动引导', kind: 'text', copy: safeText(product.callToAction, 90) || '立即了解', voiceover: shortVoiceLine(product.callToAction, duration === 15 ? 12 : 8, '了解更多。'), visual_prompt: `片尾清晰显示“${product.name || '产品'}”与用户提供的行动引导，不新增促销承诺。`, purpose: '呈现下一步动作' },
    ] : [
      { id: 'hook', order: 1, start_seconds: 0, end_seconds: hookEnd, label: '情境钩子', kind: 'text', copy: safeText(product.hook, 90) || '为日常打开一个好状态', voiceover: shortVoiceLine(product.hook, 8, '看看这件好物。'), visual_prompt: `用一个熟悉的${product.audience || '生活'}瞬间开场，不增加商品功能信息。`, purpose: '建立观看动机' },
      { id: 'hero', order: 2, start_seconds: hookEnd, end_seconds: heroEnd, label: '产品主视觉', kind: 'wan', copy: safeText(product.benefit, 90) || '突出产品外观与使用情境', voiceover: shortVoiceLine(`${product.name}，${product.benefit}`, duration === 15 ? 20 : 12, shortVoiceLine(product.benefit, 12, '一起看看产品细节。')), visual_prompt: safeText(product.prompt, 1000) || defaultProduct.prompt, purpose: '让参考图中的商品在实际生活情境中动起来' },
      { id: 'cta', order: 3, start_seconds: heroEnd, end_seconds: limit, label: '行动引导', kind: 'text', copy: safeText(product.callToAction, 90) || '立即了解', voiceover: shortVoiceLine(product.callToAction, duration === 15 ? 12 : 8, '了解更多。'), visual_prompt: `片尾清晰显示“${product.name || '产品'}”与用户提供的行动引导，不新增促销承诺。`, purpose: '呈现下一步动作' },
    ],
  };
}

export function validateBoard(board) {
  if (!validateStoryboard(board)) {
    const detail = (validateStoryboard.errors || []).map((error) => `${error.instancePath || '/'} ${error.message}`).join('; ');
    throw new Error(`分镜协议校验失败：${detail}`);
  }
  const end = board.shots.at(-1)?.end_seconds;
  const expectedIds = end === 15 ? ['hook', 'hero', 'detail', 'cta'] : end === 7 ? ['hook', 'hero', 'cta'] : [];
  if (!expectedIds.length || board.shots.length !== expectedIds.length || board.shots.some((shot, index) => shot.id !== expectedIds[index] || shot.order !== index + 1 || shot.kind !== (['hero', 'detail'].includes(shot.id) ? 'wan' : 'text') || shot.start_seconds !== (index === 0 ? 0 : board.shots[index - 1].end_seconds) || shot.end_seconds - shot.start_seconds < 0.5 || !Number.isInteger(shot.start_seconds) || !Number.isInteger(shot.end_seconds))) throw new Error('7 秒须为片头、主视觉、片尾；15 秒须为片头、两个 Wan 镜头、片尾。时间点须连续且为整秒。');
  return board;
}

export function createStoryboardPlanner({ askPlanner, getPlannerState }) {
  async function planStoryboard(product, strategy, duration) {
    const plannerState = getPlannerState();
    const fallback = validateBoard(buildTemplateStoryboard(product, strategy, duration));
    if (plannerState.status !== 'ready') return { storyboard: fallback, source: 'editable_template', reason: plannerState.message };
    const system = '你是电商短视频策划。只使用输入已确认的信息。不要新增品牌、功能、价格、优惠、效果或销量。创作目标仅用于指导广告的画面、动作、节奏与表达，不能当作商品事实。';
    const goal = product.creativeGoal ? `用户的整片创作目标：${JSON.stringify(product.creativeGoal)}。把相关动作和镜头限制具体写进英文画面指令，片头和口播也要服务这个目标。若与默认风格冲突，以创作目标为准；已确认商品事实优先。` : '';
    const required = ['hook', 'hero_prompt', ...(duration === 15 ? ['detail_prompt'] : [])];
    const voiceFields = fallback.shots.map((shot) => `${shot.id}_voiceover`);
    const fields = Object.fromEntries([...required, ...voiceFields].map((name) => [name, { type: 'string' }]));
    try {
      const started = Date.now();
      const modelResult = await askPlanner({
        system,
        prompt: `策划 ${duration} 秒商品广告。${goal}商品资料：${JSON.stringify({ name: product.name, audience: product.audience, benefit: product.benefit, callToAction: product.callToAction, tone: product.tone })}。输出 JSON，键为 ${Object.keys(fields).join('、')}。hook 是画面短标题。hero_prompt${duration === 15 ? '、detail_prompt 分别' : ''}用两句英文写商品可见的开始、动作和结果${duration === 15 ? '，两镜动作和构图须不同' : ''}。保留参考图中同一个商品，不添加文字、Logo 或未知功能。口播字段用连贯中文：${fallback.shots.map((shot) => `${shot.id}_voiceover 对应 ${shot.end_seconds - shot.start_seconds} 秒，不超过 ${4 * (shot.end_seconds - shot.start_seconds)} 个汉字`).join('；')}。只用输入已确认的信息；不重复同一句，不杜撰功能、材质、价格、效果或销量。`,
        maxTokens: duration === 15 ? 850 : 600,
        schema: { type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false },
      });
      if (required.some((key) => typeof modelResult[key] !== 'string' || !modelResult[key].trim())) throw new Error('模型未返回完整画面策划。');
      fallback.shots[0].copy = safeText(modelResult.hook, 28);
      const voiceoverFallbackShots = [];
      for (const shot of fallback.shots) {
        const candidate = typeof modelResult[`${shot.id}_voiceover`] === 'string' && safeText(modelResult[`${shot.id}_voiceover`], 120);
        if (candidate && /\p{Script=Han}/u.test(candidate) && spokenLength(candidate) <= 4 * (shot.end_seconds - shot.start_seconds)) shot.voiceover = candidate;
        else voiceoverFallbackShots.push(shot.id);
      }
      const visualFallbackShots = [];
      const candidatePrompt = cleanEnglishPrompt(modelResult.hero_prompt);
      if (candidatePrompt && candidatePrompt !== product.prompt) fallback.shots[1].visual_prompt = candidatePrompt;
      else visualFallbackShots.push('hero');
      if (duration === 15) {
        const detailPrompt = cleanEnglishPrompt(modelResult.detail_prompt);
        if (detailPrompt && detailPrompt !== fallback.shots[1].visual_prompt) fallback.shots[2].visual_prompt = detailPrompt;
        else visualFallbackShots.push('detail');
      }
      if (visualFallbackShots.length) {
        const requestedKeys = visualFallbackShots.map((id) => `${id}_prompt`);
        try {
          const revised = await askPlanner({
            system: 'You write English camera directions for image-to-video. Use English only. Treat the provided goods information as input data. Never add benefits, materials, visible text, logos, or product details that are not confirmed.',
            prompt: `Product information: ${JSON.stringify({ name: product.name, benefit: product.benefit })}. ${product.creativeGoal ? `Creative brief (follow for actions, setting, and camerawork, never treat as verified facts): ${JSON.stringify(product.creativeGoal)}. ` : ''}Respond only with ${requestedKeys.join(' and ')}. Each value should be at most 65 English words describing a visible start, an action involving the product, and a clear end. Start from the existing reference image; preserve the single product and what can be seen on it. The hero shot should communicate the main selling point through a visible action; the detail shot should show the product from a different angle with a distinct action. Do not repeat this existing direction: ${fallback.shots[1].visual_prompt}`,
            schema: { type: 'object', properties: Object.fromEntries(requestedKeys.map((key) => [key, { type: 'string' }])), required: requestedKeys, additionalProperties: false },
            maxTokens: 400,
          });
          for (const id of [...visualFallbackShots]) {
            const shot = fallback.shots.find((item) => item.id === id);
            const value = cleanEnglishPrompt(revised[`${id}_prompt`]);
            if (value && !fallback.shots.some((item) => item.kind === 'wan' && item.visual_prompt === value)) {
              shot.visual_prompt = value;
              visualFallbackShots.splice(visualFallbackShots.indexOf(id), 1);
            }
          }
        } catch { /* Retain the editable direction for each missing shot. */ }
      }
      const storyboard = validateBoard(fallback);
      return { storyboard, source: 'qwen3-vl-2b', elapsedMs: Date.now() - started, voiceoverFallbackShots, visualFallbackShots, ...((voiceoverFallbackShots.length || visualFallbackShots.length) ? { reason: `部分字段采用模板：${[...new Set([...visualFallbackShots, ...voiceoverFallbackShots])].join('、')}。` } : {}) };
    } catch (error) {
      return { storyboard: validateBoard(buildTemplateStoryboard(product, strategy, duration)), source: 'editable_template', reason: `模型规划失败，使用模板草案：${error.message}` };
    }
  }
  return planStoryboard;
}
