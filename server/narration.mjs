import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { narrationProvider, narrationVoice, synthesizeSpeech } from './tts.mjs';

const execFile = promisify(execFileCallback);
const sampleRate = 24000;
const pause = 0.08;
const maxTempo = 1.32;
const ffmpeg = (args) => execFile(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: 30_000 });
const vttTime = (seconds) => {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3_600_000)).padStart(2, '0')}:${String(Math.floor(ms / 60_000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
const vttText = (text) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
export const normalizeSpeech = (text) => typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
export const validSpeech = (text) => typeof text === 'string' && text.length <= 120 && (!text || /[\p{L}\p{N}]/u.test(text));

async function renderSpeech(text, slot, directory, name, voice, playable = false) {
  const raw = path.join(directory, `${name}-raw.wav`);
  const pcm = path.join(directory, `${name}.pcm`);
  await synthesizeSpeech(text, raw, voice);
  await ffmpeg(['-i', raw, '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', pcm]);
  const naturalSeconds = (await fs.stat(pcm)).size / (2 * sampleRate);
  if (!naturalSeconds) throw new Error('配音模型返回了空音频。');
  const tempo = Math.max(1, naturalSeconds / slot);
  if (tempo > maxTempo) return { naturalSeconds, ...(playable ? { audioPath: raw } : {}) };
  const result = { naturalSeconds, pcm, tempo, seconds: naturalSeconds / tempo };
  if (playable) {
    const output = path.join(directory, `${name}.wav`);
    await ffmpeg(['-i', raw, '-af', `atempo=${tempo.toFixed(6)}`, output]);
    result.audioPath = output;
  }
  return result;
}

export async function previewNarration(text, duration, directory, voice = narrationVoice) {
  return renderSpeech(text, duration - 2 * pause, directory, 'preview', voice, true);
}

export async function prepareNarration(shots, directory, { voice = narrationVoice, strict = false } = {}) {
  const duration = shots.at(-1).end_seconds;
  const cues = [];
  const inputs = [];
  const filters = [];
  const warnings = [];
  let voiceUnavailable = false;
  for (const [index, shot] of shots.entries()) {
    const text = normalizeSpeech(shot.voiceover ?? shot.copy);
    if (!text) continue;
    const start = shot.start_seconds + pause;
    const limit = shot.end_seconds - pause;
    const cue = { shotId: shot.id, text, start, end: limit, spoken: false };
    cues.push(cue);
    if (!validSpeech(text) || voiceUnavailable) continue;
    let rendered;
    try {
      rendered = await renderSpeech(text, limit - start, directory, `voice-${index}`, voice);
    } catch (error) {
      if (strict) throw error;
      voiceUnavailable = true;
      warnings.push(`${error.message} 未配音的镜头保留字幕。`);
      continue;
    }
    if (!rendered.pcm) {
      warnings.push(`「${shot.label}」口播约 ${rendered.naturalSeconds.toFixed(1)} 秒，无法自然读完，已保留字幕。可缩短文案后重试。`);
      continue;
    }
    const tag = `voice${inputs.length}`;
    const inputIndex = inputs.length;
    inputs.push(['-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', rendered.pcm]);
    filters.push(`[${inputIndex}:a]atempo=${rendered.tempo.toFixed(6)},asetpts=PTS-STARTPTS,adelay=${Math.round(start * 1000)}[${tag}]`);
    cue.end = Math.min(limit, start + rendered.seconds);
    cue.spoken = true;
  }

  let audioPath;
  if (inputs.length) {
    audioPath = path.join(directory, 'narration.wav');
    const labels = inputs.map((_, index) => `[voice${index}]`).join('');
    filters.push(`${labels}amix=inputs=${inputs.length}:duration=longest:normalize=0,apad=whole_dur=${duration}[voice]`);
    await ffmpeg([...inputs.flat(), '-filter_complex', filters.join(';'), '-map', '[voice]', '-t', String(duration), audioPath]);
  }
  let captionPath;
  if (cues.length) {
    captionPath = path.join(directory, 'captions.vtt');
    const segments = cues.map(({ start, end, text }) => `${vttTime(start)} --> ${vttTime(end)}\n${vttText(text)}`);
    await fs.writeFile(captionPath, `WEBVTT\n\n${segments.join('\n\n')}\n`);
  }
  return { audioPath, captionPath, cues, warnings, voice, provider: narrationProvider };
}

export async function muxNarration(source, target, narration) {
  const inputs = ['-i', source];
  let index = 1;
  if (narration.audioPath) { inputs.push('-i', narration.audioPath); index++; }
  if (narration.captionPath) inputs.push('-i', narration.captionPath);
  const outputOptions = ['-map', '0:v:0', '-c:v', 'copy'];
  if (narration.audioPath) outputOptions.push('-map', '1:a:0', '-c:a', 'aac', '-b:a', '96k', '-metadata:s:a:0', 'language=zho');
  if (narration.captionPath) outputOptions.push('-map', `${index}:s:0`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=zho', '-disposition:s:0', '0');
  await ffmpeg([...inputs, ...outputOptions, '-movflags', '+faststart', target]);
}

export async function copyNarrationTracks(video, dubbed, target) {
  await ffmpeg(['-i', video, '-i', dubbed, '-map', '0:v:0', '-map', '1:a:0', '-map', '1:s:0', '-c', 'copy', '-movflags', '+faststart', target]);
}
