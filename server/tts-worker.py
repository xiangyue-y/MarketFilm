"""Resident, offline MLX worker. stdin/stdout are a private JSON-lines pipe."""
import contextlib
import hashlib
import json
import sys

protocol = sys.stdout


def send(value):
    print(json.dumps(value, ensure_ascii=False), file=protocol, flush=True)


with contextlib.redirect_stdout(sys.stderr):
    import mlx.core as mx
    import numpy as np
    import soundfile as sf
    from mlx_audio.tts.utils import load_model

    model = load_model(sys.argv[1])
    mx.eval(model.parameters())

send({"ready": True})
for line in sys.stdin:
    request = {}
    try:
        request = json.loads(line)
        text, speaker, style = (request[key] for key in ("text", "voice", "style"))
        seed = int.from_bytes(hashlib.sha256(f"{speaker}\0{style}\0{text}".encode()).digest()[:4])
        with contextlib.redirect_stdout(sys.stderr):
            mx.random.seed(seed)
            samples = list(model.generate_custom_voice(
                text=text, speaker=speaker, language="Chinese", instruct=style,
                max_tokens=min(420, 75 + 4 * len(text)), temperature=0.75, verbose=False,
            ))
            if not samples:
                raise RuntimeError("No speech generated")
            audio = np.concatenate([np.asarray(part.audio, dtype=np.float32).reshape(-1) for part in samples])
            if not np.isfinite(audio).all() or len(audio) < 1500 or np.max(np.abs(audio)) < 0.005:
                raise RuntimeError("Empty or invalid speech")
            rate = samples[0].sample_rate
            # Trim silence around the utterance while retaining its attacks and tails.
            hop = rate // 100
            usable = len(audio) // hop * hop
            windows = audio[:usable].reshape(-1, hop)
            voiced = np.flatnonzero(np.sqrt(np.mean(windows ** 2, axis=1)) > 0.006)
            if voiced.size:
                audio = audio[max(0, (voiced[0] - 9) * hop):min(len(audio), (voiced[-1] + 13) * hop)]
            peak = float(np.max(np.abs(audio)))
            audio *= min(4.0, 0.8 / peak)
            sf.write(request["output"], audio, rate, subtype="PCM_16")
        send({"id": request["id"], "ok": True})
    except Exception as error:
        send({"id": request.get("id"), "error": str(error)})
