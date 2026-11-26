export const h3 = {
  name: 'MiniMax H3 Ref2VA',
  profile: { width: 480, height: 864, frames: 124, steps: 4 },
  unet: 'minimax_h3_ref2va_pruned_fp8_scaled.safetensors',
  encoder: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors',
  videoVae: 'minimax_h3_video_vae_fp16.safetensors',
  audioVae: 'minimax_h3_audio_vae_fp32.safetensors',
  lora: 'minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors',
};

export function makeH3Workflow({ jobId, uploadedImage, prompt, seed, width, height, frames, steps }) {
  const node = (class_type, inputs) => ({ class_type, inputs });
  return {
    '1': node('UNETLoader', { unet_name: h3.unet, weight_dtype: 'default' }),
    '2': node('CLIPLoader', { clip_name: h3.encoder, type: 'minimax', device: 'default' }),
    '3': node('VAELoader', { vae_name: h3.videoVae }),
    '4': node('VAELoader', { vae_name: h3.audioVae }),
    ...(uploadedImage ? { '5': node('LoadImage', { image: uploadedImage.name }) } : {}),
    '6': node('MiniMaxH3ReferenceToVideo', {
      clip: ['2', 0], vae: ['3', 0], audio_vae: ['4', 0],
      ...(uploadedImage ? { 'ref_images.ref_image_0': ['5', 0] } : {}),
      prompt: uploadedImage ? `Use <Picture 1> as the product design reference. ${prompt}` : prompt,
      width, height, length: frames, ref_image_size: 'match',
    }),
    '7': node('RandomNoise', { noise_seed: seed }),
    '8': node('KSamplerSelect', { sampler_name: 'res_multistep' }),
    '9': node('BasicScheduler', { model: ['14', 0], scheduler: 'simple', steps, denoise: 1 }),
    '10': node('BasicGuider', { model: ['14', 0], conditioning: ['6', 0] }),
    '11': node('SamplerCustomAdvanced', { noise: ['7', 0], guider: ['10', 0], sampler: ['8', 0], sigmas: ['9', 0], latent_image: ['6', 1] }),
    '12': node('SaveVideo', { video: ['13', 0], filename_prefix: `market-film/${jobId}`, format: 'auto', codec: 'auto' }),
    '13': node('CreateVideo', { images: ['15', 0], fps: 24 }),
    '14': node('LoraLoaderModelOnly', { model: ['1', 0], lora_name: h3.lora, strength_model: 1 }),
    '15': node('VAEDecode', { samples: ['11', 0], vae: ['3', 0] }),
  };
}
