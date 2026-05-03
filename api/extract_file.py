"""
Extract text from uploaded files (PDF, DOCX).

Accepts POST:  { "filename": "report.pdf", "content_b64": "<base64>" }
Returns:       { "title": "report", "text": "...", "pages": 5 }   (or {"error": "..."})

pymupdf and pypdf are declared in requirements.txt and pre-installed by Vercel.
"""

from http.server import BaseHTTPRequestHandler
import base64
import io
import json
import os
import zipfile
import xml.etree.ElementTree as ET


# ─── DOCX (stdlib) ────────────────────────────────────────────────────────────

def _extract_docx(data: bytes) -> str:
    NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        xml_bytes = z.read("word/document.xml")
    root = ET.fromstring(xml_bytes)
    lines = []

    def _para_text(para) -> str:
        parts = []
        for t in para.iter(f"{{{NS}}}t"):
            if t.text:
                parts.append(t.text)
        return "".join(parts).strip()

    for node in root.iter():
        if node.tag == f"{{{NS}}}p":
            line = _para_text(node)
            if line:
                lines.append(line)
        elif node.tag == f"{{{NS}}}tr":
            cells = []
            for tc in node.iter(f"{{{NS}}}tc"):
                cell_parts = []
                for t in tc.iter(f"{{{NS}}}t"):
                    if t.text:
                        cell_parts.append(t.text)
                cells.append("".join(cell_parts).strip())
            row = "\t".join(cells)
            if row.strip():
                lines.append(row)

    return "\n".join(lines)


# ─── PDF (pymupdf primary, pypdf fallback) ────────────────────────────────────

def _extract_pdf(data: bytes) -> tuple[str, int]:
    """Returns (text, page_count). Tries pymupdf first, falls back to pypdf."""
    try:
        import fitz
        doc = fitz.open(stream=data, filetype="pdf")
        page_count = doc.page_count
        pages = [page.get_text().strip() for page in doc]
        doc.close()
        return "\n\n".join(p for p in pages if p), page_count
    except Exception:
        pass

    try:
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(data))
        pages = [(page.extract_text() or "").strip() for page in reader.pages]
        return "\n\n".join(p for p in pages if p), len(reader.pages)
    except Exception as e:
        raise RuntimeError(f"PDF extraction failed: {e}")


# ─── Dispatch ─────────────────────────────────────────────────────────────────

def _extract(filename: str, data: bytes) -> dict:
    ext = os.path.splitext(filename.lower())[1]
    title = os.path.splitext(filename)[0]
    pages = None

    if ext == ".docx":
        text = _extract_docx(data)
    elif ext == ".pdf":
        text, pages = _extract_pdf(data)
    else:
        return {"error": f"סוג קובץ לא נתמך: {ext}. נתמכים: .pdf, .docx"}

    MAX_CHARS = 100_000
    truncated = len(text) > MAX_CHARS
    text = text[:MAX_CHARS]

    result = {"title": title, "text": text, "truncated": truncated}
    if pages is not None:
        result["pages"] = pages
    return result


# ─── HTTP handler ─────────────────────────────────────────────────────────────

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")

        filename = (body.get("filename") or "").strip()
        content_b64 = body.get("content_b64") or ""

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        if not filename or not content_b64:
            self.wfile.write(json.dumps({"error": "filename and content_b64 are required"}).encode())
            return

        try:
            data = base64.b64decode(content_b64)
            result = _extract(filename, data)
            self.wfile.write(json.dumps(result).encode())
        except Exception as e:
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, *args):
        pass
