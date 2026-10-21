# -*- coding: utf-8 -*-
"""Render ONE-PAGER.md to HTML and PDF (Edge headless)."""
import subprocess
from pathlib import Path

import markdown

HERE = Path(__file__).resolve().parent
md = (HERE / "ONE-PAGER.md").read_text(encoding="utf-8")
body = markdown.markdown(md, extensions=["tables", "fenced_code", "sane_lists"])
html = f"""<!doctype html>
<html><head><meta charset="utf-8">
<style>
  @page {{ size: A4; margin: 14mm 14mm 12mm 14mm; }}
  body {{ font-family: 'Segoe UI', Arial, sans-serif; color:#1d232b; font-size: 9.6pt; line-height:1.42; }}
  h1 {{ font-size: 19pt; margin: 0 0 2mm 0; color:#14324f; }}
  h2 {{ font-size: 13pt; margin: 5mm 0 1.5mm 0; color:#14324f; border-bottom:1px solid #d8e0e8; padding-bottom:1mm; }}
  h3 {{ font-size: 10pt; margin: 0 0 3mm 0; color:#3a5a78; font-weight:600; }}
  table {{ border-collapse: collapse; width: 100%; margin: 2mm 0; font-size: 8.8pt; }}
  th, td {{ border: 1px solid #c9d3dd; padding: 1.4mm 2mm; text-align: left; vertical-align: top; }}
  th {{ background: #eef3f8; }}
  blockquote {{ margin: 2mm 0; padding: 2mm 3mm; border-left: 3px solid #2f6f4f; background:#f4f8f5; }}
  code {{ background:#eef1f4; padding: 0.3mm 1mm; border-radius: 2px; font-size: 8.6pt; }}
  hr {{ border: none; border-top:1px solid #d8e0e8; margin: 3mm 0; }}
  img {{ max-width: 100%; }}
  p {{ margin: 1.2mm 0; }}
</style></head><body>
{body}
</body></html>"""
(HERE / "one-pager.html").write_text(html, encoding="utf-8")

edge = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
pdf = HERE / "one-pager.pdf"
subprocess.run([edge, "--headless=new", "--disable-gpu", f"--print-to-pdf={pdf}",
                (HERE / "one-pager.html").as_uri()], check=True, timeout=120)
print("pdf", pdf, pdf.stat().st_size)
