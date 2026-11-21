import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';

const execFile = promisify(execFileCallback);
const reduction = 4;
const tolerance = 12;
const margin = 8;
const edges = ['top', 'bottom', 'left', 'right'];

function usableGeometry(alignment, profile) {
  const { width, height, frames } = profile || {};
  if (![width, height].every((n) => Number.isInteger(n) && n % reduction === 0 && n >= 128 && n <= 1024)
    || !Number.isInteger(frames) || frames < 2 || frames > 180 || width !== alignment?.width || height !== alignment?.height) return false;
  return edges.every((key) => Number.isInteger(alignment[key]) && alignment[key] >= 0)
    && alignment.left + alignment.contentWidth + alignment.right === width
    && alignment.top + alignment.contentHeight + alignment.bottom === height
    && alignment.contentWidth >= 128 && alignment.contentHeight >= 128;
}

// Each candidate line must stay near-uniform in all decoded frames, and close to
// the color at its own outer edge. Limit the search to padding recorded at input.
export function detectPersistentMatte(pixels, alignment, profile) {
  if (!usableGeometry(alignment, profile)) return null;
  const w = profile.width / reduction, h = profile.height / reduction;
  const stride = w * h * 3;
  if (pixels.length !== stride * profile.frames) return null;
  const crop = {};
  for (const edge of edges) {
    const max = Math.floor(alignment[edge] / reduction);
    if (!max) { crop[edge] = 0; continue; }
    const horizontal = edge === 'top' || edge === 'bottom';
    const outer = edge === 'top' || edge === 'left' ? 0 : (horizontal ? h - 1 : w - 1);
    const sign = outer === 0 ? 1 : -1;
    const length = horizontal ? w : h;
    const indices = (axis, along) => horizontal ? (axis * w + along) * 3 : (along * w + axis) * 3;
    let accepted = 0;
    line: for (let distance = 0; distance < max; distance++) {
      const axis = outer + sign * distance;
      for (let frame = 0; frame < profile.frames; frame++) {
        const start = frame * stride;
        for (let channel = 0; channel < 3; channel++) {
          const center = pixels[start + indices(outer, Math.floor(length / 2)) + channel];
          let low = 255, high = 0;
          for (let position = 0; position < length; position++) {
            const value = pixels[start + indices(axis, position) + channel];
            if (value < low) low = value;
            if (value > high) high = value;
          }
          if (high - low > tolerance || Math.max(high - center, center - low) > tolerance + reduction) break line;
        }
      }
      accepted = distance + 1;
    }
    const cut = accepted * reduction - margin;
    crop[edge] = cut >= 16 ? cut : 0;
  }
  if (!edges.some((edge) => crop[edge] > 0)) return null;
  return { ...crop, width: profile.width - crop.left - crop.right, height: profile.height - crop.top - crop.bottom, verifiedFrames: profile.frames };
}

export async function inspectPersistentMatte(file, alignment, profile) {
  if (!alignment?.padded || !usableGeometry(alignment, profile)) return null;
  const w = profile.width / reduction, h = profile.height / reduction;
  try {
    const { stdout } = await execFile(ffmpeg, ['-v', 'error', '-i', file, '-an', '-sn', '-vf', `scale=${w}:${h}:flags=area,format=rgb24`, '-frames:v', String(profile.frames + 1), '-threads', '1', '-f', 'rawvideo', 'pipe:1'], {
      encoding: 'buffer', maxBuffer: w * h * 3 * (profile.frames + 1) + 4096, timeout: 10_000,
    });
    return detectPersistentMatte(stdout, alignment, profile);
  } catch {
    // A diagnostic failure must not block delivery or cause an unverified crop.
    return null;
  }
}
