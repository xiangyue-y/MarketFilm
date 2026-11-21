"""Download the pinned MLX model into the project, resuming interrupted ranges."""
import concurrent.futures as futures
import fcntl
import hashlib
import os
from pathlib import Path
import re
import subprocess
import time


REVISION = "41d3337e8b7f2843a75841595fc14e4b9a7a4b96"
REPO = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
HUB = "https://huggingface.co"
MODEL = Path(".models/qwen3-tts")
SCRATCH = Path(".models/qwen3-tts-download/ranges")
BLOCK = 24 << 20

FILES = {
    'config.json': 6058,
    'generation_config.json': 245,
    'merges.txt': 1671839,
    'model.safetensors.index.json': 71786,
    'preprocessor_config.json': 127,
    'speech_tokenizer/config.json': 2336,
    'speech_tokenizer/configuration.json': 76,
    'speech_tokenizer/preprocessor_config.json': 234,
    'tokenizer_config.json': 7344,
    'vocab.json': 2776833,
}
WEIGHTS = {
    'model.safetensors': (2393308931, 'b696f4bf45f54497b6de758981e76f1410bd68af05a657477dee466b0202df1a'),
    'speech_tokenizer/model.safetensors': (682293092, '836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258'),
}


def curl(*args):
    return subprocess.run(["curl", "-fsSL", "--connect-timeout", "15", *args], capture_output=True)


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def model_url(name):
    return f"{HUB}/{REPO}/resolve/{REVISION}/{name}?download=true"


def save_small(entry):
    dest = MODEL / entry["path"]
    if dest.exists() and dest.stat().st_size == entry["size"]:
        return
    dest.parent.mkdir(parents=True, exist_ok=True)
    temp = dest.with_name(dest.name + ".download")
    curl("--retry", "4", "--retry-all-errors", "--max-time", "90", "-o", str(temp), model_url(entry["path"])).check_returncode()
    if temp.stat().st_size != entry["size"]:
        raise RuntimeError(f"Unexpected file size: {entry['path']}")
    temp.replace(dest)


def download_range(entry, index):
    name, size = entry["path"], entry["size"]
    start, end = index * BLOCK, min(size, (index + 1) * BLOCK) - 1
    key = f"{name.replace('/', '-')}-{index:03}"
    part, temp, headers = (SCRATCH / (key + suffix) for suffix in (".part", ".resume", ".headers"))
    if part.exists() and part.stat().st_size == end - start + 1:
        return part
    legacy_partial = SCRATCH / (key + ".tmp")
    if legacy_partial.exists() and 0 < legacy_partial.stat().st_size <= end - start + 1 and not part.exists():
        legacy_partial.replace(part)
    if part.exists() and part.stat().st_size > end - start + 1:
        part.unlink()
    for attempt in range(12):
        offset = start + (part.stat().st_size if part.exists() else 0)
        if offset == end + 1:
            return part
        temp.unlink(missing_ok=True)
        headers.unlink(missing_ok=True)
        result = curl("--max-time", "210", "--speed-limit", "1024", "--speed-time", "45",
                      "--range", f"{offset}-{end}", "-D", str(headers), "-o", str(temp), model_url(name))
        ranges = re.findall(r"(?im)^content-range: bytes (\d+)-(\d+)/(\d+)\s*$", headers.read_text(errors="replace")) if headers.exists() else []
        received = temp.stat().st_size if temp.exists() else 0
        if ranges and tuple(map(int, ranges[-1])) == (offset, end, size) and 0 < received <= end - offset + 1:
            with part.open("ab") as target, temp.open("rb") as source:
                for buffer in iter(lambda: source.read(1 << 20), b""):
                    target.write(buffer)
            temp.unlink()
            if offset + received == end + 1:
                headers.unlink(missing_ok=True)
                return part
        if not received:
            time.sleep(min(15, 2 + 2 * attempt))
    raise RuntimeError(f"Interrupted after retries: {name} range {start}-{end} ({result.returncode})")


def assemble(entry, parts):
    dest = MODEL / entry["path"]
    temp = dest.with_name(dest.name + ".download")
    dest.parent.mkdir(parents=True, exist_ok=True)
    with temp.open("wb") as target:
        for part in parts:
            with part.open("rb") as source:
                for buffer in iter(lambda: source.read(4 << 20), b""):
                    target.write(buffer)
    if temp.stat().st_size != entry["size"] or sha256(temp) != entry["lfs"]["oid"]:
        temp.unlink()
        raise RuntimeError(f"Weight checksum does not match: {entry['path']}")
    temp.replace(dest)
    print(f"Verified {entry['path']} ({entry['size'] / 1e6:.0f} MB)", flush=True)
    for part in parts:
        part.unlink()


def download():
    small = [{"path": path, "size": size} for path, size in FILES.items()]
    entries = [{"path": path, "size": size, "lfs": {"oid": digest}} for path, (size, digest) in WEIGHTS.items()]
    workers = int(os.environ.get("TTS_DOWNLOAD_WORKERS", "16"))
    with futures.ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(save_small, small))
        for entry in sorted(entries, key=lambda item: item["size"]):
            dest = MODEL / entry["path"]
            if dest.exists() and dest.stat().st_size == entry["size"] and sha256(dest) == entry["lfs"]["oid"]:
                continue
            total = (entry["size"] + BLOCK - 1) // BLOCK
            tasks = {pool.submit(download_range, entry, index): index for index in range(total)}
            parts = {}
            errors = []
            for task in futures.as_completed(tasks):
                try:
                    parts[tasks[task]] = task.result()
                    if len(parts) % 5 == 0 or len(parts) == total:
                        print(f"{entry['path']}: {len(parts)}/{total} ranges", flush=True)
                except Exception as error:
                    errors.append(str(error))
            if errors:
                raise RuntimeError("; ".join(errors))
            assemble(entry, [parts[index] for index in range(total)])


if __name__ == "__main__":
    SCRATCH.mkdir(parents=True, exist_ok=True)
    with (SCRATCH / ".lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        download()
