from http.server import BaseHTTPRequestHandler
import json
import urllib.request
import urllib.parse
import os
import hmac
import hashlib
import base64
import time
from html.parser import HTMLParser


# ─── who may use the server as a fetcher ───────────────────────────────────
# Was open to the internet with CORS `*` — an anonymous SSRF and read oracle.
# Now: the internal secret (server) or a session JWT (browser), nothing else.
# Nothing in the app currently calls this endpoint at all.

def _jwt_secret() -> str:
    return os.environ.get("JWT_SECRET") or ""


def _internal_secret() -> str:
    return hashlib.sha256(f"{_jwt_secret()}:internal-tool-runner".encode()).hexdigest()


def _verify_jwt(token: str) -> bool:
    secret = _jwt_secret()
    if not secret:
        return False
    try:
        header, body, sig = token.split(".")
        expected = base64.urlsafe_b64encode(
            hmac.new(secret.encode(), f"{header}.{body}".encode(), hashlib.sha256).digest()
        ).rstrip(b"=").decode()
        if not hmac.compare_digest(sig, expected):
            return False
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        exp = payload.get("exp")
        if exp and int(exp) < int(time.time()):
            return False
        return True
    except Exception:
        return False


def _authorized(headers) -> bool:
    internal = headers.get("X-Internal-Secret", "")
    if internal and hmac.compare_digest(internal, _internal_secret()):
        return True
    auth = headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return _verify_jwt(auth[7:])
    return False


def _points_inward(raw_url: str) -> bool:
    """A literal check that a URL aims at the machine itself or a private net."""
    try:
        h = (urllib.parse.urlparse(raw_url).hostname or "").lower()
    except Exception:
        return True
    if h in ("localhost", "metadata.google.internal") or h.endswith(".localhost"):
        return True
    if h == "::1" or h.startswith("fd") or h.startswith("fe80"):
        return True
    parts = h.split(".")
    if len(parts) == 4 and all(p.isdigit() for p in parts):
        p = [int(x) for x in parts]
        if p[0] in (0, 10, 127):
            return True
        if p[0] == 169 and p[1] == 254:
            return True
        if p[0] == 192 and p[1] == 168:
            return True
        if p[0] == 172 and 16 <= p[1] <= 31:
            return True
    return False


class _TextExtractor(HTMLParser):
    """Extracts clean text, title, and links from HTML using stdlib only."""

    SKIP_TAGS = {"script", "style", "noscript", "head", "nav", "footer", "header", "aside"}
    BLOCK_TAGS = {"p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "article", "section", "main", "td", "th", "br"}

    def __init__(self, base_url=""):
        super().__init__()
        self.base_url = base_url
        self._parts = []
        self._skip = 0
        self.title = ""
        self._in_title = False
        self._in_meta_desc = False
        self.meta_description = ""
        self.links = []

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag == "title":
            self._in_title = True
        if tag == "meta" and attrs_dict.get("name", "").lower() == "description":
            self.meta_description = attrs_dict.get("content", "")
        if tag == "a" and attrs_dict.get("href"):
            href = attrs_dict["href"]
            if href.startswith("http"):
                self.links.append(href)
            elif href.startswith("/") and self.base_url:
                self.links.append(self.base_url.rstrip("/") + href)
        if tag in self.SKIP_TAGS:
            self._skip += 1
        if tag in self.BLOCK_TAGS and self._parts and self._parts[-1] != "\n":
            self._parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag in self.SKIP_TAGS:
            self._skip = max(0, self._skip - 1)
        if tag in self.BLOCK_TAGS and self._parts and self._parts[-1] != "\n":
            self._parts.append("\n")

    def handle_data(self, data):
        text = data.strip()
        if not text:
            return
        if self._in_title:
            self.title += text
        elif self._skip == 0:
            self._parts.append(text)

    def get_text(self, max_chars=8000):
        raw = " ".join(
            part if part == "\n" else part
            for part in self._parts
        )
        # Collapse whitespace while preserving paragraph breaks
        import re
        raw = re.sub(r" {2,}", " ", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw[:max_chars].strip()


def _scrape(url: str) -> dict:
    if not url.startswith("http"):
        url = "https://" + url

    if _points_inward(url):
        return {"error": "That address is not allowed."}

    parsed = urllib.parse.urlparse(url)
    base_url = f"{parsed.scheme}://{parsed.netloc}"

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "he,en-US,en;q=0.9",
            "Accept-Encoding": "identity",
        },
    )

    with urllib.request.urlopen(req, timeout=15) as resp:
        content_type = resp.headers.get("Content-Type", "")
        charset = "utf-8"
        if "charset=" in content_type:
            charset = content_type.split("charset=")[-1].split(";")[0].strip()
        html = resp.read().decode(charset, errors="replace")

    parser = _TextExtractor(base_url=base_url)
    parser.feed(html)

    return {
        "url": url,
        "title": parser.title.strip(),
        "meta_description": parser.meta_description,
        "text": parser.get_text(),
        "links": list(dict.fromkeys(parser.links))[:30],  # unique, max 30
    }


class handler(BaseHTTPRequestHandler):
    def _reject(self, status, message):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": message}).encode())

    def _respond(self, url):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        if not url:
            self.wfile.write(json.dumps({"error": "url is required"}).encode())
            return
        try:
            self.wfile.write(json.dumps(_scrape(url)).encode())
        except Exception as e:
            self.wfile.write(json.dumps({"error": str(e)}).encode())

    def do_POST(self):
        if not _authorized(self.headers):
            return self._reject(401, "unauthorized")
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")
        self._respond(body.get("url", "").strip())

    def do_GET(self):
        if not _authorized(self.headers):
            return self._reject(401, "unauthorized")
        url = ""
        if "?" in self.path:
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            url = qs.get("url", [""])[0]
        self._respond(url)

    def log_message(self, *args):
        pass
