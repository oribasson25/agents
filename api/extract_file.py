"""
Extract text from uploaded files (PDF, DOCX, XLSX/XLS).

Accepts POST:  { "filename": "report.pdf", "content_b64": "<base64>" }
Returns:       { "title": "report", "text": "...", "pages": 5 }   (or {"error": "..."})

DOCX and XLSX are parsed with stdlib only (they are ZIP+XML).
PDF uses pypdf (installed to /tmp on first request).
"""

from http.server import BaseHTTPRequestHandler
import base64
import io
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

PKG_DIR = "/tmp/pip_packages"


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
            # Table row: collect cells separated by tab
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


# ─── XLSX (stdlib) ─────────────────────────────────────────────────────────────

def _extract_xlsx(data: bytes) -> str:
    NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        names = z.namelist()

        # Shared strings (text cells reference an index here)
        shared = []
        if "xl/sharedStrings.xml" in names:
            ss_root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in ss_root:
                parts = []
                for t in si.iter(f"{{{NS}}}t"):
                    if t.text:
                        parts.append(t.text)
                shared.append("".join(parts))

        # Sheet names from workbook
        wb_root = ET.fromstring(z.read("xl/workbook.xml"))
        sheet_names = {}
        for sh in wb_root.iter(f"{{{NS}}}sheet"):
            r_id = sh.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id", "")
            sheet_names[r_id] = sh.get("name", "Sheet")

        # Read each worksheet
        sheet_files = sorted(n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml", n))
        all_rows = []
        for sheet_path in sheet_files:
            sheet_root = ET.fromstring(z.read(sheet_path))
            for row in sheet_root.iter(f"{{{NS}}}row"):
                cells = []
                for cell in row.iter(f"{{{NS}}}c"):
                    v = cell.find(f"{{{NS}}}v")
                    if v is not None and v.text is not None:
                        if cell.get("t") == "s":
                            idx = int(v.text)
                            cells.append(shared[idx] if idx < len(shared) else "")
                        else:
                            cells.append(v.text)
                    else:
                        cells.append("")
                row_str = "\t".join(cells).strip()
                if row_str:
                    all_rows.append(row_str)
            all_rows.append("")  # blank line between sheets

    return "\n".join(all_rows).strip()


# ─── PDF (pymupdf primary, pypdf fallback) ────────────────────────────────────

def _ensure_pymupdf():
    if PKG_DIR not in sys.path:
        sys.path.insert(0, PKG_DIR)
    try:
        import fitz  # noqa: F401
        return None
    except ImportError:
        pass
    import subprocess
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet", "--target", PKG_DIR, "pymupdf"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return f"pip install pymupdf failed: {(result.stderr or result.stdout)[:400]}"
    return None


def _ensure_pypdf():
    if PKG_DIR not in sys.path:
        sys.path.insert(0, PKG_DIR)
    try:
        import pypdf  # noqa: F401
        return None
    except ImportError:
        pass
    import subprocess
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet", "--target", PKG_DIR, "pypdf"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return f"pip install pypdf failed: {(result.stderr or result.stdout)[:400]}"
    return None


def _extract_pdf_pymupdf(data: bytes) -> tuple[str, int]:
    import fitz
    doc = fitz.open(stream=data, filetype="pdf")
    page_count = doc.page_count
    pages = []
    for page in doc:
        text = page.get_text()
        if text.strip():
            pages.append(text.strip())
    doc.close()
    return "\n\n".join(pages), page_count


def _extract_pdf_pypdf(data: bytes) -> tuple[str, int]:
    import pypdf
    reader = pypdf.PdfReader(io.BytesIO(data))
    pages = []
    for page in reader.pages:
        text = page.extract_text() or ""
        pages.append(text.strip())
    return "\n\n".join(p for p in pages if p), len(reader.pages)


def _extract_pdf(data: bytes) -> tuple[str, int]:
    """Returns (text, page_count). Tries pymupdf first, falls back to pypdf."""
    err = _ensure_pymupdf()
    if not err:
        try:
            return _extract_pdf_pymupdf(data)
        except Exception:
            pass

    err2 = _ensure_pypdf()
    if err2:
        raise RuntimeError(f"Both pymupdf and pypdf unavailable: {err}; {err2}")
    return _extract_pdf_pypdf(data)


# ─── XLS (xlrd via pip) ────────────────────────────────────────────────────────

def _ensure_xlrd():
    if PKG_DIR not in sys.path:
        sys.path.insert(0, PKG_DIR)
    try:
        import xlrd  # noqa: F401
        return None
    except ImportError:
        pass
    import subprocess
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "--quiet", "--target", PKG_DIR, "xlrd"],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        return f"pip install xlrd failed: {(result.stderr or result.stdout)[:400]}"
    return None


def _extract_xls(data: bytes) -> str:
    err = _ensure_xlrd()
    if err:
        raise RuntimeError(err)
    import xlrd
    wb = xlrd.open_workbook(file_contents=data)
    rows = []
    for sheet in wb.sheets():
        for ri in range(sheet.nrows):
            row = [str(sheet.cell_value(ri, ci)) for ci in range(sheet.ncols)]
            rows.append("\t".join(row))
        rows.append("")
    return "\n".join(rows).strip()


# ─── Dispatch ─────────────────────────────────────────────────────────────────

def _extract(filename: str, data: bytes) -> dict:
    ext = os.path.splitext(filename.lower())[1]
    title = os.path.splitext(filename)[0]
    pages = None

    if ext == ".docx":
        text = _extract_docx(data)
    elif ext == ".xlsx":
        text = _extract_xlsx(data)
    elif ext == ".xls":
        text = _extract_xls(data)
    elif ext == ".pdf":
        text, pages = _extract_pdf(data)
    else:
        return {"error": f"Unsupported file type: {ext}. Supported: .pdf, .docx, .xlsx, .xls"}

    # Trim to a reasonable size for RAG storage
    MAX_CHARS = 50_000
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
