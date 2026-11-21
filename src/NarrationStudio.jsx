import { useState } from 'react';
import { AudioLines, LoaderCircle, Volume2 } from 'lucide-react';

export function VoicePreview({ text = '', duration, voice, disabled = false }) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);
  const key = JSON.stringify([text, duration, voice]);
  const current = result?.key === key ? result : null;
  async function listen() {
    setPending(true);
    setResult(null);
    try {
      const response = await fetch('/api/narration/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, duration, voice }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '试听生成失败。');
      setResult({ ...data, key });
    } catch (error) { setResult({ error: error.message, key }); }
    finally { setPending(false); }
  }
  return <div className="voice-preview">
    <button className="button button-secondary" type="button" disabled={disabled || pending || !text.trim() || !duration} onClick={listen}>{pending ? <LoaderCircle className="spin" size={15} /> : <Volume2 size={15} />}{pending ? '正在生成试听…' : '试听本镜口播'}</button>
    {current?.audio && <audio src={current.audio} controls aria-label="本镜口播试听" preload="metadata" />}
    {current && !current.fits && <p role="status" className="warning-copy">{current.error || `这句约 ${current.naturalSeconds.toFixed(1)} 秒，超过本镜可用时长。缩短文案后再生成。`}</p>}
  </div>;
}

export default function NarrationStudio({ job, version, status, onSaved, disabled }) {
  const shots = job.storyboard?.shots || [];
  const [shotId, setShotId] = useState(shots[0]?.id);
  const [voice, setVoice] = useState(version?.voice || (status?.voices?.[job.narration?.voice] ? job.narration.voice : status?.voice) || 'serena');
  const [edits, setEdits] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const shot = shots.find((item) => item.id === shotId);
  const originalVoiceover = (item) => version ? version.cues.find((cue) => cue.shotId === item.id)?.text || '' : item.voiceover ?? item.copy ?? '';
  const line = (item) => edits[item.id] ?? originalVoiceover(item);
  const voices = status?.voices || { serena: '温柔女声', vivian: '明亮女声', uncle_fu: '沉稳男声' };
  const isAvailable = status?.available === true;
  const captionsUrl = version?.outputs?.['9:16']?.captionsUrl || job.captionsUrl;
  const warnings = version?.warnings || job.narration?.warnings || [];
  async function save() {
    setSaving(true);
    setError('');
    try {
      const response = await fetch(`/api/jobs/${job.id}/narration`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice, lines: Object.fromEntries(shots.map((item) => [item.id, line(item)])) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '重配音未完成。');
      onSaved(data.job, data.version);
    } catch (failure) { setError(failure.message); }
    finally { setSaving(false); }
  }
  return <div className="voice-studio">
    <div className="voice-studio-heading"><AudioLines size={18} /><div><strong>重配音</strong><small>{status?.provider || 'Qwen3-TTS'} · 在此 Mac 上运行</small></div></div>
    {!isAvailable && <p className="warning-copy">本机语音服务尚未就绪。</p>}
    {shot && <>
      <div className="voice-controls">
        <label className="field-label">口播镜头<select value={shotId} onChange={(event) => setShotId(event.target.value)} disabled={saving}>{shots.map((item) => <option key={item.id} value={item.id}>{item.label} · {item.end_seconds - item.start_seconds} 秒</option>)}</select></label>
        <label className="field-label">配音音色<select value={voice} onChange={(event) => setVoice(event.target.value)} disabled={saving}>{Object.entries(voices).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      </div>
      <label className="field-label">旁白与字幕<textarea className="prompt-editor" rows={3} maxLength={120} value={line(shot)} disabled={saving} onChange={(event) => setEdits({ ...edits, [shot.id]: event.target.value })} /></label>
      <VoicePreview text={line(shot)} duration={shot.end_seconds - shot.start_seconds} voice={voice} disabled={!isAvailable || saving} />
      <div className="voice-studio-actions"><button className="button button-primary" type="button" disabled={disabled || !isAvailable || saving || !shots.some((item) => line(item).trim())} onClick={save}>{saving && <LoaderCircle className="spin" size={15} />}{saving ? '正在重新配音…' : '生成配音版'}</button>{captionsUrl && <a className="button button-secondary" href={captionsUrl} download>下载字幕</a>}</div>
      <p className="voice-reassurance" role="status">{saving ? '正在逐镜合成旁白和字幕，完成后会切换到新版。' : '保留原画面和原成片，可切换画幅导出新版。'}</p>
    </>}
    {[...(error ? [error] : []), ...warnings].map((warning) => <p key={warning} className="warning-copy" role="status">{warning}</p>)}
  </div>;
}
