import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const validId = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function cleanLabel(originalName) {
  const raw = path.basename(originalName || '参考图');
  const decoded = /^[\x00-\xff]*$/.test(raw) ? Buffer.from(raw, 'latin1').toString('utf8') : raw;
  return (decoded.includes('\uFFFD') ? raw : decoded).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 110) || '参考图';
}

export function createAssetLibrary(directory) {
  const imagePath = (id) => path.join(directory, `${id}.png`);
  const publicAsset = (asset) => ({ ...asset, url: `/api/assets/${asset.id}/image` });
  async function load(id) {
    if (!validId(id)) return null;
    try {
      const asset = JSON.parse(await fs.readFile(path.join(directory, `${id}.json`), 'utf8'));
      return asset.id === id ? publicAsset({ ...asset, label: cleanLabel(asset.label) }) : null;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  async function list() {
    const files = await fs.readdir(directory);
    const assets = await Promise.all(files.filter((file) => file.endsWith('.json')).map((file) => load(file.slice(0, -5))));
    return assets.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async function save(buffer, originalName) {
    let processed;
    try {
      const image = sharp(buffer, { failOn: 'error', limitInputPixels: 24_000_000 });
      const { format, pages } = await image.metadata();
      if (!['png', 'jpeg', 'webp'].includes(format) || (pages || 1) > 1) throw new Error('unsupported image');
      processed = await image.rotate().resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true });
    } catch {
      throw new Error('参考图须为可解码的静态 PNG、JPEG 或 WebP，且不超过 2400 万像素。');
    }
    const id = crypto.createHash('sha256').update(processed.data).digest('hex');
    const existing = await load(id);
    if (existing) return { asset: existing, reused: true };
    const label = cleanLabel(originalName);
    const asset = { id, label, width: processed.info.width, height: processed.info.height, createdAt: new Date().toISOString() };
    const tmp = `${id}-${crypto.randomUUID()}`;
    try {
      await fs.writeFile(path.join(directory, `${tmp}.png`), processed.data);
      await fs.rename(path.join(directory, `${tmp}.png`), imagePath(id));
      await fs.writeFile(path.join(directory, `${tmp}.tmp`), JSON.stringify(asset));
      await fs.rename(path.join(directory, `${tmp}.tmp`), path.join(directory, `${id}.json`));
      return { asset: publicAsset(asset), reused: false };
    } finally {
      await Promise.all(['.png', '.tmp'].map((ext) => fs.rm(path.join(directory, `${tmp}${ext}`), { force: true })));
    }
  }
  return { load, list, save, imagePath };
}
