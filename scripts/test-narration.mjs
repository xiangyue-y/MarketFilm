import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';
import { muxNarration, prepareNarration } from '../server/narration.mjs';
import { stopNarration } from '../server/tts.mjs';

const execFile = promisify(execFileCallback);
const runFfmpeg = async (args) => execFile(ffmpegPath, ['-hide_banner', ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-studio-narration-test-'));

try {
  const shots = [
    { id: 'hook', label: '情境钩子', start_seconds: 0, end_seconds: 2, copy: '带上温暖。' },
    { id: 'hero', label: '产品主视觉', start_seconds: 2, end_seconds: 5, copy: '磨砂质感', voiceover: '北屿随行杯，轻松出发。' },
    { id: 'cta', label: '行动引导', start_seconds: 5, end_seconds: 7, copy: '轻松通勤。' },
  ];
  const result = await prepareNarration(shots, temp, { strict: true });
  assert.equal(result.cues.length, shots.length, 'every storyboard line should be retained for subtitles');
  assert.ok(result.cues.every((cue) => cue.spoken), 'all default sample lines should fit their shot windows');
  assert.ok(result.audioPath, 'Chinese narration audio should be generated');
  assert.ok(result.captionPath, 'a WebVTT subtitle file should be generated');
  const captions = await fs.readFile(result.captionPath, 'utf8');
  assert.ok(captions.startsWith('WEBVTT\n'));
  assert.ok(captions.includes(shots[1].voiceover), 'captions should follow the editable voiceover rather than screen copy');

  const silentVideo = path.join(temp, 'silent.mp4');
  const finalVideo = path.join(temp, 'final.mp4');
  await runFfmpeg(['-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=24:d=7', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '7', '-y', silentVideo]);
  await muxNarration(silentVideo, finalVideo, result);
  const inspection = await runFfmpeg(['-i', finalVideo, '-f', 'null', '-']);
  const diagnostics = `${inspection.stdout}\n${inspection.stderr}`;
  assert.match(diagnostics, /Audio: aac/i, 'finished MP4 should contain AAC audio');
  assert.match(diagnostics, /Subtitle: mov_text/i, 'finished MP4 should contain selectable subtitles');
  console.log(`Narration test passed: ${result.cues.length} spoken scenes, AAC audio and selectable MP4 subtitles (${result.voice}).`);
} finally {
  stopNarration();
  await fs.rm(temp, { recursive: true, force: true });
}
