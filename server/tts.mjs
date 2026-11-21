import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const python = process.env.TTS_PYTHON || path.join(project, '.models/tts-venv/bin/python');
const model = process.env.TTS_MODEL_PATH || path.join(project, '.models/qwen3-tts');
export const narrationProvider = 'Qwen3-TTS 1.7B · MLX';
export const narrationModelId = 'qwen3-tts-1.7b-customvoice-8bit';
export const voicePresets = { serena: '温柔女声', vivian: '明亮女声', uncle_fu: '沉稳男声' };
export const narrationVoice = Object.hasOwn(voicePresets, process.env.TTS_VOICE || '') ? process.env.TTS_VOICE : 'serena';
const readingStyle = '用清晰自然的普通话念广告旁白。像在给朋友介绍好物，语气亲切，节奏利落，停顿简短，不要拖长句尾。';

let worker;
let startup;
let running;
let waiting = 0;
let sequence = 0;
let queue = Promise.resolve();
let failure;

function installed() {
  return process.platform === 'darwin' && process.arch === 'arm64' && [python, path.join(model, 'model.safetensors'), path.join(model, 'speech_tokenizer/model.safetensors'), path.join(model, 'config.json')].every(existsSync);
}

export function narrationStatus() {
  const available = installed();
  return { provider: narrationProvider, voice: narrationVoice, voices: voicePresets, available, ready: Boolean(worker && !startup), status: failure ? 'error' : startup ? 'loading' : worker ? 'ready' : available ? 'standby' : 'missing' };
}

function start() {
  if (startup) return startup;
  if (worker) return Promise.resolve();
  if (!installed()) return Promise.reject(new Error('高质量配音模型未安装，请在 Mac 上运行语音安装命令。'));
  failure = undefined;
  const child = spawn(python, ['-u', fileURLToPath(new URL('./tts-worker.py', import.meta.url)), model], {
    env: { ...process.env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  worker = child;
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-1800); });
  startup = new Promise((resolve, reject) => {
    const failed = (message) => {
      if (worker !== child) return;
      clearTimeout(timer);
      worker = undefined;
      startup = undefined;
      failure = new Error(message);
      running?.finish(failure);
      reject(failure);
      if (stderr) console.error('Qwen3-TTS:', stderr.trim());
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => failed('本机配音模型启动超时。'), 90_000);
    child.once('error', () => failed('无法启动本机配音模型。'));
    child.once('exit', () => failed('本机配音进程已退出，请重试。'));
    child.stdin.on('error', () => failed('本机配音进程无法接收请求。'));
    lines.on('line', (line) => {
      let result;
      try { result = JSON.parse(line); } catch { return; }
      if (result.ready) {
        clearTimeout(timer);
        startup = undefined;
        resolve();
      } else if (running && result.id === running.id) {
        if (result.error) console.error('Qwen3-TTS synthesis:', result.error);
        running.finish(result.ok ? null : new Error('配音生成失败，请精简文案后重试。'));
      }
    });
  });
  return startup;
}

export function synthesizeSpeech(text, output, voice = narrationVoice) {
  if (!Object.hasOwn(voicePresets, voice)) return Promise.reject(new Error('不支持这个配音音色。'));
  if (waiting >= 12) return Promise.reject(new Error('配音队列繁忙，请稍后重试。'));
  waiting++;
  const work = queue.then(async () => {
    await start();
    await new Promise((resolve, reject) => {
      const id = ++sequence;
      const child = worker;
      if (!child || !child.stdin.writable) return reject(new Error('本机配音进程已退出，请重试。'));
      const timer = setTimeout(() => {
        finish(new Error('本机配音超时，请缩短文案后重试。'));
        child.kill('SIGKILL');
      }, 90_000);
      function finish(error) {
        clearTimeout(timer);
        if (running?.id === id) running = undefined;
        if (error) reject(error);
        else resolve();
      }
      running = { id, finish };
      child.stdin.write(`${JSON.stringify({ id, text, output, voice, style: readingStyle })}\n`);
    });
  }).finally(() => { waiting--; });
  queue = work.catch(() => {});
  return work;
}

export function stopNarration() { worker?.kill('SIGTERM'); }
