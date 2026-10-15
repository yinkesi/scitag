"""Reproducible, credential-free download for Windows, macOS and Linux."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1]
files = {
    'worker.mjs': root / 'worker.mjs',
    'worker-executors.mjs': root / 'worker-executors.mjs',
    '使用说明.md': root / 'docs/WORKER-QUICKSTART.md',
}
with ZipFile(root / 'public/worker-client.zip', 'w', compression=ZIP_DEFLATED) as archive:
    for name, source in files.items():
        info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        archive.writestr(info, source.read_bytes())
