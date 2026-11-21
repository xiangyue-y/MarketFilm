export const defaultProduct = Object.freeze({
  name: '北屿随行杯',
  audience: '城市通勤人群',
  benefit: '磨砂质感，轻松随行',
  callToAction: '开启轻松通勤',
  tone: '清新日常',
  hook: '把一杯温暖，带进忙碌的一天。',
  prompt: 'A commuter’s hand reaches in from the right and grips the matte green tumbler around its middle. The hand lifts the tumbler well above the countertop so a clear gap opens beneath the base, then holds it upright in frame, with the original black lid and matte green body clearly visible.',
});

function secondsLabel(seconds) {
  const value = Math.max(0, Math.round(seconds));
  return `00:${String(value).padStart(2, '0')}`;
}

export function storyboardToScenes(storyboard) {
  return storyboard.shots.map((shot) => ({
    id: shot.id,
    order: String(shot.order).padStart(2, '0'),
    label: shot.label,
    time: `${secondsLabel(shot.start_seconds)}–${secondsLabel(shot.end_seconds)}`,
    kind: shot.kind,
    text: shot.copy,
    voiceover: shot.voiceover ?? shot.copy,
    detail: shot.visual_prompt,
    purpose: shot.purpose,
  }));
}
