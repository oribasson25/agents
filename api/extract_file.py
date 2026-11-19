"""
Extract text from uploaded files (PDF, DOCX).

Accepts POST:  { "filename": "report.pdf", "content_b64": "<base64>" }
Returns:       { "title": "report", "text": "...", "pages": 5 }   (or {"error": "..."})

Only a signed-in browser (its session JWT) or the platform itself (the
internal secret) may call it: parsing a PDF or a DOCX costs compute, and the
parsers are attack surface. Same-origin only — no CORS.

A DOCX is a zip, and a zip can claim to unpack to gigabytes from a few MB, so
the sizes it declares are checked before anything is unpacked; the text that
comes back is capped too.

pymupdf and pypdf are declared in requirements.txt and pre-installed by Vercel.
"""

from http.server import BaseHTTPRequestHandler
import base64
import hashlib
import hmac
import io
import json
import os
import time
import zipfile
import xml.etree.ElementTree as ET


MAX_BODY = 30 * 1024 * 1024          # the JSON request, base64 included
MAX_UNZIPPED = 50 * 1024 * 1024      # what a DOCX may declare it unpacks to, in all
MAX_TEXT = 5 * 1024 * 1024           # characters of text sent back
MAX_PAGES = 2000


# ─── who may call ─────────────────────────────────────────────────────────────
# Mirrors api/run_tool.py and api/_auth.js. With JWT_SECRET unset nothing is
# accepted: a missing secret never turns into an empty or computable one.

def _jwt_secret() -> str:
    return os.environ.get("JWT_SECRET") or ""


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _verify_jwt(token: str) -> bool:
    secret = _jwt_secret()
    if not secret:
        return False
    try:
        header, body, sig = token.split(".")
        expected = base64.urlsafe_b64encode(
            hmac.new(secret.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()
        ).rstrip(b"=").decode()
        if not hmac.compare_digest(sig.encode(), expected.encode()):
            return False
        payload = json.loads(_b64url_decode(body))
        exp = payload.get("exp")
        if exp and int(exp) < int(time.time()):
            return False
        return bool(payload.get("userId"))
    except Exception:
        return False


def _internal_ok(got: str) -> bool:
    if not got:
        return False
    candidates = []
    if os.environ.get("TOOL_RUNNER_SECRET"):
        candidates.append(os.environ["TOOL_RUNNER_SECRET"])
    if _jwt_secret():
        candidates.append(hashlib.sha256(f"{_jwt_secret()}:internal-tool-runner".encode()).hexdigest())
    ok = False
    for c in candidates:
        if hmac.compare_digest(got.encode(), c.encode()):
            ok = True
    return ok


def _authorized(headers) -> bool:
    if _internal_ok(headers.get("X-Internal-Secret", "") or ""):
        return True
    auth = headers.get("Authorization", "") or ""
    return auth.startswith("Bearer ") and _verify_jwt(auth[7:])


# ─── DOCX (stdlib) ────────────────────────────────────────────────────────────

def _extract_docx(data: bytes) -> str:
    NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos = z.infolist()
        if sum(i.file_size for i in infos) > MAX_UNZIPPED:
            raise ValueError("The document unpacks to more than 50 MB")
        try:
            info = z.getinfo("word/document.xml")
        except KeyError:
            raise ValueError("Not a Word document (no word/document.xml)")
        # the declared size is what the check above trusted; read no more than it
        with z.open(info) as fh:
            xml_bytes = fh.read(MAX_UNZIPPED + 1)
        if len(xml_bytes) > MAX_UNZIPPED:
            raise ValueError("The document unpacks to more than 50 MB")
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
        pages = []
        total = 0
        for i, page in enumerate(doc):
            if i >= MAX_PAGES or total > MAX_TEXT:
                break
            t = page.get_text().strip()
            total += len(t)
            pages.append(t)
        doc.close()
        return "\n\n".join(p for p in pages if p), page_count
    except Exception:
        pass

    try:
        import pypdf
        reader = pypdf.PdfReader(io.BytesIO(data))
        pages = []
        total = 0
        for i, page in enumerate(reader.pages):
            if i >= MAX_PAGES or total > MAX_TEXT:
                break
            t = (page.extract_text() or "").strip()
            total += len(t)
            pages.append(t)
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

    if len(text) > MAX_TEXT:
        text = text[:MAX_TEXT]
    result = {"title": title, "text": text}
    if pages is not None:
        result["pages"] = pages
    return result


# ─── HTTP handler ─────────────────────────────────────────────────────────────

class handler(BaseHTTPRequestHandler):
    def _reply(self, status: int, obj: dict) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(obj).encode())

    def do_POST(self):
        if not _authorized(self.headers):
            return self._reply(401, {"error": "unauthorized"})
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        if length > MAX_BODY:
            return self._reply(413, {"error": "The file is too large."})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._reply(400, {"error": "the body is not JSON"})
        if not isinstance(body, dict):
            return self._reply(400, {"error": "the body is not a JSON object"})

        filename = str(body.get("filename") or "").strip()
        content_b64 = body.get("content_b64") or ""

        if not filename or not content_b64:
            return self._reply(200, {"error": "filename and content_b64 are required"})

        try:
            data = base64.b64decode(content_b64)
            return self._reply(200, _extract(filename, data))
        except Exception as e:
            return self._reply(200, {"error": str(e)[:300]})

    def log_message(self, *args):
        pass
