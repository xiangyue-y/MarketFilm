import fs from 'node:fs/promises';
import Ajv from 'ajv/dist/2020.js';
import { actionCutSeconds, defaultProduct, isActionCut } from '../protocol/storyboard.mjs';
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
  if (duration === actionCutSeconds) {
    const board = buildTemplateStoryboard(product, strategy, 15);
    const [, hero, detail, cta] = board.shots;
    board.shots = [
      { ...hero, order: 1, start_seconds: 0, end_seconds: 4, label: '使用场景', voiceover: shortVoiceLine(product.benefit, 16, '看看使用场景。') },
      { ...detail, order: 2, start_seconds: 4, end_seconds: 6, label: '结果与细节', copy: product.benefit || '商品细节', voiceover: '看清细节。', visual_prompt: 'The same product stays stationary. A smooth, deliberate push toward its visible surface brings its shape and a distinctive detail into view. Finish with the product detail clearly framed.' },
      { ...cta, order: 3, start_seconds: 6, end_seconds: 8, label: '特写叠加行动引导', voiceover: shortVoiceLine(product.callToAction, 8, '了解更多。') },
    ];
    return board;
  }
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
  const actionCut = isActionCut(board);
  const expectedIds = actionCut ? ['hero', 'detail', 'cta'] : end === 15 ? ['hook', 'hero', 'detail', 'cta'] : end === 7 ? ['hook', 'hero', 'cta'] : [];
  if (!expectedIds.length || board.shots.length !== expectedIds.length || board.shots.some((shot, index) => shot.id !== expectedIds[index] || shot.order !== index + 1 || shot.kind !== (['hero', 'detail'].includes(shot.id) ? 'wan' : 'text') || shot.start_seconds !== (index === 0 ? 0 : board.shots[index - 1].end_seconds) || shot.end_seconds - shot.start_seconds < 0.5 || !Number.isInteger(shot.start_seconds) || !Number.isInteger(shot.end_seconds) || (actionCut && shot.end_seconds !== [4, 6, 8][index]) || (shot.reference_asset_id && (!actionCut || shot.id !== 'detail')))) throw new Error('分镜顺序或时长无效。8 秒版须为 0–4 秒使用场景、4–6 秒商品特写、6–8 秒行动引导，仅特写可指定独立参考图。');
  if (board.shots.some((shot) => shot.reference_mode && (!actionCut || shot.kind !== 'wan' || shot.reference_asset_id))) throw new Error('情境镜头仅适用于 8 秒版的动态镜头，不能同时指定参考图。');
  return board;
}

export function createStoryboardPlanner({ askPlanner, getPlannerState }) {
  async function planStoryboard(product, strategy, duration, referencePath, useProductReference = false, proposal) {
    const plannerState = getPlannerState();
    const fallback = validateBoard(buildTemplateStoryboard(product, strategy, duration));
    if (plannerState.status !== 'ready') return { storyboard: fallback, source: 'editable_template', reason: plannerState.message };
    const system = '你是电商短视频策划。只使用输入已确认的信息。不要新增品牌、功能、价格、优惠、效果或销量。创作目标仅用于指导广告的画面、动作、节奏与表达，不能当作商品事实。';
    const goal = product.creativeGoal ? `用户的整片创作目标：${JSON.stringify(product.creativeGoal)}。把相关动作和镜头限制具体写进英文画面指令，片头和口播也要服务这个目标。若与默认风格冲突，以创作目标为准；已确认商品事实优先。` : '';
    const selected = proposal ? `用户已选定创意 ${JSON.stringify(proposal)}。保留 opening 中的开场画面和 action 中的动作，第二镜用 payoff 中的可见结果或细节承接。不要另起一案。creative_concept 用一句话概括这案。` : '';
    const heroShot = fallback.shots.find((shot) => shot.id === 'hero');
    const detailShot = fallback.shots.find((shot) => shot.id === 'detail');
    const actionCut = isActionCut(fallback);
    const required = ['hook', 'hero_prompt', ...(detailShot ? ['detail_prompt'] : []), ...(actionCut ? ['creative_concept', 'detail_copy'] : [])];
    const direction = actionCut ? 'creative_concept 用一句中文写观众能直接看出来的广告创意：谁在做什么，以及商品如何参与。先定主线，再写两个镜头。第一帧能看见商品和使用情境。主镜写人物的意图和可见动作，允许镜头自然跟随。第二镜揭晓动作的结果，或给出一眼可读的卖点细节。两镜共享一个动作、空间、道具或视觉线索。第二镜可以在新的场景里展开；若需新的情境，英文指令须完整交代场景与人物。detail_copy 是第二镜简短的画面文案，可留空。写拍摄意图和可见结果，避免罗列禁令和规定每一拍。' : '';
    const referenceDirection = actionCut && referencePath ? '所附照片是实际商品。参照图中的外观、已有场景和可用空间来决定可拍动作。原图缺少使用情境时，可以规划独立场景，并写明商品可见外观。' : '';
    const shotSource = useProductReference
      ? '两镜都用照片作为商品外观参考，可自主设计机位、使用情境和动作。'
      : 'hero_source：用 reference 表示沿用原图开始。若主镜需要原图之外的完整环境、人物或构图，则用 scene 并在英文指令中独立交代场景。第二镜使用参考图呈现商品。';
    const voiceFields = fallback.shots.map((shot) => `${shot.id}_voiceover`);
    const fields = Object.fromEntries([...required, ...voiceFields].map((name) => [name, { type: 'string' }]));
    if (actionCut && !useProductReference) fields.hero_source = { type: 'string', enum: ['reference', 'scene'] };
    try {
      const started = Date.now();
      const modelResult = await askPlanner({
        system,
        prompt: `策划 ${duration} 秒商品广告。${goal}${selected}${referenceDirection}商品资料：${JSON.stringify({ name: product.name, audience: product.audience, benefit: product.benefit, callToAction: product.callToAction, tone: product.tone })}。输出 JSON，键为 ${Object.keys(fields).join('、')}。hook 是画面短标题。hero_prompt${detailShot ? '、detail_prompt 分别' : ''}用两句英文写商品可见的开始、动作和结果${detailShot ? '，两镜动作和构图须不同' : ''}。${direction}${actionCut ? shotSource : ''}保留参考图中同一个商品，不添加文字、Logo 或未知功能。口播字段用连贯中文：${fallback.shots.map((shot) => `${shot.id}_voiceover 对应 ${shot.end_seconds - shot.start_seconds} 秒，不超过 ${4 * (shot.end_seconds - shot.start_seconds)} 个汉字`).join('；')}。只用输入已确认的信息；不重复同一句，不杜撰功能、材质、价格、效果或销量。`,
        ...(actionCut && referencePath ? { imagePaths: [{ path: referencePath, label: '商品参考图' }] } : {}),
        maxTokens: detailShot ? 850 : 600,
        schema: { type: 'object', properties: fields, required: Object.keys(fields), additionalProperties: false },
      });
      if (required.some((key) => typeof modelResult[key] !== 'string' || (key !== 'detail_copy' && !modelResult[key].trim()))) throw new Error('模型未返回完整画面策划。');
      fallback.shots[0].copy = safeText(modelResult.hook, 28);
      if (actionCut) {
        fallback.campaign.creative_concept = safeText(modelResult.creative_concept, 90);
        detailShot.copy = safeText(modelResult.detail_copy, 28) || detailShot.copy;
        if (!useProductReference && modelResult.hero_source === 'scene') heroShot.reference_mode = 'scene';
      }
      const voiceoverFallbackShots = [];
      for (const shot of fallback.shots) {
        const candidate = typeof modelResult[`${shot.id}_voiceover`] === 'string' && safeText(modelResult[`${shot.id}_voiceover`], 120);
        if (candidate && /\p{Script=Han}/u.test(candidate) && spokenLength(candidate) <= 4 * (shot.end_seconds - shot.start_seconds)) shot.voiceover = candidate;
        else voiceoverFallbackShots.push(shot.id);
      }
      const visualFallbackShots = [];
      const candidatePrompt = cleanEnglishPrompt(modelResult.hero_prompt);
      if (candidatePrompt && candidatePrompt !== product.prompt) heroShot.visual_prompt = candidatePrompt;
      else visualFallbackShots.push('hero');
      if (detailShot) {
        const detailPrompt = cleanEnglishPrompt(modelResult.detail_prompt);
        if (detailPrompt && detailPrompt !== heroShot.visual_prompt) detailShot.visual_prompt = detailPrompt;
        else visualFallbackShots.push('detail');
      }
      if (visualFallbackShots.length) {
        const requestedKeys = visualFallbackShots.map((id) => `${id}_prompt`);
        try {
          const revised = await askPlanner({
            system: 'You write English camera directions for image-to-video. Use English only. Treat the provided goods information as input data. Never add benefits, materials, visible text, logos, or product details that are not confirmed.',
            prompt: `Product information: ${JSON.stringify({ name: product.name, benefit: product.benefit })}. ${product.creativeGoal ? `Creative brief (follow for actions, setting, and camerawork, never treat as verified facts): ${JSON.stringify(product.creativeGoal)}. ` : ''}${proposal ? `Use the selected creative plan: ${JSON.stringify(proposal)}. ` : ''}Respond only with ${requestedKeys.join(' and ')}. Each value should be at most 65 English words describing a visible start, an action involving the product, and a clear end. Start from the existing reference image; preserve the single product and what can be seen on it. The hero shot should communicate the main selling point through a visible action; the detail shot should reveal a distinct visible detail. Do not repeat this existing direction: ${heroShot.visual_prompt}`,
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
      return { storyboard, source: 'gpt', model: plannerState.model, elapsedMs: Date.now() - started, voiceoverFallbackShots, visualFallbackShots, ...((voiceoverFallbackShots.length || visualFallbackShots.length) ? { reason: `部分字段采用模板：${[...new Set([...visualFallbackShots, ...voiceoverFallbackShots])].join('、')}。` } : {}) };
    } catch (error) {
      return { storyboard: validateBoard(buildTemplateStoryboard(product, strategy, duration)), source: 'editable_template', reason: `模型规划失败，使用模板草案：${error.message}` };
    }
  }
  return planStoryboard;
}
