export const wan14 = {
  name: 'Wan 2.2 I2V A14B FP8',
  profile: { width: 576, height: 1024, frames: 49, fps: 16, steps: 20 },
  highNoise: 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors',
  lowNoise: 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors',
  vae: 'wan_2.1_vae.safetensors',
};

export function makeWan14Workflow({ jobId, uploadedImage, prompt, seed, width, height, frames, fps, steps, textEncoder }) {
  const node = (class_type, inputs) => ({ class_type, inputs });
  const crossover = Math.floor(steps / 2);
  const sample = (initial) => node('KSamplerAdvanced', {
    model: [initial ? '8' : '9', 0], add_noise: initial ? 'enable' : 'disable',
    noise_seed: seed, steps, cfg: 3.5, sampler_name: 'euler', scheduler: 'simple',
    positive: ['10', 0], negative: ['10', 1], latent_image: initial ? ['10', 2] : ['11', 0],
    start_at_step: initial ? 0 : crossover, end_at_step: initial ? crossover : steps,
    return_with_leftover_noise: initial ? 'enable' : 'disable',
  });
  return {
    '1': node('UNETLoader', { unet_name: wan14.highNoise, weight_dtype: 'default' }),
    '2': node('UNETLoader', { unet_name: wan14.lowNoise, weight_dtype: 'default' }),
    '3': node('CLIPLoader', { clip_name: textEncoder, type: 'wan', device: 'cpu' }),
    '4': node('VAELoader', { vae_name: wan14.vae }),
    '5': node('LoadImage', { image: uploadedImage.name }),
    '6': node('CLIPTextEncode', { clip: ['3', 0], text: prompt }),
    '7': node('CLIPTextEncode', { clip: ['3', 0], text: 'heavy artifacts, duplicated product, watermark' }),
    '8': node('ModelSamplingSD3', { model: ['1', 0], shift: 8 }),
    '9': node('ModelSamplingSD3', { model: ['2', 0], shift: 8 }),
    '10': node('WanImageToVideo', {
      positive: ['6', 0], negative: ['7', 0], vae: ['4', 0], start_image: ['5', 0],
      width, height, length: frames, batch_size: 1,
    }),
    '11': sample(true),
    '12': node('SaveVideo', { video: ['15', 0], filename_prefix: `market-film/${jobId}`, format: 'auto', codec: 'auto' }),
    '13': sample(false),
    '14': node('VAEDecode', { samples: ['13', 0], vae: ['4', 0] }),
    '15': node('CreateVideo', { images: ['14', 0], fps }),
  };
}
