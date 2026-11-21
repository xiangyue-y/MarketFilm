import sharp from 'sharp';

export const referencePolicy = 'contain-edge-matte-v1';

function edgeColor(pixels, width, height, horizontalEdge, far) {
  const colors = [[], [], []];
  const length = horizontalEdge ? width : height;
  const depth = Math.min(5, horizontalEdge ? height : width);
  for (let space = 0; space < length; space += Math.max(1, Math.floor(length / 128))) {
    for (let line = 0; line < depth; line += 1) {
      const x = horizontalEdge ? space : far ? width - 1 - line : line;
      const y = horizontalEdge ? far ? height - 1 - line : line : space;
      const offset = (y * width + x) * 3;
      colors.forEach((samples, channel) => samples.push(pixels[offset + channel]));
    }
  }
  return Buffer.from(colors.map((channel) => channel.sort((a, b) => a - b)[Math.floor(channel.length / 2)]));
}

export async function makeWanReference(input, { width, height }) {
  const image = sharp(input, { failOn: 'error', limitInputPixels: 24_000_000 });
  const meta = await image.metadata();
  const sourceWidth = meta.autoOrient?.width ?? meta.width;
  const sourceHeight = meta.autoOrient?.height ?? meta.height;
  const { data, info } = await image.rotate().toColourspace('srgb').flatten({ background: '#eef0f4' })
    .resize(width, height, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const left = Math.floor((width - info.width) / 2);
  const top = Math.floor((height - info.height) / 2);
  const right = width - info.width - left;
  const bottom = height - info.height - top;
  let pixels = data;
  if (left || top || right || bottom) {
    pixels = Buffer.alloc(width * height * 3);
    const verticalPadding = top + bottom > 0;
    const near = edgeColor(data, info.width, info.height, verticalPadding, false);
    const far = edgeColor(data, info.width, info.height, verticalPadding, true);
    for (let y = 0; y < height; y += 1) {
      const offset = y * width * 3;
      if (y < top || y >= top + info.height) {
        pixels.fill(y < top ? near : far, offset, offset + width * 3);
      } else {
        const start = (y - top) * info.width * 3;
        pixels.fill(near, offset, offset + left * 3);
        data.copy(pixels, offset + left * 3, start, start + info.width * 3);
        pixels.fill(far, offset + (left + info.width) * 3, offset + width * 3);
      }
    }
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return { png, alignment: { sourceWidth, sourceHeight, width, height, contentWidth: info.width, contentHeight: info.height, left, top, right, bottom } };
}
