import sharp from 'sharp';

export function createPlannerClient({ baseUrl, modelId, reasoningEffort, token }) {
  async function request(route, timeout, body) {
    if (!token) throw new Error('请在 .env 中设置 PLANNER_API_KEY。');
    const response = await fetch(new URL(route, baseUrl), {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`GPT 接口返回 HTTP ${response.status}。`);
    return response.json();
  }

  async function probe() {
    const models = await request('models', 8000);
    if (!models.data?.some((model) => model.id === modelId)) {
      throw new Error(`当前 GPT 接口未列出模型 ${modelId}。`);
    }
  }

  async function ask({ system, prompt, imagePaths = [], maxTokens = 1200, schema }) {
    const content = [{ type: 'input_text', text: prompt }];
    for (const image of imagePaths) {
      const { path: imagePath, label, maxEdge = 512 } = typeof image === 'string' ? { path: image } : image;
      if (label) content.push({ type: 'input_text', text: label });
      const buffer = await sharp(imagePath).rotate().resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true }).jpeg().toBuffer();
      content.push({ type: 'input_image', image_url: `data:image/jpeg;base64,${buffer.toString('base64')}`, detail: 'auto' });
    }
    const response = await request('responses', 150_000, {
      model: modelId,
      instructions: system,
      input: [{ role: 'user', content }],
      reasoning: { effort: reasoningEffort },
      store: false,
      // The Responses budget covers hidden reasoning as well as the JSON output.
      max_output_tokens: maxTokens + 4096,
      text: { format: { type: 'json_schema', name: 'market_film', strict: true, schema } },
    });
    if (response.status === 'incomplete') throw new Error('GPT 未完成本次输出。');
    if (response.status !== 'completed') throw new Error('GPT 未返回已完成的响应。');
    const parts = response.output?.filter((item) => item.type === 'message').flatMap((item) => item.content || []) || [];
    if (parts.some((part) => part.type === 'refusal')) throw new Error('GPT 拒绝处理本次输入。');
    const output = parts.filter((part) => part.type === 'output_text').map((part) => part.text).join('');
    try {
      const value = JSON.parse(output);
      if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    } catch { /* Report an invalid result without logging the model output. */ }
    throw new Error('GPT 未返回有效的 JSON 对象。');
  }

  return { ask, probe };
}
