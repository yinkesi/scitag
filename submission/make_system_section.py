# -*- coding: utf-8 -*-
"""Render SYSTEM-SECTION.md to HTML + PDF (Edge headless), one A4 page."""
import subprocess
from pathlib import Path
import markdown

HERE = Path(__file__).resolve().parent
md = (HERE / "SYSTEM-SECTION.md").read_text(encoding="utf-8")
body = markdown.markdown(md, extensions=["tables", "fenced_code", "sane_lists"])
html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
@page {{ size: A4; margin: 15mm 15mm 13mm 15mm; }}
body {{ font-family: 'Segoe UI', Arial, sans-serif; color:#1d232b; font-size: 9.9pt; line-height:1.45; }}
h1 {{ font-size: 18pt; margin: 0 0 2mm 0; color:#14324f; }}
h2 {{ font-size: 12.5pt; margin: 4.5mm 0 1.5mm 0; color:#14324f; border-bottom:1px solid #d8e0e8; padding-bottom:1mm; }}
p {{ margin: 1.4mm 0; }}
em {{ color:#5b6b7a; }}
ol {{ margin: 1.5mm 0 0 5mm; padding: 0; }}
li {{ margin: 1.2mm 0; }}
</style></head><body>{body}</body></html>"""
(HERE / "system-section.html").write_text(html, encoding="utf-8")

edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
pdf = HERE / "system-section.pdf"
subprocess.run([edge, "--headless=new", "--disable-gpu", f"--print-to-pdf={pdf}",
                (HERE / "system-section.html").as_uri()], check=True, timeout=120)
print("pdf", pdf, pdf.stat().st_size)
