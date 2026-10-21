# -*- coding: utf-8 -*-
"""Create a desktop shortcut for SciTag (custom icon + launcher)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import subprocess

root = Path(r"D:\code\scitag")
ico = root / "scitag.ico"
size = 256
img = Image.new("RGBA", (size, size), (15, 27, 42, 255))
d = ImageDraw.Draw(img)
d.rounded_rectangle([8, 8, size - 8, size - 8], radius=48, fill=(20, 50, 79, 255))
d.ellipse([36, 36, 92, 92], fill=(127, 209, 165, 255))
try:
    f = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", 130)
except Exception:
    f = ImageFont.load_default()
d.text((92, 58), "S", font=f, fill=(238, 243, 248, 255))
img.save(ico, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])

desktop = Path(subprocess.run(["powershell", "-NoProfile", "-Command",
                               "[Environment]::GetFolderPath('Desktop')"],
                              capture_output=True, text=True).stdout.strip())
lnk = desktop / "SciTag.lnk"
ps = f"""
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('{lnk}')
$s.TargetPath = 'powershell.exe'
$s.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{root / 'start-scitag.ps1'}"'
$s.WorkingDirectory = '{root}'
$s.IconLocation = '{ico}'
$s.Description = 'SciTag - multi-agent research collaboration'
$s.Save()
"""
subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], check=True)
print("shortcut:", lnk, lnk.exists())
print("icon:", ico, ico.exists())
