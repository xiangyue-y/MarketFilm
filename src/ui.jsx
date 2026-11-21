export const imageAsset = '/product-tumbler.png';
export const clockLabel = (seconds) => {
  const whole = Math.max(0, Math.floor(seconds || 0));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
};
export function StatusDot({ state }) {
  return <span className={`status-dot ${state === 'ready' ? 'is-ready' : state === 'error' ? 'is-error' : 'is-pending'}`} />;
}

export function originalOutputs(job) {
  return job?.outputs || (job?.videoUrl && !job.compositionWarning ? { '9:16': { videoUrl: job.videoUrl, fileName: job.fileName, captionsUrl: job.captionsUrl } } : {});
}
