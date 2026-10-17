"""Reproducible, credential-free download for Windows, macOS and Linux."""
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1]
files = {
    'worker.mjs': root / 'worker.mjs',
    'worker-executors.mjs': root / 'worker-executors.mjs',
    'connect.mjs': root / 'connect.mjs',
    'connection.json': root / 'scripts/client-connection.json',
    '使用说明.md': root / 'docs/WORKER-QUICKSTART.md',
}
for name in ['index.html', 'style.css', 'entry.js', 'app.js', 'workspace.js', 'brand.svg']:
    files['ui/' + name] = root / 'public' / name
with ZipFile(root / 'public/worker-client.zip', 'w', compression=ZIP_DEFLATED) as archive:
    for name, source in files.items():
        info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        archive.writestr(info, source.read_bytes())
    for name, args in [('启动接入.cmd', ''), ('打开协作网页.cmd', '--web'), ('检查连接.cmd', '--check')]:
        info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        archive.writestr(info, ('@echo off\r\ncd /d "%~dp0"\r\nnode connect.mjs ' + args + '\r\npause\r\n').encode('ascii'))
