import crypto from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import WebSocket from 'ws';
import ffmpegPath from 'ffmpeg-static';
import { copyNarrationTracks, muxNarration, normalizeSpeech, prepareNarration, previewNarration, validSpeech } from './narration.mjs';
import { narrationModelId, narrationProvider, narrationStatus, narrationVoice, stopNarration, voicePresets } from './tts.mjs';
import { createAssetLibrary } from './assets.mjs';
import { mountExperiments } from './experiments.mjs';
import { chooseReviewedAttempt, revisionPolicy } from './shot-selection.mjs';
import { makeWanReference, referencePolicy } from './wan-reference.mjs';
import { applyEndingEvidence, inspectEnding } from './ending-review.mjs';
import { inspectPersistentMatte } from './matte-framing.mjs';
import { softMattePolicy } from '../protocol/presentation.mjs';
import { actionCutSeconds, isActionCut, storyboardToScenes } from '../protocol/storyboard.mjs';
import { createStoryboardPlanner, normalizeProduct, validateBoard } from './storyboard.mjs';
import { normalizeProposal, proposeCreatives } from './creative-proposals.mjs';
import { cleanEnglishPrompt, safeText } from './text.mjs';
import { plannerConfig, wanConfig } from './model-config.mjs';
import { createPlannerClient } from './planner.mjs';
import { h3, makeH3Workflow } from './h3-workflow.mjs';
import { wan14, makeWan14Workflow } from './wan14-workflow.mjs';

const execFile = promisify(execFileCallback);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const storageRoot = process.env.AD_STUDIO_STORAGE ? path.resolve(process.env.AD_STUDIO_STORAGE) : path.join(appRoot, 'storage');
const jobsRoot = path.join(storageRoot, 'jobs');
const mediaRoot = path.join(storageRoot, 'media');
const assetsRoot = path.join(storageRoot, 'assets');
const evaluationsRoot = path.join(storageRoot, 'evaluations');
const assets = createAssetLibrary(assetsRoot);
const sampleImage = path.join(appRoot, 'public', 'product-tumbler.png');
const wan = wanConfig();
const wanModel = 'Wan 2.2 TI2V 5B';
const creativeModel = { 'h3-ref2va': h3, 'wan-i2v-a14b': wan14 }[process.env.CREATIVE_VIDEO_MODEL];
const planner = plannerConfig();
const plannerClient = createPlannerClient(planner);
const apiPort = Number(process.env.API_PORT || 4188);
const comfyUrl = (route) => new URL(route, wan.baseUrl);
const comfySocketUrl = (clientId) => {
  const url = comfyUrl('ws');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('clientId', clientId);
  return url;
};
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 18 * 1024 * 1024 } });
const app = express();
await Promise.all([jobsRoot, mediaRoot, assetsRoot, evaluationsRoot].map((directory) => fs.mkdir(directory, { recursive: true })));

const jobs = new Map();
const writes = new Map();
const jobSubscribers = new Map();
for (const name of await fs.readdir(jobsRoot)) {
  if (!/^[\da-f-]{36}\.json$/i.test(name)) continue;
  try {
    const stored = JSON.parse(await fs.readFile(path.join(jobsRoot, name), 'utf8'));
    if (`${stored.id}.json` !== name) continue;
    if (!['completed', 'failed'].includes(stored.status)) Object.assign(stored, { status: 'failed', stage: 'error', error: '服务重启，任务已中断。' });
    jobs.set(stored.id, stored);
  } catch (error) { console.error(`读取历史任务失败：${name}`, error.message); }
}
for (const job of jobs.values()) {
  if (job.userRevision || job.experimentKey || !job.storyboard || !job.referencePath || !job.seed) continue;
  job.experimentKey = await buildExperimentKey(job).catch(() => null);
}
const pendingJobs = [];
const runningExports = new Set();
let activeJob = null;
let serviceState = { status: 'starting', message: '正在连接 Wan / ComfyUI…', gpu: null, error: null };
let creativeServiceState = serviceState;
let plannerState = { status: 'checking', message: '检查 GPT 接口…', error: null, model: planner.modelId, reasoningEffort: planner.reasoningEffort };
let plannerBootPromise = null;
let comfyTunnel = null;
let workerBootPromise = null;
const planStoryboard = createStoryboardPlanner({ askPlanner, getPlannerState: () => plannerState });

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function ssh(command, timeout = 15_000) {
  const { stdout } = await execFile('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '--', wan.sshHost, command], { timeout, maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function probeComfy() {
  try {
    const response = await fetch(comfyUrl('system_stats'), { signal: AbortSignal.timeout(1800) });
    if (!response.ok) return null;
    const stats = await response.json();
    return stats?.system ? stats : null;
  } catch {
    return null;
  }
}

async function chooseFreeGpu() {
  const rows = await ssh('nvidia-smi --query-gpu=index,uuid,memory.free,utilization.gpu --format=csv,noheader,nounits');
  const candidates = rows.split('\n').map((row) => {
    const [index, uuid, free, utilization] = row.split(',').map((part) => part.trim());
    return { index: Number(index), uuid, freeMiB: Number(free), utilization: Number(utilization) };
  }).filter((gpu) => gpu.uuid && gpu.freeMiB >= wan.minFreeVram && gpu.utilization <= 5)
    .sort((left, right) => right.freeMiB - left.freeMiB);
  if (!candidates.length) throw new Error(`远程没有满足要求的空闲 GPU：需要至少 ${wan.minFreeVram} MiB 可用显存，且利用率不高于 5%。`);
  return candidates[0];
}

function startTunnel() {
  if (comfyTunnel && comfyTunnel.exitCode === null) return;
  comfyTunnel = spawn('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-N',
    '-L', `127.0.0.1:${wan.localPort}:127.0.0.1:${wan.remotePort}`,
    '--', wan.sshHost,
  ], { stdio: 'ignore' });
  comfyTunnel.on('error', (error) => {
    serviceState = { ...serviceState, status: 'error', error: error.message, message: 'SSH 隧道启动失败' };
    creativeServiceState = serviceState;
  });
  comfyTunnel.on('exit', (code) => {
    if (code !== null && code !== 0 && (serviceState.status === 'ready' || creativeServiceState?.status === 'ready')) {
      serviceState = { ...serviceState, status: 'error', message: 'SSH 隧道已断开', error: `ssh exit ${code}` };
      creativeServiceState = serviceState;
    }
  });
}

async function checkVideoWorkflow(loaders, conditioningNode) {
  const nodes = [...Object.keys(loaders), conditioningNode, 'CreateVideo', 'SaveVideo'];
  const issues = (await Promise.all(nodes.map(async (name) => {
    const response = await fetch(comfyUrl(`object_info/${name}`), { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return `${name}（HTTP ${response.status}）`;
    const node = (await response.json())?.[name];
    if (!node) return `缺少节点 ${name}`;
    if (loaders[name]) {
      const [input, ...weights] = loaders[name];
      const missing = weights.filter((weight) => !node.input?.required?.[input]?.[0]?.includes(weight));
      if (missing.length) return `缺少权重 ${missing.join('、')}`;
    }
    return null;
  }))).filter(Boolean);
  if (issues.length) throw new Error(issues.join('；'));
}

function checkModel(model) {
  if (model === h3.name) return checkVideoWorkflow({
    UNETLoader: ['unet_name', h3.unet],
    CLIPLoader: ['clip_name', h3.encoder],
    VAELoader: ['vae_name', h3.videoVae, h3.audioVae],
    LoraLoaderModelOnly: ['lora_name', h3.lora],
  }, 'MiniMaxH3ReferenceToVideo');
  if (model === wan14.name) return checkVideoWorkflow({
    UNETLoader: ['unet_name', wan14.highNoise, wan14.lowNoise],
    CLIPLoader: ['clip_name', wan.textEncoder],
    VAELoader: ['vae_name', wan14.vae],
  }, 'WanImageToVideo');
  return checkVideoWorkflow({
    UNETLoader: ['unet_name', wan.unet],
    CLIPLoader: ['clip_name', wan.textEncoder],
    VAELoader: ['vae_name', wan.vae],
  }, 'Wan22ImageToVideoLatent');
}

async function modelStatus(model, connection) {
  try {
    await checkModel(model);
    return { ...connection, status: 'ready', message: `${model} 可用`, error: null };
  } catch (error) {
    return { ...connection, status: 'error', message: `${model} 未就绪：${error.message}`, error: error.message };
  }
}

async function bootComfy() {
  serviceState = { status: 'starting', message: '正在连接 Wan / ComfyUI…', gpu: null, error: null };
  creativeServiceState = serviceState;
  let gpu = null;
  if (wan.managed && !(await ssh(`curl -fsS --max-time 2 http://127.0.0.1:${wan.remotePort}/system_stats || true`))) {
    gpu = await chooseFreeGpu();
    const startScript = [
      'set -e',
      `mkdir -p ${shellQuote(`${wan.remoteWorkDir}/input`)} ${shellQuote(`${wan.remoteWorkDir}/output`)} ${shellQuote(`${wan.remoteWorkDir}/logs`)}`,
      `if ! curl -fsS --max-time 2 http://127.0.0.1:${wan.remotePort}/system_stats >/dev/null; then`,
      `  cd ${shellQuote(wan.remoteComfyDir)}`,
      `  nohup env CUDA_VISIBLE_DEVICES=${shellQuote(gpu.uuid)} PYTHONUNBUFFERED=1 OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True ${shellQuote(wan.remotePython)} main.py --listen 127.0.0.1 --port ${wan.remotePort} --input-directory ${shellQuote(`${wan.remoteWorkDir}/input`)} --output-directory ${shellQuote(`${wan.remoteWorkDir}/output`)} --disable-all-custom-nodes --use-pytorch-cross-attention --reserve-vram 1.5 > ${shellQuote(`${wan.remoteWorkDir}/logs/comfy.log`)} 2>&1 < /dev/null &`,
      'fi',
    ].join('\n');
    await ssh(`bash -lc ${shellQuote(startScript)}`);
  }
  if (wan.sshHost) startTunnel();
  const attempts = wan.managed ? 75 : wan.sshHost ? 10 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const stats = await probeComfy();
    if (stats) {
      if (comfyTunnel?.exitCode != null) throw new Error(`SSH 隧道已退出，代码 ${comfyTunnel.exitCode}`);
      const device = stats.devices?.[0];
      const selected = gpu || (device ? { index: device.index, uuid: 'existing', freeMiB: Math.round(device.vram_free / 1048576), utilization: null } : null);
      const connection = { gpu: selected, comfyVersion: stats.system?.comfyui_version, device: device?.name || 'ComfyUI' };
      [serviceState, creativeServiceState] = await Promise.all([
        modelStatus(wanModel, connection),
        creativeModel ? modelStatus(creativeModel.name, connection) : null,
      ]);
      return;
    }
    if (comfyTunnel?.exitCode != null) throw new Error(`SSH 隧道已退出，代码 ${comfyTunnel.exitCode}`);
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error(wan.sshHost ? 'SSH 后的 ComfyUI 尚未可用，请检查目标端口和远端服务。' : '请启动 ComfyUI，或在 .env 设置 WAN_COMFY_URL 后重启工作台。');
}

function startWorkerBoot() {
  if (workerBootPromise) return workerBootPromise;
  workerBootPromise = bootComfy().catch((error) => {
    serviceState = { status: 'error', message: `ComfyUI 未就绪：${error.message}`, gpu: null, error: error.message };
    creativeServiceState = serviceState;
  }).finally(() => { workerBootPromise = null; });
  return workerBootPromise;
}

function setPlannerState(status, message, error = null) {
  plannerState = { ...plannerState, status, message, error };
}

async function startPlanner() {
  if (!planner.token) return setPlannerState('missing', '请在 .env 中设置 PLANNER_API_KEY。');
  setPlannerState('checking', '检查 GPT 接口…');
  await plannerClient.probe();
  setPlannerState('ready', 'GPT 策划与质检已就绪');
}

function queuePlannerStart() {
  plannerBootPromise ||= startPlanner().catch((error) => {
    setPlannerState('error', 'GPT 接口未就绪，请检查服务地址、模型和 API 密钥。', error.message);
  }).finally(() => { plannerBootPromise = null; });
}

const quick = process.env.WAN_PRESET === 'quick';
const profile = quick ? { width: 384, height: 704, frames: 49, steps: 10 } : { width: 576, height: 1024, frames: 73, steps: 14 };
const outputFormats = {
  '9:16': { key: '9x16', width: 576, height: 1024 },
  '1:1': { key: '1x1', width: 768, height: 768 },
  '16:9': { key: '16x9', width: 1024, height: 576 },
};

function makeWorkflow({ jobId, uploadedImage, prompt, seed, creativeMotion = false, width = profile.width, height = profile.height, frames = profile.frames, steps = profile.steps }) {
  const positive = creativeMotion ? prompt : `${prompt} Show the specified action clearly from start to finish in one continuous shot. Keep the product recognizable by its original proportions, material, color and visible details as it moves. Keep the action legible in the frame and any camera movement smooth. Do not add text, logos or watermarks.`;
  const negative = creativeMotion ? 'heavy artifacts, duplicated product, watermark' : 'captions, subtitles, watermark, logo, duplicated product, changing product shape, changing color, melting, morphing, unsupported floating objects, deformed object, stuttering, jerky movement, accidental camera shake, abrupt camera motion, cuts, blur, oversharpening';
  const node = (class_type, inputs) => ({ class_type, inputs });
  return {
    '1': node('UNETLoader', { unet_name: wan.unet, weight_dtype: 'default' }),
    '2': node('CLIPLoader', { clip_name: wan.textEncoder, type: 'wan', device: 'cpu' }),
    '3': node('VAELoader', { vae_name: wan.vae }),
    ...(uploadedImage ? { '4': node('LoadImage', { image: uploadedImage.name }) } : {}),
    '5': node('CLIPTextEncode', { clip: ['2', 0], text: positive }),
    '6': node('CLIPTextEncode', { clip: ['2', 0], text: negative }),
    '7': node('ModelSamplingSD3', { model: ['1', 0], shift: 8.0 }),
    '8': node('Wan22ImageToVideoLatent', { vae: ['3', 0], ...(uploadedImage ? { start_image: ['4', 0] } : {}), width, height, length: frames, batch_size: 1 }),
    '9': node('KSampler', {
      model: ['7', 0],
      seed,
      steps,
      cfg: 5.0,
      sampler_name: 'uni_pc',
      scheduler: 'simple',
      denoise: 1.0,
      positive: ['5', 0],
      negative: ['6', 0],
      latent_image: ['8', 0],
    }),
    '10': node('VAEDecode', { samples: ['9', 0], vae: ['3', 0] }),
    '11': node('CreateVideo', { images: ['10', 0], fps: 24.0 }),
    '12': node('SaveVideo', { video: ['11', 0], filename_prefix: `market-film/${jobId}`, format: 'auto', codec: 'auto' }),
  };
}

function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  broadcastJob(job);
  const filename = path.join(jobsRoot, `${job.id}.json`);
  const snapshot = JSON.stringify(job, null, 2);
  const writing = (writes.get(job.id) || Promise.resolve()).then(async () => {
    await fs.writeFile(`${filename}.tmp`, snapshot);
    await fs.rename(`${filename}.tmp`, filename);
  }).catch((error) => console.error('保存任务失败：', error.message));
  writes.set(job.id, writing);
  void writing.then(() => { if (writes.get(job.id) === writing) writes.delete(job.id); });
  return writing;
}

function logStage(job, stage, message, elapsedMs) {
  updateJob(job, { logs: [...job.logs, { stage, message, time: new Date().toISOString(), ...(elapsedMs === undefined ? {} : { elapsedMs }) }] });
}

function publicJob(job) {
  const { referencePath: _privateReferencePath, ...safe } = job;
  return safe;
}

function broadcastJob(job) {
  const subscribers = jobSubscribers.get(job.id);
  if (!subscribers?.size) return;
  const message = `event: update\ndata: ${JSON.stringify(publicJob(job))}\n\n`;
  for (const response of subscribers) {
    if (response.destroyed || response.writableEnded) {
      subscribers.delete(response);
      continue;
    }
    response.write(message);
  }
  if (!subscribers.size) jobSubscribers.delete(job.id);
}

function subscribeToJob(job, response) {
  response.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders();
  response.write(`event: snapshot\ndata: ${JSON.stringify(publicJob(job))}\n\n`);

  const subscribers = jobSubscribers.get(job.id) || new Set();
  subscribers.add(response);
  jobSubscribers.set(job.id, subscribers);

  const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 20_000);
  response.on('close', () => {
    clearInterval(heartbeat);
    subscribers.delete(response);
    if (!subscribers.size) jobSubscribers.delete(job.id);
  });
}

async function buildExperimentKey(job) {
  const image = await fs.readFile(job.referencePath);
  const imageHash = crypto.createHash('sha256').update(image).digest('hex');
  return crypto.createHash('sha256').update(JSON.stringify({ seed: job.seed, profile: job.profile || profile, model: job.model && job.model !== wanModel ? job.model : undefined, storyboard: job.storyboard, imageHash, revisionPolicy: job.revisionPolicy, referencePolicy: job.referencePolicy, product: job.referencePolicy ? job.product : undefined, narration: job.narrationEnabled ? (job.narrationEngine ? `${job.narrationEngine}:${job.narrationVoice}` : job.narrationVoice || 'Tingting') : undefined, renderPolicy: job.renderPolicy })).digest('hex');
}

async function uploadToComfy(imagePath, jobId) {
  const image = await fs.readFile(imagePath);
  const ext = path.extname(imagePath) || '.png';
  const form = new FormData();
  form.append('image', new Blob([image]), `product-${jobId}${ext}`);
  form.append('type', 'input');
  form.append('overwrite', 'true');
  const body = await readComfy('upload/image', (response) => response.json(), 30_000, { method: 'POST', body: form });
  if (!body.name) throw new Error(`ComfyUI 图片上传失败：${JSON.stringify(body)}`);
  return body;
}

async function readComfy(route, read, timeout, options) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(comfyUrl(route), { ...options, signal: AbortSignal.timeout(timeout) });
      if (response.ok) return await read(response);
    } catch (error) {
      if (attempt === 3 || !['TimeoutError', 'TypeError', 'AbortError'].includes(error.name)) throw error;
    }
    if (response && !response.ok) {
      await response.body?.cancel().catch(() => {});
      if (attempt === 3 || ![502, 503, 504].includes(response.status)) {
        throw new Error(`ComfyUI ${route.split('?')[0]}：HTTP ${response.status}`);
      }
    }
    if (wan.sshHost) startTunnel();
    await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
  }
}

async function createAspectImage(imagePath, width, height) {
  const background = await sharp(imagePath).rotate().resize(width, height, { fit: 'cover', position: 'centre' }).blur(28).modulate({ brightness: 0.58, saturation: 0.82 }).png().toBuffer();
  const foreground = await sharp(imagePath).rotate().resize(width, height, { fit: 'inside' }).png().toBuffer();
  return sharp(background).composite([{ input: foreground, gravity: 'centre' }]).png().toBuffer();
}

function wrapText(text, maxChars) {
  const characters = [...text];
  const lines = [];
  for (let index = 0; index < characters.length; index += maxChars) lines.push(characters.slice(index, index + maxChars).join(''));
  return lines.length ? lines : [''];
}

const limitLines = (lines, maximum) => lines.length <= maximum ? lines : [...lines.slice(0, maximum - 1), `${[...lines[maximum - 1]].slice(0, -1).join('')}…`];

async function createCard(imagePath, product, kind, outputPath, shot, format) {
  const { width, height } = format;
  const name = safeText(product.name, 20) || '产品短片';
  const benefit = safeText(product.benefit, 28) || '日常好物，随心而行';
  const cta = safeText(product.callToAction, 16) || '立即了解';
  const hook = safeText(product.hook, 28) || '让日常，多一点轻松';
  if (kind === 'action-copy' || kind === 'action-cta') {
    const padding = Math.round(width * 0.072);
    const titleSize = Math.round(height * 0.035);
    const y = Math.round(height * 0.86);
    const lines = limitLines(wrapText(shot.copy, Math.floor((width - padding * 2) / titleSize)), 2);
    const title = lines.map((line, index) => `<tspan x="${padding}" dy="${index ? Math.round(titleSize * 1.26) : 0}">${escapeXml(line)}</tspan>`).join('');
    const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <defs><linearGradient id="shade" x2="0" y2="1"><stop offset=".64" stop-color="#101613" stop-opacity="0"/><stop offset="1" stop-color="#101613" stop-opacity=".82"/></linearGradient></defs>
      <rect width="${width}" height="${height}" fill="url(#shade)"/>
      ${kind === 'action-cta' ? `<text x="${padding}" y="${y - Math.round(titleSize * 1.3)}" fill="#d9f4c5" font-family="PingFang SC, Noto Sans CJK SC, sans-serif" font-size="${Math.round(titleSize * 0.59)}">${escapeXml(name)}</text>` : ''}
      <text x="${padding}" y="${y}" fill="white" font-family="PingFang SC, Noto Sans CJK SC, sans-serif" font-size="${titleSize}" font-weight="700">${title}</text>
    </svg>`);
    await sharp(svg).png().toFile(outputPath);
    return;
  }
  const isIntro = kind === 'intro' || shot?.id === 'hook';
  const isOutro = kind === 'outro' || shot?.id === 'cta';
  const headline = kind === 'overlay' ? (shot?.copy || benefit) : (isOutro ? name : (shot?.copy || hook));
  const subline = kind === 'overlay' ? `${name}  |  ${cta}` : (isOutro ? (shot?.copy || cta) : `${name} · ${benefit}`);
  const scale = Math.max(0.78, Math.min(1.25, height / 1024));
  const padding = Math.round(42 * scale);
  const headlineSize = Math.round(46 * scale);
  const headlineLineHeight = Math.round(headlineSize * 1.24);
  const maxChars = Math.max(8, Math.floor((width - 2 * padding) / (headlineSize * 1.08)));
  const headlineLines = limitLines(wrapText(headline, maxChars), 2);
  const sublineLines = limitLines(wrapText(subline, Math.max(maxChars, Math.floor((width - 2 * padding) / (23 * scale)))), 2);
  const titleY = Math.min(Math.round(height * (isIntro ? 0.61 : 0.68)), height - headlineLines.length * headlineLineHeight - (sublineLines.length - 1) * Math.round(27 * scale) - Math.round((isOutro ? 128 : 76) * scale));
  const headlineText = headlineLines.map((line, index) => `<tspan x="${padding}" dy="${index === 0 ? 0 : headlineLineHeight}">${escapeXml(line)}</tspan>`).join('');
  const sublineY = titleY + headlineLines.length * headlineLineHeight + Math.round(10 * scale);
  const sublineText = sublineLines.map((line, index) => `<tspan x="${padding}" dy="${index === 0 ? 0 : Math.round(27 * scale)}">${escapeXml(line)}</tspan>`).join('');
  const pillWidth = Math.min(Math.round(250 * scale), width - 2 * padding);
  const svg = Buffer.from(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#081610" stop-opacity=".02"/><stop offset=".4" stop-color="#081610" stop-opacity=".06"/><stop offset="1" stop-color="#081610" stop-opacity=".79"/></linearGradient></defs>
    <rect width="${width}" height="${height}" fill="url(#shade)"/>
    <text x="${padding}" y="${Math.round(72 * scale)}" fill="#ffffff" font-family="Arial, PingFang SC, Noto Sans CJK SC, sans-serif" font-size="${Math.round(17 * scale)}" font-weight="700">MARKET FILM</text>
    <rect x="${padding}" y="${titleY - Math.round(47 * scale)}" width="${Math.round(42 * scale)}" height="${Math.round(4 * scale)}" rx="2" fill="#bbf08e"/>
    <text x="${padding}" y="${titleY}" fill="#ffffff" font-family="Arial, PingFang SC, Noto Sans CJK SC, sans-serif" font-size="${headlineSize}" font-weight="700">${headlineText}</text>
    <text x="${padding}" y="${sublineY}" fill="#e7eee7" font-family="Arial, PingFang SC, Noto Sans CJK SC, sans-serif" font-size="${Math.round(21 * scale)}">${sublineText}</text>
    ${isOutro ? `<rect x="${padding}" y="${sublineY + (sublineLines.length - 1) * Math.round(27 * scale) + Math.round(30 * scale)}" width="${pillWidth}" height="${Math.round(50 * scale)}" rx="${Math.round(25 * scale)}" fill="#d8ffb0"/><text x="${padding + pillWidth / 2}" y="${sublineY + (sublineLines.length - 1) * Math.round(27 * scale) + Math.round(63 * scale)}" text-anchor="middle" fill="#16210f" font-family="Arial, PingFang SC, Noto Sans CJK SC, sans-serif" font-size="${Math.round(16 * scale)}" font-weight="700">${escapeXml(limitLines(wrapText(cta, 14), 1)[0])}</text>` : ''}
  </svg>`);
  if (kind === 'overlay') {
    await sharp(svg).png().toFile(outputPath);
    return;
  }
  const background = await createAspectImage(imagePath, width, height);
  await sharp(background).composite([{ input: svg }]).png().toFile(outputPath);
}

async function createDetailFrame(imagePath, zoom, outputPath, format) {
  const { width, height } = format;
  const base = await createAspectImage(imagePath, width, height);
  const cropWidth = Math.max(2, Math.floor(width / zoom / 2) * 2);
  const cropHeight = Math.max(2, Math.floor(height / zoom / 2) * 2);
  const left = Math.max(0, Math.min(width - cropWidth, Math.round(width * 0.45 - cropWidth / 2)));
  const top = Math.max(0, Math.min(height - cropHeight, Math.round(height * 0.5 - cropHeight / 2)));
  await sharp(base).extract({ left, top, width: cropWidth, height: cropHeight }).resize(width, height).png().toFile(outputPath);
}

function escapeXml(text) {
  return String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    process.stderr.on('data', (data) => { stderr = `${stderr}${data}`.slice(-5000); });
    process.on('error', reject);
    process.on('close', (code) => code === 0 ? resolve() : reject(new Error(`视频合成失败：${stderr.slice(-1200)}`)));
  });
}

async function composeAd(job, selectedAttempts, imagePath, finalPath, format = outputFormats['9:16'], primary = null, softenMatte = job.renderPolicy === softMattePolicy) {
  const temp = await fs.mkdtemp(path.join(storageRoot, 'render-'));
  try {
    const selectedByShot = new Map(selectedAttempts.map((attempt) => [attempt.shotId, attempt]));
    const segments = [];
    const stillTasks = [];
    const actionCut = isActionCut(job.storyboard);
    const cta = actionCut ? job.storyboard.shots.at(-1) : null;
    let detailIndex = 0;
    for (const shot of job.storyboard.shots) {
      const duration = shot.end_seconds - shot.start_seconds;
      if (actionCut && shot.id === 'cta') continue;
      if (shot.kind === 'text') {
        const image = path.join(temp, `${shot.id}.png`);
        stillTasks.push(createCard(imagePath, job.product, shot.id, image, shot, format));
        segments.push({ type: 'still', shotId: shot.id, duration, image, overlay: false });
        continue;
      }
      const attempt = selectedByShot.get(shot.id);
      if (!attempt?.videoUrl) throw new Error(`镜头「${shot.label}」缺少已生成的视频。`);
      const rawPath = path.join(mediaRoot, path.basename(attempt.videoUrl));
      const overlay = path.join(temp, `${shot.id}-overlay.png`);
      if (actionCut) {
        const segment = { type: 'video', shotId: shot.id, duration, rawPath, overlay };
        stillTasks.push(createCard(imagePath, job.product, 'action-copy', overlay, shot, format));
        if (shot.id === 'detail') {
          segment.ctaOffset = duration;
          segment.duration = cta.end_seconds - shot.start_seconds;
          segment.ctaOverlay = path.join(temp, 'cta-overlay.png');
          stillTasks.push(createCard(imagePath, job.product, 'action-cta', segment.ctaOverlay, cta, format));
        }
        segments.push(segment);
        continue;
      }
      stillTasks.push(createCard(imagePath, job.product, 'overlay', overlay, shot, format));
      const rawSeconds = Math.min(duration, job.profile.frames / 24);
      segments.push({ type: 'video', shotId: shot.id, duration: rawSeconds, rawPath, overlay });
      const detailSeconds = duration - rawSeconds;
      if (detailSeconds > 0.02) {
        const image = path.join(temp, `detail-${detailIndex}.png`);
        stillTasks.push(createDetailFrame(imagePath, [1.12, 1.28][detailIndex % 2], image, format));
        segments.push({ type: 'still', shotId: shot.id, duration: detailSeconds, image, overlay });
        detailIndex += 1;
      }
    }
    const analyzeFraming = async () => {
      if (!softenMatte) return {};
      const started = Date.now();
      const framing = await Promise.all(segments.filter((segment) => segment.type === 'video').map(async (segment) => {
        if (job.storyboard.shots.find((shot) => shot.id === segment.shotId)?.reference_mode === 'scene') return { shotId: segment.shotId, crop: null };
        const conditioning = segment.shotId === 'detail' ? job.detailConditioning || job.conditioning : job.conditioning;
        segment.crop = await inspectPersistentMatte(segment.rawPath, conditioning, job.profile);
        return { shotId: segment.shotId, crop: segment.crop };
      }));
      return { framing, framingMs: Date.now() - started };
    };
    const [framingInfo] = await Promise.all([analyzeFraming(), Promise.all(stillTasks)]);

    const inputArgs = [];
    const filters = [];
    const outputLabels = [];
    let inputIndex = 0;
    const centerCrop = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";
    const { width, height } = format;
    const zoom = (expression) => `zoompan=z='${expression}':${centerCrop}:d=1:s=${width}x${height}:fps=24`;
    for (const [index, segment] of segments.entries()) {
      const label = `segment${index}`;
      const expression = index % 2 === 0 ? `min(1+0.001*on,1.045)` : `max(1.045-0.001*on,1)`;
      if (segment.type === 'video') {
        const videoInput = inputIndex++;
        inputArgs.push('-i', segment.rawPath);
        const overlayInput = inputIndex++;
        inputArgs.push('-loop', '1', '-framerate', '24', '-t', String(segment.duration), '-i', segment.overlay);
        const { crop } = segment;
        const cropFilter = crop ? `crop=${crop.width}:${crop.height}:${crop.left}:${crop.top},setsar=1,` : '';
        if (actionCut) {
          const sourceFps = job.profile.fps || 24;
          const scaleTime = (segment.duration - 1 / 24) * sourceFps / (job.profile.frames - 1);
          const retime = `settb=AVTB,setpts=${scaleTime}*(PTS-STARTPTS),`;
          filters.push(`[${videoInput}:v]${cropFilter}${retime}scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=0x141a17,setsar=1,fps=24,trim=duration=${segment.duration},setpts=PTS-STARTPTS[${label}base]`);
          if (segment.ctaOverlay) {
            const ctaInput = inputIndex++;
            inputArgs.push('-loop', '1', '-framerate', '24', '-t', String(segment.duration), '-i', segment.ctaOverlay);
            filters.push(`[${label}base][${overlayInput}:v]overlay=0:0:shortest=1:enable='lt(t,${segment.ctaOffset})'[${label}detail];[${label}detail][${ctaInput}:v]overlay=0:0:shortest=1:enable='gte(t,${segment.ctaOffset})',format=yuv420p[${label}]`);
          } else {
            filters.push(`[${label}base][${overlayInput}:v]overlay=0:0:shortest=1,format=yuv420p[${label}]`);
          }
          outputLabels.push(`[${label}]`);
          continue;
        }
        const backgroundFilter = crop ? 'boxblur=30:12,eq=brightness=-0.22' : 'boxblur=24:12,eq=brightness=-0.32';
        filters.push(`[${videoInput}:v]${cropFilter}deshake=rx=16:ry=16:edge=mirror,split=2[${label}bgsrc][${label}fgsrc];[${label}bgsrc]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},${backgroundFilter}[${label}bg];[${label}fgsrc]scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2[${label}fg];[${label}bg][${label}fg]overlay=(W-w)/2:(H-h)/2,${format.key === '9x16' && !crop ? `${zoom('min(1+0.0012*on,1.06)')},` : ''}trim=duration=${segment.duration},setsar=1,setpts=PTS-STARTPTS,format=yuv420p[${label}base]`);
        filters.push(`[${label}base][${overlayInput}:v]overlay=0:0:shortest=1,format=yuv420p[${label}]`);
      } else {
        const stillInput = inputIndex++;
        inputArgs.push('-loop', '1', '-framerate', '24', '-t', String(segment.duration), '-i', segment.image);
        filters.push(`[${stillInput}:v]${zoom(expression)},trim=duration=${segment.duration},setpts=PTS-STARTPTS,format=yuv420p[${label}base]`);
        if (segment.overlay) {
          const overlayInput = inputIndex++;
          inputArgs.push('-loop', '1', '-framerate', '24', '-t', String(segment.duration), '-i', segment.overlay);
          filters.push(`[${label}base][${overlayInput}:v]overlay=0:0:shortest=1,format=yuv420p[${label}]`);
        } else filters.push(`[${label}base]null[${label}]`);
      }
      outputLabels.push(`[${label}]`);
    }
    filters.push(`${outputLabels.join('')}concat=n=${outputLabels.length}:v=1:a=0[outv]`);

    let narration;
    if (!primary && job.narrationEnabled) {
      updateJob(job, { stage: 'narration', message: '正在生成中文旁白并对齐字幕…' });
      const started = Date.now();
      narration = await prepareNarration(job.storyboard.shots, temp, { voice: job.narrationEngine ? job.narrationVoice : narrationVoice }).catch((error) => {
        console.error('旁白处理失败：', error.message);
        return { warnings: ['旁白与字幕处理失败；已继续合成视频。'], cues: [] };
      });
      logStage(job, 'narration', narration.audioPath ? '中文旁白与字幕已就绪' : '未生成旁白', Date.now() - started);
      narration.warnings.forEach((warning) => logStage(job, 'narration', warning));
      updateJob(job, { stage: 'composition', progress: 97, message: '正在合成广告成片…' });
    }
    const trackArgs = [];
    let trackInputIndex = inputIndex;
    if (primary) {
      inputArgs.push('-i', path.join(mediaRoot, path.basename(primary.videoUrl)));
      trackArgs.push('-map', `${trackInputIndex}:a?`, '-map', `${trackInputIndex}:s?`, '-c:a', 'copy', '-c:s', 'copy');
    }
    if (narration?.audioPath) {
      inputArgs.push('-i', narration.audioPath);
      trackArgs.push('-map', `${trackInputIndex++}:a`, '-c:a', 'aac', '-b:a', '96k', '-metadata:s:a:0', 'language=zho');
    }
    if (narration?.captionPath) {
      inputArgs.push('-i', narration.captionPath);
      trackArgs.push('-map', `${trackInputIndex}:s`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=zho', '-disposition:s:0', '0');
    }
    const started = Date.now();
    const tempVideo = path.join(temp, 'output.mp4');
    await runFfmpeg(['-y', ...inputArgs, '-filter_complex', filters.join(';'), '-map', '[outv]', ...trackArgs, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tempVideo]);
    await fs.rename(tempVideo, finalPath);
    if (primary) return { ...framingInfo, captionsUrl: primary.captionsUrl, renderMs: Date.now() - started };
    if (job.conditioning?.padded && framingInfo.framing) {
      const count = framingInfo.framing.filter((entry) => entry.crop).length;
      logStage(job, 'ffmpeg', count ? `已柔化 ${count}/${framingInfo.framing.length} 个动态镜头的纯色补边` : '未确认纯色边缘，保留原片全幅', framingInfo.framingMs);
    }
    logStage(job, 'ffmpeg', '视频轨道合成完成', Date.now() - started);
    if (!narration) return framingInfo;
    const captionsName = `${job.id}.vtt`;
    if (narration.captionPath) await fs.copyFile(narration.captionPath, path.join(mediaRoot, captionsName));
    return {
      ...framingInfo,
      ...(narration.captionPath ? { captionsUrl: `/media/${captionsName}` } : {}),
      narration: { provider: narration.provider, voice: narration.voice, hasAudio: Boolean(narration.audioPath), cues: narration.cues, warnings: narration.warnings },
    };
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

function primaryOutput(job) {
  return job.outputs?.['9:16'] || (job.videoUrl && !job.compositionWarning && (!job.outputFormat || job.outputFormat === '9:16') ? {
    format: '9:16', width: 576, height: 1024, videoUrl: job.videoUrl, fileName: job.fileName, captionsUrl: job.captionsUrl,
  } : null);
}

async function waitForGeneration(job, workflow, clientId, from, to, shotMessage) {
  const socket = new WebSocket(comfySocketUrl(clientId), { handshakeTimeout: 12_000 });
  let promptId;
  socket.on('error', () => {});
  await new Promise((resolve) => {
    socket.once('open', resolve);
    socket.once('close', resolve);
  });
  socket.on('message', (buffer) => {
    try {
      const event = JSON.parse(buffer.toString());
      if (!promptId || event.data?.prompt_id !== promptId) return;
      if (event.type === 'progress') {
        const value = Number(event.data?.value || 0);
        const max = Math.max(1, Number(event.data?.max || 1));
        updateJob(job, { status: 'generating', stage: 'video_generation', progress: Math.max(job.progress, Math.min(to, from + Math.round(value / max * (to - from)))), message: `${shotMessage} · ${job.model} ${value}/${max} 步` });
      } else if (event.type === 'executing') {
        updateJob(job, { status: 'generating', stage: 'video_generation', progress: Math.max(job.progress, from), message: `${shotMessage} · ${job.model} 正在处理镜头…` });
      }
    } catch {
      // Ignore non-JSON ComfyUI progress frames.
    }
  });
  try {
    const response = await fetch(comfyUrl('prompt'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json();
    if (!response.ok || !body.prompt_id) throw new Error(`ComfyUI 拒绝了工作流：${JSON.stringify(body)}`);
    promptId = body.prompt_id;
    updateJob(job, { comfyPromptId: promptId, status: 'generating', stage: 'video_generation', progress: Math.max(from, job.progress), message: '工作流已排队，等待 GPU…' });

    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      const history = await readComfy(`history/${promptId}`, (response) => response.json(), 10_000);
      const item = history[promptId];
      if (item) {
        if (item.status?.status_str !== 'success') {
          const failure = item.status?.messages?.find(([type]) => type === 'execution_error')?.[1];
          throw new Error(`${job.model} 工作流失败：${failure?.node_type || 'ComfyUI'} ${String(failure?.exception_message || item.status?.status_str || '未知错误').trim().slice(0, 500)}`);
        }
        const result = item.outputs?.['12'] || {};
        const videos = [...(result.videos || []), ...(result.images || []), ...(result.gifs || [])].filter((file) => /\.mp4$/i.test(file.filename || ''));
        if (!videos.length) throw new Error('生成已结束，但 ComfyUI 没有返回视频文件。');
        return videos[0];
      }
      await new Promise((resolve) => setTimeout(resolve, 2200));
    }
    throw new Error('视频生成超过 30 分钟，任务已停止等待。');
  } finally {
    socket.close();
  }
}

async function processJob(job) {
  const started = Date.now();
  job.timings = { ...job.timings, startedAt: new Date(started).toISOString() };
  if (!job.storyboard) {
    updateJob(job, { status: 'preparing', stage: 'planning', message: '正在规划商品分镜…' });
    const planStarted = Date.now();
    const result = await planStoryboard(job.product, job.strategy, job.requestedDuration, job.referencePath, job.model === h3.name);
    if (job.creativeComparison && (result.source !== 'gpt' || result.visualFallbackShots?.length)) {
      throw new Error('固定双镜组的 GPT 分镜生成失败。');
    }
    Object.assign(job, { storyboard: result.storyboard, prompt: result.storyboard.shots.find((shot) => shot.kind === 'wan').visual_prompt, planSource: result.source, planReason: result.reason });
    if (!job.creativeComparison) await updateJob(job, { experimentKey: await buildExperimentKey(job) });
    logStage(job, 'system', result.source === 'gpt' ? 'GPT 广告分镜已生成' : '已采用分镜模板', Date.now() - planStarted);
  }
  const detailAssetId = job.storyboard.shots.find((shot) => shot.id === 'detail')?.reference_asset_id;
  const usesH3 = job.model === h3.name;
  const usesWan14 = job.model === wan14.name;
  const revision = job.userRevision;
  if (revision) {
    await updateJob(job, { status: 'revising', stage: 'prompt_revision', progress: 3, currentShotId: revision.shotId, message: 'GPT 正在把你的意见转成镜头指令…' });
    const rewriteStarted = Date.now();
    const shot = job.storyboard.shots.find((item) => item.id === revision.shotId);
    shot.visual_prompt = await planUserRevision(job, shot);
    await updateJob(job, { userRevision: { ...revision, revisedPrompt: shot.visual_prompt } });
    logStage(job, 'gpt_revision', '人工返工指令已更新，只重新生成指定镜头', Date.now() - rewriteStarted);
  }
  updateJob(job, { status: 'preparing', stage: 'worker', progress: 4, message: '等待 Wan 生成服务就绪…' });
  const configuredStatus = () => creativeModel && creativeModel.name === job.model ? creativeServiceState : serviceState;
  if (configuredStatus().status !== 'ready') await startWorkerBoot();
  if ((usesH3 || usesWan14) && creativeModel?.name !== job.model) await checkModel(job.model);
  else if (configuredStatus().status !== 'ready') throw new Error(configuredStatus().error || '视频生成服务尚未就绪。');
  const imagePath = job.referencePath;
  const referenceStarted = Date.now();
  let framedPath = usesH3 ? imagePath : revision && job.conditioning?.url ? path.join(mediaRoot, path.basename(job.conditioning.url)) : null;
  if (!usesH3 && (!framedPath || !await fs.access(framedPath).then(() => true, () => false))) {
    const { png, alignment } = await makeWanReference(imagePath, job.profile);
    const referenceName = `${job.id}-wan-reference.png`;
    framedPath = path.join(mediaRoot, referenceName);
    await fs.writeFile(framedPath, png);
    const { top, bottom, left, right } = alignment;
    const padded = Boolean(top || bottom || left || right);
    updateJob(job, { conditioning: { ...alignment, padded, url: `/media/${referenceName}` }, message: padded ? '已补边保留完整参考图，正在上传…' : '参考图画幅匹配，正在上传…' });
    logStage(job, 'system', padded ? '参考图已适配竖屏，完整保留原图范围' : '参考图与生成画幅一致，无需补边', Date.now() - referenceStarted);
  } else if (!usesH3) {
    logStage(job, 'system', '沿用原版 Wan 参考帧', Date.now() - referenceStarted);
  }
  const uploaded = await uploadToComfy(framedPath, job.id);
  updateJob(job, { status: 'preparing', stage: 'workflow', progress: 10, message: '商品素材已上传，正在准备生成工作流…' });
  const videoShots = job.storyboard.shots.filter((shot) => shot.kind === 'wan');
  const selectedShots = [];
  const retryFailures = [];
  const maxAttempts = revision || job.mode === 'baseline' ? 1 : 2;
  for (const [shotIndex, shot] of videoShots.entries()) {
    if (revision && revision.shotId !== shot.id) {
      const reused = job.attempts.find((attempt) => attempt.shotId === shot.id && attempt.reused);
      if (!reused) throw new Error(`缺少可沿用的「${shot.label}」原片。`);
      selectedShots.push({ shotId: shot.id, attemptNumber: reused.number, videoUrl: reused.videoUrl, decision: '沿用原版镜头，未重新生成。' });
      continue;
    }
    const shotStart = revision ? 12 : 12 + (76 * shotIndex) / videoShots.length;
    const shotWidth = revision ? 76 : 76 / videoShots.length;
    const separateReference = shot.id === 'detail' && detailAssetId;
    const shotReferencePath = separateReference ? assets.imagePath(detailAssetId) : imagePath;
    let shotUpload = shot.reference_mode === 'scene' ? null : uploaded;
    if (!shotUpload) logStage(job, 'system', `「${shot.label}」从场景描述生成`);
    if (separateReference && usesH3) {
      shotUpload = await uploadToComfy(shotReferencePath, `${job.id}-detail`);
      logStage(job, 'system', '商品特写使用独立参考图');
    } else if (separateReference) {
      const previous = job.detailConditioning?.url;
      let detailPath = previous ? path.join(mediaRoot, path.basename(previous)) : null;
      if (!detailPath || !await fs.access(detailPath).then(() => true, () => false)) {
        const { png, alignment } = await makeWanReference(shotReferencePath, job.profile);
        const name = `${job.id}-detail-reference.png`;
        detailPath = path.join(mediaRoot, name);
        await fs.writeFile(detailPath, png);
        const { top, bottom, left, right } = alignment;
        await updateJob(job, { detailConditioning: { ...alignment, padded: Boolean(top || bottom || left || right), url: `/media/${name}` } });
      }
      shotUpload = await uploadToComfy(detailPath, `${job.id}-detail`);
      logStage(job, 'system', '商品特写使用独立参考图');
    }
    let prompt = shot.visual_prompt;
    let selected;
    let decision;
    for (let shotAttempt = 1; shotAttempt <= maxAttempts; shotAttempt += 1) {
      const number = job.attempts.length + 1;
      const key = `${job.id}-${shot.id}-attempt-${shotAttempt}`;
      const videoUrl = `/media/${key}.mp4`;
      const rawPath = path.join(mediaRoot, `${key}.mp4`);
      const attempt = { number, shotId: shot.id, shotOrder: shot.order, shotLabel: shot.label, shotAttempt, prompt, seed: ((job.seed + shot.order * 104729) % 2_147_483_646) + 1 };
      job.attempts.push(attempt);
      const attemptStart = shotStart + (shotWidth * (shotAttempt - 1)) / maxAttempts;
      const attemptEnd = shotStart + (shotWidth * shotAttempt) / maxAttempts;
      const shotMessage = revision ? `修改「${shot.label}」` : `镜头 ${shotIndex + 1}/${videoShots.length} · ${shot.label}`;
      updateJob(job, { status: 'generating', stage: 'video_generation', progress: Math.round(attemptStart), currentShotId: shot.id, message: `${shotMessage}：提交 ${job.model} 生成` });
      logStage(job, 'wan', `${shotMessage} · ${job.model} 开始生成，第 ${shotAttempt} 次`);
      const begin = Date.now();
      try {
        const buildWorkflow = usesH3 ? makeH3Workflow : usesWan14 ? makeWan14Workflow : makeWorkflow;
        const workflow = buildWorkflow({ ...job.profile, jobId: key, uploadedImage: shotUpload, prompt, seed: attempt.seed, creativeMotion: isActionCut(job.storyboard), textEncoder: wan.textEncoder });
        const output = await waitForGeneration(job, workflow, crypto.randomUUID(), attemptStart, attemptEnd, shotMessage);
        const params = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder || '', type: output.type || 'output' });
        const video = await readComfy(`view?${params}`, (response) => response.arrayBuffer(), 60_000);
        await fs.writeFile(rawPath, Buffer.from(video));
      } catch (error) {
        attempt.error = error.message;
        if (!selected) throw new Error(`${shotMessage}生成失败：${error.message}`);
        retryFailures.push(`${shot.label}返工失败：${error.message}`);
        decision = '返工未生成可用视频，保留首轮。';
        logStage(job, 'wan', `${shotMessage}返工失败，保留首轮原片`);
        break;
      }
      Object.assign(attempt, { videoUrl, generationMs: Date.now() - begin });
      if (!selected) selected = attempt;
      logStage(job, 'wan', `${shotMessage}原片可预览，第 ${shotAttempt} 次`, attempt.generationMs);
      if (job.mode === 'baseline') break;
      updateJob(job, { status: 'reviewing', stage: 'quality_review', progress: Math.round(attemptEnd), currentShotId: shot.id, message: `GPT 正在质检${shotMessage}…` });
      const reviewStarted = Date.now();
      attempt.review = await reviewGeneratedVideo(job, rawPath, shotReferencePath, key, shot);
      attempt.reviewMs = Date.now() - reviewStarted;
      const review = attempt.review;
      logStage(job, 'gpt_review', `${shotMessage}${review.status !== 'completed' ? '质检不可用，需人工检查' : review.approved ? '质检通过' : '质检未通过'}`, attempt.reviewMs);
      if (shotAttempt > 1) {
        const choice = chooseReviewedAttempt(selected, attempt);
        selected = choice.attempt;
        decision = choice.reason;
        logStage(job, 'gpt_revision', `${shotMessage} · 返工取舍：${decision}`);
      }
      if (review.status !== 'completed' || review.approved || shotAttempt === maxAttempts) break;
      if (review.retrySupported === false) {
        decision = '没有足够的可定位证据自动返工，保留首轮，等待人工复核。';
        logStage(job, 'gpt_review', `${shotMessage} · ${decision}`);
        break;
      }
      updateJob(job, { status: 'revising', stage: 'prompt_revision', progress: Math.round(attemptEnd), currentShotId: shot.id, message: `GPT 正根据${shot.label}可见问题修改指令…` });
      const revisionStarted = Date.now();
      try {
        prompt = await revisePrompt(job, attempt);
        logStage(job, 'gpt_revision', `${shotMessage}返工指令已更新，重新生成该镜头`, Date.now() - revisionStarted);
      } catch (error) {
        retryFailures.push(`${shot.label}返工指令失败：${error.message}`);
        decision = '未能生成有效返工指令，保留首轮。';
        logStage(job, 'gpt_revision', `${shotMessage}无法产出返工指令，保留首轮原片`, Date.now() - revisionStarted);
        break;
      }
    }
    if (!selected) throw new Error(`${shot.label}没有可用生成结果。`);
    selectedShots.push({ shotId: shot.id, attemptNumber: selected.number, videoUrl: selected.videoUrl, ...(decision ? { decision } : {}) });
    await updateJob(job, { selectedShots, selectedAttempt: selected.number, progress: Math.max(job.progress, Math.round(shotStart + shotWidth)) });
  }
  if (!selectedShots.length) throw new Error('分镜中没有可用 Wan 镜头。');
  const selectedAttempts = selectedShots.map((item) => job.attempts.find((attempt) => attempt.number === item.attemptNumber));
  const needsReview = job.mode === 'audit' && (retryFailures.length > 0 || selectedAttempts.some((attempt) => !attempt.reused && attempt.review?.approved !== true));
  const retryFailure = retryFailures.length ? retryFailures.join('；') : undefined;
  updateJob(job, { status: 'composing', stage: 'composition', progress: 94, selectedAttempt: (revision ? selectedAttempts.find((attempt) => attempt.shotId === revision.shotId) : selectedAttempts.at(-1)).number, selectedShots, needsReview, retryFailure, message: needsReview ? '正在合成，请随后人工确认未通过的镜头' : '正在合成分镜与 CTA…' });
  const finalPath = path.join(mediaRoot, `${job.id}.mp4`);
  try {
    if (revision && job.narrationEnabled) logStage(job, 'narration', '沿用来源成片的配音与字幕');
    const tracks = await composeAd(job, selectedAttempts, imagePath, finalPath, outputFormats['9:16'], revision?.sourceOutput);
    if (revision) logStage(job, 'ffmpeg', '替换指定镜头并合成新版，原版已保留', tracks.renderMs);
    const output = { format: '9:16', width: 576, height: 1024, videoUrl: `/media/${job.id}.mp4`, fileName: `${safeText(job.product.name, 18)}-广告短片.mp4`, captionsUrl: tracks.captionsUrl, framing: tracks.framing };
    await updateJob(job, { ...tracks, outputs: { '9:16': output }, outputFormat: '9:16', status: 'completed', stage: 'ready', progress: 100, elapsedMs: Date.now() - started, duration: job.storyboard.shots.at(-1).end_seconds, message: revision ? '修改版已合成，原版已保留' : needsReview ? '成片已合成，等待人工确认' : '广告成片已完成', videoUrl: output.videoUrl, fileName: output.fileName, completedAt: new Date().toISOString() });
  } catch (error) {
    updateJob(job, { status: 'completed', stage: 'raw_video', progress: 100, elapsedMs: Date.now() - started, message: '视频已生成；自动合成未完成，保留 Wan 原片', compositionWarning: error.message, videoUrl: (revision ? selectedShots.find((item) => item.shotId === revision.shotId) : selectedShots.at(-1)).videoUrl, fileName: `${safeText(job.product.name, 18)}-Wan原片.mp4`, completedAt: new Date().toISOString() });
  }
}

async function runQueue() {
  if (activeJob || !pendingJobs.length) return;
  activeJob = pendingJobs.shift();
  try {
    await processJob(activeJob);
  } catch (error) {
    updateJob(activeJob, { status: 'failed', stage: 'error', progress: activeJob.progress || 0, message: '生成失败', error: error.message });
  } finally {
    activeJob = null;
    void runQueue();
  }
}

async function askPlanner(input) {
  if (plannerState.status !== 'ready') throw new Error('GPT 策划与质检尚未就绪。');
  return plannerClient.ask(input);
}

async function extractReviewFrames(videoPath, jobId, durationSeconds) {
  const directory = path.join(mediaRoot, `${jobId}-frames`);
  await fs.mkdir(directory, { recursive: true });
  const frames = [];
  const timestamps = [0.05, 0.25, 0.5, 0.75, 0.95].map((fraction) => Number((durationSeconds * fraction).toFixed(2)));
  for (let index = 0; index < timestamps.length; index += 1) {
    const file = path.join(directory, `frame-${index + 1}.jpg`);
    await runFfmpeg(['-y', '-ss', String(timestamps[index]), '-i', videoPath, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '3', file]);
    frames.push({ path: file, time: timestamps[index] });
  }
  return { directory, frames };
}

const reviewScoreKeys = ['product_identity_score', 'prompt_match_score', 'motion_clarity_score', 'artifact_score'];
const reviewIssueKeys = ['time_seconds', 'category', 'severity', 'evidence'];
const reviewResponseSchema = {
  type: 'object',
  properties: {
    ...Object.fromEntries(reviewScoreKeys.map((key) => [key, { type: 'integer', minimum: 1, maximum: 5 }])),
    approved: { type: 'boolean' },
    issues: { type: 'array', maxItems: 3, items: { type: 'object', properties: {
      time_seconds: { type: 'number' },
      category: { type: 'string', enum: ['product_identity', 'prompt_match', 'motion_clarity', 'artifact'] },
      severity: { type: 'string', enum: ['minor', 'major'] },
      evidence: { type: 'string' },
    }, required: reviewIssueKeys, additionalProperties: false } },
    revision_prompt: { type: 'string' },
  },
  required: [...reviewScoreKeys, 'approved', 'issues', 'revision_prompt'], additionalProperties: false,
};

async function reviewGeneratedVideo(job, rawVideoPath, referencePath, attemptKey, shot) {
  if (plannerState.status !== 'ready') return { status: 'error', model: planner.modelId, reason: 'GPT 尚未就绪。', frames: [] };
  let extracted;
  const segmentEnd = isActionCut(job.storyboard) && shot.id === 'detail' ? job.storyboard.shots.at(-1).end_seconds : shot.end_seconds;
  const sourceSeconds = job.profile.frames / (job.profile.fps || 24);
  const visibleSeconds = job.model === wan14.name ? sourceSeconds : Math.min(segmentEnd - shot.start_seconds, sourceSeconds);
  try { extracted = await extractReviewFrames(rawVideoPath, attemptKey, visibleSeconds); }
  catch (error) { return { status: 'error', model: planner.modelId, reason: `无法抽取质检帧：${error.message}`, frames: [] }; }
  const timestamps = extracted.frames.map((frame) => frame.time);
  const facts = job.storyboard?.campaign?.source_facts || [job.product.benefit];
  const prompt = `你是独立广告画面质检员。第 1 张图是商品参考图，之后是按时间顺序抽取的“镜头 ${shot.order}：${shot.label}”生成帧（约 ${timestamps.map((time) => time.toFixed(2)).join('、')} 秒）。先查看全部生成帧，再判断商品动作是否从开始发展到可见结果。该镜头要求：${shot.visual_prompt}。已确认商品事实：${facts.join('；')}。只判断图像可见证据。检查商品是否明显变形、变色或替换，镜头是否匹配要求，以及是否有文字乱码、结构损坏或突兀伪影。不要把镜头移动、背景变化或手接近商品当成商品动作已完成。分数为 1 到 5：5 表示优秀且没有实质问题，4 表示只有轻微问题，3 表示明显但有限的问题，1 表示严重失败。动作结果在任一后段帧中清楚可见时，动作清晰度至少为 4。只有发现明确、可定位的问题才写入 issues；没有明确问题必须返回空数组。issues 中的每条证据须指出时间点和画面中实际看到的缺陷，禁止填写泛化或占位文字。同类 minor 问题对应评分最高为 4，major 问题对应评分最高为 2；若评分与问题列表冲突，先复核全部帧再输出。返回 JSON 对象，包含 product_identity_score、prompt_match_score、motion_clarity_score、artifact_score 四个 1-5 整数分数、approved 布尔值、issues 数组（每项含 time_seconds 数值、category 字符串、severity 为 minor 或 major、evidence 字符串）、revision_prompt 字符串。若动作结果不可见，动作清晰度不得高于 2 且 approved 必须为 false。approved 仅在商品外观保持、动作可辨认且无严重伪影时为 true。无法判断的内容不要臆测。`;
  try {
    const result = await askPlanner({
      system: '你是严格且保守的多模态广告质检模型。以商品参考图为事实依据，不以文案自我证明画面质量。明确区分观察与推测。只输出符合 Schema 的 JSON。',
      prompt,
      imagePaths: [{ path: referencePath, label: '商品参考图' }, ...extracted.frames.map((frame, index) => ({ path: frame.path, label: `生成帧 ${index + 1} · ${frame.time}s` }))],
      maxTokens: 1000,
      schema: reviewResponseSchema,
    });
    for (const key of ['product_identity_score', 'prompt_match_score', 'motion_clarity_score', 'artifact_score']) if (!Number.isInteger(result[key]) || result[key] < 1 || result[key] > 5) throw new Error(`质检返回无效分数：${key}`);
    if (typeof result.approved !== 'boolean' || !Array.isArray(result.issues) || typeof result.revision_prompt !== 'string') throw new Error('质检结果结构不完整。');
    if (result.issues.some((issue) => !Number.isFinite(Number(issue.time_seconds)) || !['minor', 'major'].includes(issue.severity) || typeof issue.category !== 'string' || typeof issue.evidence !== 'string')) throw new Error('质检问题缺少有效等级或可定位的证据。');
    const review = {
      status: 'completed',
      model: planner.modelId,
      productIdentityScore: Math.max(1, Math.min(5, Number(result.product_identity_score) || 1)),
      promptMatchScore: Math.max(1, Math.min(5, Number(result.prompt_match_score) || 1)),
      motionClarityScore: Math.max(1, Math.min(5, Number(result.motion_clarity_score) || 1)),
      artifactScore: Math.max(1, Math.min(5, Number(result.artifact_score) || 1)),
      approved: Boolean(result.approved),
      issues: Array.isArray(result.issues) ? result.issues.slice(0, 5) : [],
      revisionPrompt: safeText(result.revision_prompt, 500),
      frames: extracted.frames.map((frame) => ({ time: frame.time, url: `/media/${attemptKey}-frames/${path.basename(frame.path)}` })),
    };
    const endingCheck = await inspectEnding(askPlanner, { productName: job.product.name, facts, referencePath, frame: extracted.frames.at(-1) });
    return applyEndingEvidence(review, endingCheck);
  } catch (error) {
    return { status: 'error', model: planner.modelId, reason: error.message, frames: extracted.frames.map((frame) => ({ time: frame.time, url: `/media/${attemptKey}-frames/${path.basename(frame.path)}` })) };
  }
}

async function revisePrompt(job, attempt) {
  const shot = job.storyboard.shots.find((item) => item.id === attempt.shotId);
  const actionCut = isActionCut(job.storyboard);
  const revision = await askPlanner({
    system: '你是负责按质检证据修改 Wan 图生视频提示词的广告导演。保留原来要展示的明确产品动作和商品身份约束，只针对问题改写。动作不明显时要增强动作幅度和起止状态，不得退化成静止产品图。只返回 JSON，格式严格为 {"prompt":"..."}。prompt 值使用英文，不得添加画面文字或商品事实。',
    prompt: `镜头 ${shot.order}（${shot.label}）：${shot.visual_prompt}\n本次实际指令：${attempt.prompt}\n质检问题：${JSON.stringify(attempt.review.issues)}\n质量分：商品 ${attempt.review.productIdentityScore}/5，匹配 ${attempt.review.promptMatchScore}/5，动作清晰度 ${attempt.review.motionClarityScore}/5，伪影 ${attempt.review.artifactScore}/5\n模型建议：${attempt.review.revisionPrompt || '按上述可观察的问题明确修正动作表现。'}\n商品参考图和 Wan 参数保持不变。保留本镜头具体产品动作，不用文字、光影或背景描述替代动作；加强动作的起点、过程和可见结果。保持商品外观一致、只出现单个主体、排除可见文字和 Logo。返回 {"prompt":"英文提示词"}。`,
    maxTokens: 450,
    schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
  });
  const value = cleanEnglishPrompt(revision.prompt);
  if (value.length < 20 || value === cleanEnglishPrompt(attempt.prompt)) throw new Error('GPT 未返回有效的新英文画面指令，已停止返工。');
  const guardrail = 'Show one clear, continuous product action with a visible start and end. Keep exactly one product with the same silhouette, color and details as the reference. Do not create readable text, letters, numbers, labels, logos, subtitles or watermarks anywhere in the frame.';
  return actionCut ? value : `${value} ${guardrail}`;
}

async function planUserRevision(job, shot) {
  const { feedback, originalPrompt } = job.userRevision;
  const { prompt } = await askPlanner({
    system: 'You are a video director rewriting ONE shot for image-to-video. Fulfill the editor’s requested change, including substitutions of action or camera movement. Keep unrelated details, the same single product from the reference image, and its visible design. Do not add text, logos or unsupported product claims. Return a JSON object with one field, prompt, written in concise English.',
    prompt: `Editor feedback: ${JSON.stringify(feedback)}\nPrevious camera direction: ${JSON.stringify(originalPrompt)}\nTarget duration: ${Math.min(shot.end_seconds - shot.start_seconds, job.profile.frames / 24).toFixed(1)} seconds. Write two or three short sentences describing camera behavior and visible start, action, and end. If the feedback asks for a stationary camera, say it explicitly and remove any contradictory camera movement. The image is the product reference.`,
    imagePaths: [job.referencePath],
    maxTokens: 260,
    schema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'], additionalProperties: false },
  });
  const rewritten = cleanEnglishPrompt(prompt);
  if (rewritten.length < 20 || rewritten === cleanEnglishPrompt(originalPrompt)) throw new Error('GPT 未生成有效的新镜头指令，请把修改意见写得更具体后重试。');
  return rewritten;
}

app.use(express.json({ limit: '2mb' }));
app.use('/media', express.static(mediaRoot, { fallthrough: false, immutable: true, maxAge: '1h' }));
mountExperiments(app, {
  jobs, mediaRoot, evaluationsRoot, primaryOutput,
  async renderOpening(file) {
    const name = `${path.parse(file).name}-blind-opening-2s.mp4`;
    const output = path.join(mediaRoot, name);
    if (await fs.access(output).then(() => true, () => false)) return name;
    const temp = path.join(mediaRoot, `.${crypto.randomUUID()}.mp4`);
    try {
      await runFfmpeg(['-y', '-i', path.join(mediaRoot, file), '-t', '2', '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', temp]);
      await fs.rename(temp, output);
      return name;
    } finally {
      await fs.rm(temp, { force: true });
    }
  },
  async renderFirstRound(audit, attempts) {
    if (runningExports.has(audit.id)) return null;
    runningExports.add(audit.id);
    try {
      const primary = primaryOutput(audit);
      const filename = `${audit.id}-first-round-v1.mp4`;
      const tracks = await composeAd(audit, attempts, audit.referencePath, path.join(mediaRoot, filename), outputFormats['9:16'], primary);
      const output = { ...primary, ...tracks, videoUrl: `/media/${filename}`, fileName: `${safeText(audit.product.name, 18)}-首轮基线.mp4` };
      await updateJob(audit, { firstRoundOutput: output });
      return output;
    } finally {
      runningExports.delete(audit.id);
    }
  },
});
app.get('/api/status', (_request, response) => {
  response.json({
    service: serviceState,
    videoModel: wanModel,
    creativeVideoModel: creativeModel?.name || wanModel,
    creativeService: creativeServiceState || serviceState,
    planner: plannerState,
    narration: narrationStatus(),
    profile,
    queue: { waiting: pendingJobs.length, activeJobId: activeJob?.id || null },
  });
});

app.get('/api/jobs', (_request, response) => {
  const items = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
  response.json({ jobs: items.map(publicJob) });
});

app.get('/api/jobs/:id', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).json({ error: '任务不存在。' });
  return response.json({ job: publicJob(job) });
});

app.post('/api/jobs/:id/recompose', async (request, response) => {
  const job = jobs.get(request.params.id);
  const formatName = request.body?.format || '9:16';
  const format = Object.hasOwn(outputFormats, formatName) ? outputFormats[formatName] : null;
  if (!format) return response.status(400).json({ error: '画幅只支持 9:16、1:1 或 16:9。' });
  const style = request.body?.style || 'original';
  if (!['original', 'soft-matte'].includes(style)) return response.status(400).json({ error: '未知的画面处理方式。' });
  const voiceVersionId = request.body?.voiceVersionId;
  const voiceVersion = job?.narrationVersions?.find((item) => item.id === voiceVersionId);
  if (voiceVersionId !== undefined && !voiceVersion) return response.status(404).json({ error: '未找到这个配音版本。' });
  if (!job || job.status !== 'completed' || !job.selectedShots?.length || !job.referencePath || runningExports.has(job.id)) return response.status(409).json({ error: '任务尚无可用原片，或正在导出另一个画幅。' });
  const selectedAttempts = job.selectedShots.map((selected) => job.attempts.find((attempt) => attempt.number === selected.attemptNumber));
  if (selectedAttempts.some((attempt) => !attempt?.videoUrl)) return response.status(409).json({ error: '至少一个分镜原片不存在，无法重新合成。' });
  runningExports.add(job.id);
  try {
    const primary = primaryOutput(job);
    const hasFile = (candidate) => candidate && fs.access(path.join(mediaRoot, path.basename(candidate.videoUrl))).then(() => true, () => false);
    if (style === 'soft-matte' && job.renderPolicy !== softMattePolicy) {
      if (!job.conditioning?.padded) return response.status(409).json({ error: '这条成片没有可追踪的补边区域。' });
      const audioSource = voiceVersion ? Object.values(voiceVersion.outputs).find((output) => output.format === '9:16') || Object.values(voiceVersion.outputs)[0] : primary;
      if (!await hasFile(audioSource)) return response.status(409).json({ error: '原成片或指定配音版不存在，无法保留音轨。' });
      const voiceKey = voiceVersion?.id || 'original';
      const outputs = job.softenedOutputs?.[voiceKey] || {};
      if (await hasFile(outputs[formatName])) return response.json({ job: publicJob(job), output: outputs[formatName], reused: true });
      const videoName = `${job.id}-soft-matte-${voiceKey}-${format.key}.mp4`;
      const tracks = await composeAd(job, selectedAttempts, job.referencePath, path.join(mediaRoot, videoName), format, audioSource, true);
      const output = { format: formatName, width: format.width, height: format.height, videoUrl: `/media/${videoName}`, fileName: `${safeText(job.product.name, 18)}-背景柔化-${format.key}.mp4`, ...tracks };
      await updateJob(job, { softenedOutputs: { ...job.softenedOutputs, [voiceKey]: { ...outputs, [formatName]: output } } });
      return response.json({ job: publicJob(job), output, reused: false });
    }
    if (primary && job.videoUrl !== primary.videoUrl) await updateJob(job, { ...primary, outputs: { ...job.outputs, '9:16': primary }, outputFormat: '9:16' });
    const existingVersion = voiceVersion?.outputs[formatName];
    if (await hasFile(existingVersion)) return response.json({ job: publicJob(job), output: existingVersion, reused: true });
    let output = formatName === '9:16' ? primary : job.outputs?.[formatName];
    const reuseOriginal = await hasFile(output);
    if (!reuseOriginal) {
      if (!primary && formatName !== '9:16') return response.status(409).json({ error: '请先重新合成 9:16 竖屏，再从竖屏复用配音和字幕。' });
      const videoName = formatName === '9:16' ? `${job.id}.mp4` : `${job.id}-${format.key}-v2.mp4`;
      const tracks = await composeAd(job, selectedAttempts, job.referencePath, path.join(mediaRoot, videoName), format, formatName !== '9:16' ? primary : job.userRevision?.sourceOutput);
      output = { format: formatName, width: format.width, height: format.height, videoUrl: `/media/${videoName}`, fileName: `${safeText(job.product.name, 18)}-${format.key}.mp4`, captionsUrl: tracks.captionsUrl, renderMs: tracks.renderMs, framing: tracks.framing };
      await updateJob(job, {
        outputs: { ...(job.outputs || {}), ...(primary ? { '9:16': primary } : {}), [formatName]: output },
        ...(formatName === '9:16' ? { ...tracks, videoUrl: output.videoUrl, fileName: output.fileName, outputFormat: '9:16', stage: 'ready', recoveredComposition: true, message: job.needsReview ? '成片已合成，等待人工确认' : '广告成片已完成', compositionWarning: undefined, duration: job.storyboard.shots.at(-1).end_seconds } : {}),
      });
    }
    if (!voiceVersion) return response.json({ job: publicJob(job), output, reused: Boolean(reuseOriginal) });
    const donor = Object.values(voiceVersion.outputs).find((item) => item.videoUrl !== existingVersion?.videoUrl) || voiceVersion.outputs['9:16'];
    if (!await hasFile(donor)) return response.status(409).json({ error: '该配音版本的音轨文件缺失，请重新配音。' });
    const temp = await fs.mkdtemp(path.join(storageRoot, 'render-dub-format-'));
    try {
      const videoName = `${job.id}-voice-${voiceVersion.id}-${format.key}.mp4`;
      await copyNarrationTracks(path.join(mediaRoot, path.basename(output.videoUrl)), path.join(mediaRoot, path.basename(donor.videoUrl)), path.join(temp, videoName));
      await fs.rename(path.join(temp, videoName), path.join(mediaRoot, videoName));
      const dubbed = { ...output, videoUrl: `/media/${videoName}`, fileName: `${safeText(job.product.name, 18)}-新版配音-${format.key}.mp4`, captionsUrl: donor.captionsUrl };
      const revised = { ...voiceVersion, outputs: { ...voiceVersion.outputs, [formatName]: dubbed } };
      await updateJob(job, { narrationVersions: job.narrationVersions.map((item) => item.id === voiceVersion.id ? revised : item) });
      return response.json({ job: publicJob(job), output: dubbed, reused: false });
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
    }
  } catch (error) {
    if (style === 'original' && formatName === '9:16' && !voiceVersion) await updateJob(job, { stage: 'raw_video', compositionWarning: error.message });
    return response.status(500).json({ error: error.message, job: publicJob(job) });
  } finally {
    runningExports.delete(job.id);
  }
});

app.post('/api/narration/preview', async (request, response) => {
  const { text: raw, duration, voice = narrationVoice } = request.body || {};
  const text = normalizeSpeech(raw);
  if (!text || !validSpeech(raw) || typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0.5 || duration > 15 || typeof voice !== 'string' || !Object.hasOwn(voicePresets, voice)) return response.status(400).json({ error: '请填写 1–120 字口播，并选择有效时长和音色。' });
  if (!narrationStatus().available) return response.status(503).json({ error: '本机的高质量配音模型未安装。' });
  const temp = await fs.mkdtemp(path.join(storageRoot, 'render-voice-preview-'));
  try {
    const clip = await previewNarration(text, duration, temp, voice);
    return response.set('Cache-Control', 'no-store').json({ audio: `data:audio/wav;base64,${(await fs.readFile(clip.audioPath)).toString('base64')}`, fits: Boolean(clip.pcm), naturalSeconds: clip.naturalSeconds });
  } catch (error) {
    return response.status(502).json({ error: error.message });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

app.post('/api/jobs/:id/narration', async (request, response) => {
  const job = jobs.get(request.params.id);
  const original = job && primaryOutput(job);
  if (!job || job.status !== 'completed' || !original || !job.storyboard?.shots?.length) return response.status(409).json({ error: '需要先生成一条有完整画面的成片。' });
  if (runningExports.has(job.id)) return response.status(409).json({ error: '此任务正在制作另一个导出版本。' });
  const { voice = narrationVoice, lines } = request.body || {};
  if (typeof voice !== 'string' || !Object.hasOwn(voicePresets, voice) || !lines || typeof lines !== 'object' || Array.isArray(lines)) return response.status(400).json({ error: '口播内容或音色不合法。' });
  if (Object.keys(lines).length !== job.storyboard.shots.length || !job.storyboard.shots.every((shot) => Object.hasOwn(lines, shot.id) && validSpeech(normalizeSpeech(lines[shot.id])) && typeof lines[shot.id] === 'string' && lines[shot.id].length <= 120)) return response.status(400).json({ error: '口播必须与原分镜一一对应，每段不超过 120 字。' });
  const shots = job.storyboard.shots.map((shot) => ({ ...shot, voiceover: normalizeSpeech(lines[shot.id]) }));
  if (!shots.some((shot) => shot.voiceover)) return response.status(400).json({ error: '至少填写一段口播。' });
  if (!narrationStatus().available) return response.status(503).json({ error: '本机的高质量配音模型未安装。' });
  const id = crypto.randomUUID();
  runningExports.add(job.id);
  let temp;
  try {
    const started = Date.now();
    temp = await fs.mkdtemp(path.join(storageRoot, 'render-redub-'));
    const narration = await prepareNarration(shots, temp, { voice, strict: true });
    if (!narration.audioPath) return response.status(422).json({ error: narration.warnings.join(' ') || '未能生成口播，请精简文案后重试。' });
    const outputs = {};
    const captionsName = `${job.id}-voice-${id}.vtt`;
    const formats = { ...job.outputs, '9:16': original };
    const outputFiles = [];
    for (const [name, base] of Object.entries(formats)) {
      if (!Object.hasOwn(outputFormats, name)) continue;
      const videoName = `${job.id}-voice-${id}-${outputFormats[name].key}.mp4`;
      await muxNarration(path.join(mediaRoot, path.basename(base.videoUrl)), path.join(temp, videoName), narration);
      outputFiles.push(videoName);
      outputs[name] = { ...base, videoUrl: `/media/${videoName}`, fileName: `${safeText(job.product.name, 18)}-新版配音-${outputFormats[name].key}.mp4`, captionsUrl: `/media/${captionsName}` };
    }
    await fs.copyFile(narration.captionPath, path.join(temp, captionsName));
    for (const file of [...outputFiles, captionsName]) await fs.rename(path.join(temp, file), path.join(mediaRoot, file));
    const version = { id, voice, provider: narrationProvider, createdAt: new Date().toISOString(), elapsedMs: Date.now() - started, cues: narration.cues, warnings: narration.warnings, outputs };
    await updateJob(job, { narrationVersions: [...(job.narrationVersions || []), version] });
    return response.status(201).json({ job: publicJob(job), version });
  } catch (error) {
    console.error('重配音失败：', error.message);
    return response.status(502).json({ error: '重配音失败，原成片已保留。' });
  } finally {
    runningExports.delete(job.id);
    if (temp) await fs.rm(temp, { recursive: true, force: true });
  }
});

app.get('/api/jobs/:id/events', (request, response) => {
  const job = jobs.get(request.params.id);
  if (!job) return response.status(404).json({ error: '任务不存在。' });
  subscribeToJob(job, response);
});

app.post('/api/plan', async (request, response) => {
  try {
    const product = normalizeProduct(request.body?.product || request.body);
    const duration = Number(request.body?.duration);
    const proposal = request.body?.proposal == null ? null : normalizeProposal(request.body.proposal);
    if (proposal && duration !== actionCutSeconds) throw new Error('创意提案适用于 8 秒广告。');
    const asset = duration === actionCutSeconds && request.body?.assetId ? await assets.load(request.body.assetId) : null;
    if (duration === actionCutSeconds && request.body?.assetId && !asset) throw new Error('所选商品参考图不存在。');
    const reference = asset ? assets.imagePath(asset.id) : sampleImage;
    const result = await planStoryboard(product, request.body?.strategy, [15, actionCutSeconds].includes(duration) ? duration : 7, reference, creativeModel === h3, proposal);
    if (creativeModel === wan14 && isActionCut(result.storyboard)) {
      for (const shot of result.storyboard.shots) delete shot.reference_mode;
    }
    if ((proposal || product.creativeGoal) && (result.source !== 'gpt' || result.visualFallbackShots?.length)) {
      return response.status(502).json({ error: '未能按广告目标生成完整的画面指令。请重试，或清空目标后使用普通分镜。' });
    }
    return response.json({ ...result, plan: storyboardToScenes(result.storyboard), selectedProposal: proposal });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.post('/api/creative-proposals', async (request, response) => {
  try {
    const product = normalizeProduct(request.body?.product || request.body);
    const asset = request.body?.assetId ? await assets.load(request.body.assetId) : null;
    if (request.body?.assetId && !asset) throw new Error('所选商品参考图不存在。');
    const reference = asset ? assets.imagePath(asset.id) : sampleImage;
    if (plannerState.status !== 'ready') return response.status(503).json({ error: '创意提案需要先接通 GPT。', planner: plannerState });
    const result = await proposeCreatives(askPlanner, product, reference);
    return response.json({ ...result, model: planner.modelId, reasoningEffort: planner.reasoningEffort });
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

function normalizeSeed(value) {
  const seed = Number(value);
  return Number.isInteger(seed) && seed > 0 && seed < 2 ** 31 ? seed : crypto.randomInt(1, 2 ** 31 - 1);
}

function createJob({ product, storyboard, mode, narrationEnabled, seed, asset, batchId, pairedRunId, strategy, requestedDuration }) {
  const date = new Date().toISOString();
  const actionCut = isActionCut(storyboard) || (!storyboard && requestedDuration === actionCutSeconds);
  const model = actionCut ? creativeModel : null;
  return {
    id: crypto.randomUUID(), status: 'queued', stage: 'queued', progress: 0,
    message: pendingJobs.length || activeJob ? '加入 GPU 任务队列…' : '准备制作广告短片…',
    createdAt: date, updatedAt: date, product, storyboard,
    prompt: storyboard?.shots.find((shot) => shot.kind === 'wan')?.visual_prompt,
    mode, narrationEnabled, narrationVoice, narrationEngine: narrationModelId, revisionPolicy, referencePolicy, renderPolicy: softMattePolicy, seed,
    profile: model?.profile || (actionCut ? { ...profile, frames: 97 } : profile),
    logs: [], attempts: [],
    referencePath: asset ? assets.imagePath(asset.id) : sampleImage, assetId: asset?.id, batchId, pairedRunId, strategy, requestedDuration,
    model: model?.name || wanModel, plannerModel: planner.modelId, timings: { queuedAt: date },
  };
}

async function queueJobs(items) {
  const saved = [];
  try {
    for (const job of items) {
      const filename = path.join(jobsRoot, `${job.id}.json`);
      saved.push(filename);
      await fs.writeFile(filename, JSON.stringify(job, null, 2), { flag: 'wx' });
    }
  } catch (error) {
    await Promise.all(saved.map((filename) => fs.rm(filename, { force: true })));
    throw error;
  }
  for (const job of items) jobs.set(job.id, job);
  pendingJobs.push(...items);
  void runQueue();
}

function withReferenceUpload(request, response, next) {
  upload.single('reference')(request, response, (error) => {
    if (error) return response.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? '参考图不能超过 18 MB。' : '无法读取参考图。' });
    next();
  });
}

app.get('/api/assets', async (_request, response) => {
  response.json({ assets: await assets.list() });
});

app.get('/api/assets/:id/image', async (request, response) => {
  const asset = await assets.load(request.params.id);
  if (!asset) return response.status(404).json({ error: '素材不存在。' });
  return response.sendFile(assets.imagePath(asset.id), { immutable: true, maxAge: '24h' });
});

app.post('/api/assets', withReferenceUpload, async (request, response) => {
  if (!request.file) return response.status(400).json({ error: '请选择一张商品图。' });
  try {
    const result = await assets.save(request.file.buffer, request.file.originalname);
    return response.status(result.reused ? 200 : 201).json(result);
  } catch (error) { return response.status(400).json({ error: error.message }); }
});

function publicBatchList() {
  const batches = new Map();
  for (const job of [...jobs.values()].reverse()) {
    if (!job.batchId) continue;
    let batch = batches.get(job.batchId);
    if (!batch) {
      batch = { id: job.batchId, createdAt: job.createdAt, jobs: [] };
      batches.set(job.batchId, batch);
    }
    const { id, status, stage, progress, message, error, compositionWarning, product, assetId, videoUrl, fileName, needsReview } = job;
    batch.jobs.unshift({ id, status, stage, progress, message, error, compositionWarning, name: product.name, assetId, videoUrl, fileName, needsReview });
  }
  return [...batches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 15);
}

app.get('/api/batches', (_request, response) => response.json({ batches: publicBatchList() }));

app.post('/api/batches', async (request, response) => {
  try {
    const { items, mode = 'audit', narration = true, duration = 15, strategy = 'daily' } = request.body || {};
    if (!Array.isArray(items) || items.length < 2 || items.length > 8) throw new Error('一次批量制作需要 2–8 件商品。');
    if (!['audit', 'baseline'].includes(mode) || ![7, 15].includes(duration) || typeof narration !== 'boolean') throw new Error('批量任务的模式、时长或旁白设置无效。');
    if (serviceState.status !== 'ready' || (mode === 'audit' && plannerState.status !== 'ready')) return response.status(503).json({ error: '生成服务未就绪，请稍后提交。' });
    const batchId = crypto.randomUUID();
    const jobsToQueue = [];
    for (const [index, item] of items.entries()) {
      const { name, benefit, audience, callToAction, tone, hook, prompt } = item?.product || {};
      if (![name, benefit].every((field) => typeof field === 'string' && safeText(field))) throw new Error(`第 ${index + 1} 件商品缺少名称或卖点。`);
      const asset = await assets.load(item.assetId);
      if (!asset) throw new Error(`第 ${index + 1} 件商品需要选择已保存的参考图。`);
      const product = normalizeProduct({ name, benefit, audience: safeText(audience, 80) || '对该商品感兴趣的人群', callToAction: safeText(callToAction, 90) || '了解产品', tone: safeText(tone, 40) || '自然日常', hook: safeText(hook, 90) || '换个角度看这件好物', prompt: safeText(prompt, 1000) || 'Make a clear reveal of the single product in the reference. Track smoothly from a three-quarter angle toward the front, keeping the object fully in frame and its design unchanged.' });
      jobsToQueue.push(createJob({ product, mode, narrationEnabled: narration, seed: normalizeSeed(item.seed), asset, batchId, strategy, requestedDuration: duration }));
    }
    await queueJobs(jobsToQueue);
    return response.status(202).json({ batchId, jobIds: jobsToQueue.map((job) => job.id) });
  } catch (error) { return response.status(400).json({ error: error.message }); }
});

app.post('/api/generate', withReferenceUpload, async (request, response) => {
  try {
    const product = normalizeProduct(JSON.parse(request.body.product || '{}'));
    const mode = request.body.mode || 'audit';
    if (!['baseline', 'audit', 'compare', 'creative-compare'].includes(mode)) throw new Error('生成策略无效。');
    const storyboard = validateBoard(JSON.parse(request.body.storyboard || 'null'));
    const chosenService = isActionCut(storyboard) && creativeModel ? creativeServiceState : serviceState;
    if (creativeModel === wan14 && isActionCut(storyboard) && storyboard.shots.some((shot) => shot.reference_mode === 'scene')) {
      return response.status(400).json({ error: 'Wan 14B 图生视频需要为每个动态镜头选择起始参考图。' });
    }
    if (chosenService.status !== 'ready') return response.status(503).json({ error: chosenService.message });
    const detailAssetId = storyboard.shots.find((shot) => shot.id === 'detail')?.reference_asset_id;
    if (detailAssetId && !(await assets.load(detailAssetId))) throw new Error('指定的特写参考图不存在。');
    if (product.creativeGoal && product.creativeGoal !== storyboard.campaign.objective) throw new Error('广告目标已变更，请先更新分镜。');
    if (mode !== 'baseline' && plannerState.status !== 'ready') return response.status(503).json({ error: '闭环质检需要接通 GPT。可切换单模型基线进行测试。', planner: plannerState });
    storyboard.campaign.product_name = product.name;
    storyboard.campaign.audience = product.audience;
    storyboard.campaign.tone = product.tone;
    storyboard.campaign.source_facts = [product.benefit].filter(Boolean);
    if (!storyboard.shots.some((shot) => shot.kind === 'wan' && shot.visual_prompt.trim())) return response.status(400).json({ error: '请先填写主镜头画面指令。' });
    if (request.file && request.body.assetId) throw new Error('上传图片和素材引用只能选择一种。');
    const asset = request.file ? (await assets.save(request.file.buffer, request.file.originalname)).asset : await assets.load(request.body.assetId);
    if (request.body.assetId && !asset) throw new Error('选中的素材不存在。');
    const seed = normalizeSeed(request.body.seed);
    if (mode === 'creative-compare') {
      if (!isActionCut(storyboard) || creativeModel !== h3 || storyboard.shots.some((shot) => shot.reference_mode || shot.reference_asset_id)) {
        throw new Error('创意对照需要 H3、8 秒分镜，且所有动态镜头使用同一张商品参考图。');
      }
      const proposal = normalizeProposal(JSON.parse(request.body.proposal || 'null'));
      const strategy = request.body.strategy || 'daily';
      if (!['daily', 'feature', 'offer'].includes(strategy)) throw new Error('创意类型无效。');
      const shared = {
        product, mode: 'audit', narrationEnabled: request.body.narration !== 'false',
        seed, asset, pairedRunId: crypto.randomUUID(), strategy, requestedDuration: actionCutSeconds,
      };
      const baseline = createJob(shared);
      const treatment = createJob({ ...shared, storyboard });
      const planning = Object.fromEntries(['proposalMs', 'storyboardMs'].flatMap((key) => {
        const ms = Number(request.body[key]);
        return Number.isFinite(ms) && ms > 0 && ms <= 600_000 ? [[key, ms]] : [];
      }));
      baseline.creativeComparison = { arm: 'baseline' };
      treatment.creativeComparison = { arm: 'audit', proposal, ...planning };
      const key = await buildExperimentKey(baseline);
      const items = crypto.randomInt(2) ? [baseline, treatment] : [treatment, baseline];
      for (const job of items) job.experimentKey = key;
      await queueJobs(items);
      return response.status(202).json({ job: publicJob(items[0]), jobs: items.map(publicJob) });
    }
    const modes = mode === 'compare' ? (crypto.randomInt(2) ? ['baseline', 'audit'] : ['audit', 'baseline']) : [mode];
    const pairedRunId = modes.length === 2 ? crypto.randomUUID() : undefined;
    const items = modes.map((strategy) => createJob({ product, storyboard, mode: strategy, narrationEnabled: request.body.narration !== 'false', seed, asset, pairedRunId }));
    const key = await buildExperimentKey(items[0]);
    items.forEach((job) => { job.experimentKey = key; });
    await queueJobs(items);
    return response.status(202).json({ job: publicJob(items[0]), jobs: items.map(publicJob) });
  } catch (error) { return response.status(400).json({ error: error.message || '无法创建生成任务。' }); }
});

app.post('/api/jobs/:id/shot-revisions', async (request, response) => {
  const source = jobs.get(request.params.id);
  const { shotId, feedback, voiceVersionId } = request.body || {};
  if (typeof feedback !== 'string' || !safeText(feedback, 300) || feedback.length > 300) return response.status(400).json({ error: '请填写不超过 300 字的镜头修改意见。' });
  if (!source || source.status !== 'completed' || !primaryOutput(source) || !source.referencePath) return response.status(409).json({ error: '请先完成一条广告成片。' });
  const shot = source.storyboard?.shots?.find((item) => item.id === shotId && item.kind === 'wan');
  if (!shot) return response.status(400).json({ error: '请选择原成片中的一个动态镜头。' });
  const voiceVersion = voiceVersionId && source.narrationVersions?.find((item) => item.id === voiceVersionId);
  if (voiceVersionId && !voiceVersion?.outputs?.['9:16']) return response.status(404).json({ error: '该配音版本没有可用的竖屏成片。' });
  const revisionService = creativeModel?.name === source.model ? creativeServiceState : serviceState;
  if (revisionService?.status !== 'ready' || plannerState.status !== 'ready') return response.status(503).json({ error: '视频生成或 GPT 服务尚未就绪，请稍后重试。' });
  try {
    const sourceOutput = voiceVersion ? voiceVersion.outputs['9:16'] : primaryOutput(source);
    const storyboard = validateBoard(structuredClone(source.storyboard));
    const originals = storyboard.shots.filter((item) => item.kind === 'wan').map((item) => {
      const selected = source.selectedShots?.find((entry) => entry.shotId === item.id);
      return source.attempts?.find((attempt) => attempt.number === selected?.attemptNumber && attempt.shotId === item.id);
    });
    if (originals.some((attempt) => !attempt?.videoUrl)) return response.status(409).json({ error: '原成片的镜头素材不完整。' });
    const original = originals.find((attempt) => attempt.shotId === shotId);
    const mediaPaths = [sourceOutput.videoUrl, sourceOutput.captionsUrl, ...originals.map((attempt) => attempt.videoUrl)].filter(Boolean);
    try { await Promise.all([source.referencePath, ...mediaPaths.map((url) => path.join(mediaRoot, path.basename(url)))].map((file) => fs.access(file))); }
    catch { return response.status(409).json({ error: '原成片、字幕或镜头文件已找不到，无法保留原素材。' }); }
    if (voiceVersion) for (const item of storyboard.shots) item.voiceover = voiceVersion.cues.find((cue) => cue.shotId === item.id)?.text || '';
    const job = createJob({ product: structuredClone(source.product), storyboard, mode: 'audit', narrationEnabled: Boolean(voiceVersion || source.narrationEnabled), seed: normalizeSeed(null) });
    Object.assign(job, {
      referencePath: source.referencePath, assetId: source.assetId, profile: source.profile || profile, model: source.model || wanModel,
      conditioning: source.conditioning, detailConditioning: source.detailConditioning, referencePolicy: source.referencePolicy, renderPolicy: source.renderPolicy,
      narration: voiceVersion || source.narration, narrationVoice: voiceVersion?.voice || source.narrationVoice,
      attempts: originals.filter((attempt) => attempt.shotId !== shotId).map((attempt, index) => ({ ...structuredClone(attempt), number: index + 1, reused: true })),
      userRevision: { sourceJobId: source.id, shotId, shotLabel: shot.label, feedback: safeText(feedback, 300), originalPrompt: original.prompt || shot.visual_prompt, originalClipUrl: original.videoUrl, sourceOutput },
    });
    await queueJobs([job]);
    return response.status(202).json({ job: publicJob(job) });
  } catch (error) {
    console.error('单镜修改提交失败：', error.message);
    return response.status(500).json({ error: '无法提交镜头修改，原成片仍可用。' });
  }
});

app.post('/api/reconnect', (_request, response) => {
  serviceState = { status: 'starting', message: '正在重新连接 Wan 服务…', gpu: null, error: null };
  void startWorkerBoot();
  queuePlannerStart();
  response.status(202).json({ status: 'starting' });
});

app.use(express.static(path.join(appRoot, 'dist')));
app.get('/blind/:id', (_request, response) => response.sendFile(path.join(appRoot, 'dist', 'index.html')));

app.listen(apiPort, '127.0.0.1', () => {
  console.log(`Ad Studio API listening at http://127.0.0.1:${apiPort}`);
  void startWorkerBoot();
  queuePlannerStart();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    comfyTunnel?.kill('SIGTERM');
    stopNarration();
    process.exit(0);
  });
}
