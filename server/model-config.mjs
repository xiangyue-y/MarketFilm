function modelUrl(value, key) {
  const url = URL.parse(value);
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${key} 必须是 HTTP(S) 服务地址，不含凭据、查询参数或片段。`);
  }
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function portValue(value, fallback, key) {
  const port = Number(value || fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${key} 必须是有效端口。`);
  return port;
}

export function wanConfig(env = process.env) {
  const directUrl = env.WAN_COMFY_URL?.trim();
  const sshHost = directUrl ? '' : env.WAN_SSH_HOST?.trim() || '';
  const localPort = sshHost ? portValue(env.WAN_LOCAL_PORT, 18188, 'WAN_LOCAL_PORT') : undefined;
  const remotePort = sshHost ? portValue(env.WAN_REMOTE_PORT, 8188, 'WAN_REMOTE_PORT') : undefined;
  const remoteComfyDir = env.WAN_REMOTE_COMFY_DIR;
  const remotePython = env.WAN_REMOTE_PYTHON;
  const remoteWorkDir = env.WAN_REMOTE_WORK_DIR;
  const managed = Boolean(sshHost && (remoteComfyDir || remotePython || remoteWorkDir));
  const minFreeVram = Number(env.WAN_GPU_MIN_FREE_MIB || 22000);
  if (managed) {
    if (![remoteComfyDir, remotePython, remoteWorkDir].every((file) => file?.startsWith('/'))) {
      throw new Error('需要自动启动远端 ComfyUI 时，WAN_REMOTE_COMFY_DIR、WAN_REMOTE_PYTHON、WAN_REMOTE_WORK_DIR 必须全部设置为远端绝对路径。');
    }
    if (!Number.isInteger(minFreeVram) || minFreeVram < 1) throw new Error('WAN_GPU_MIN_FREE_MIB 必须为正整数。');
  }
  return {
    baseUrl: modelUrl(directUrl || `http://127.0.0.1:${localPort || 8188}`, 'WAN_COMFY_URL'),
    sshHost, localPort, remotePort, managed, remoteComfyDir, remotePython, remoteWorkDir, minFreeVram,
    unet: env.WAN_UNET || 'wan2.2_ti2v_5B_fp16.safetensors',
    textEncoder: env.WAN_TEXT_ENCODER || 'umt5_xxl_fp8_e4m3fn_scaled.safetensors',
    vae: env.WAN_VAE || 'wan2.2_vae.safetensors',
  };
}

export function plannerConfig(env = process.env) {
  return {
    baseUrl: modelUrl(env.PLANNER_BASE_URL?.trim() || 'https://api.openai.com/v1', 'PLANNER_BASE_URL'),
    modelId: env.PLANNER_MODEL_ID?.trim() || 'gpt-6.2-sol',
    reasoningEffort: env.PLANNER_REASONING_EFFORT?.trim() || 'high',
    token: env.PLANNER_API_KEY?.trim(),
  };
}
