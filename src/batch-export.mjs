export const batchFormats = { '9:16': '竖屏 · 9:16', '1:1': '方形 · 1:1', '16:9': '横屏 · 16:9' };
export const deliverableJobs = (batch) => batch?.jobs.filter((job) => job.status === 'completed' && job.videoUrl && !job.compositionWarning) || [];

function fileStem(name) {
  const cleaned = String(name || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(cleaned).slice(0, 48).join('').replace(/[ .]+$/, '') || '商品';
}

async function json(request, path, options) {
  const response = await request(path, options);
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || '暂时无法读取任务，请重试。');
  return data;
}

async function media(request, url, contentType, label) {
  if (!url?.startsWith('/media/')) throw new Error(`${label}地址不可用。`);
  const response = await request(url);
  if (!response.ok || !response.headers.get('content-type')?.startsWith(contentType)) throw new Error(`无法读取${label}。`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length) throw new Error(`${label}为空。`);
  return bytes;
}

export async function createBatchArchive({ batch, format, onProgress = () => {}, request = fetch }) {
  if (!Object.hasOwn(batchFormats, format)) throw new Error('请选择支持的画幅。');
  const jobs = deliverableJobs(batch);
  if (!jobs.length) throw new Error('这个批次还没有可导出的成片。');
  const entries = {};
  const ratio = format.replace(':', 'x');
  let captionCount = 0;

  for (const [index, item] of jobs.entries()) {
    onProgress({ index: index + 1, total: jobs.length, name: item.name });
    try {
      const route = `/api/jobs/${encodeURIComponent(item.id)}`;
      const { job } = await json(request, route);
      const voiceVersionId = job.narrationVersions?.at(-1)?.id;
      const { output } = await json(request, `${route}/recompose`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format, voiceVersionId }),
      });
      if (output?.format !== format) throw new Error('导出画幅与所选画幅不一致。');
      const base = `${String(index + 1).padStart(2, '0')}-${fileStem(item.name)}-${ratio}`;
      // Fetch together so a missing VTT fails the export instead of silently dropping it.
      const [video, captions] = await Promise.all([
        media(request, output.videoUrl, 'video/mp4', '视频'),
        output.captionsUrl ? media(request, output.captionsUrl, 'text/vtt', '字幕') : null,
      ]);
      entries[`${base}.mp4`] = video;
      if (captions) {
        entries[`${base}.vtt`] = captions;
        captionCount++;
      }
    } catch (error) {
      throw new Error(`${item.name}：${error.message}`);
    }
  }
  onProgress({ packing: true, total: jobs.length });
  const { zipSync } = await import('fflate');
  return {
    data: zipSync(entries, { level: 0 }),
    name: `MarketFilm-${batch.id.slice(0, 8)}-${ratio}.zip`,
    count: jobs.length,
    captionCount,
  };
}
