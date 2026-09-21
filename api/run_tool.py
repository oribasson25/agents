from http.server import BaseHTTPRequestHandler
import json
import subprocess
import sys
import os
import hmac
import hashlib
import base64
import time


# ─── who is allowed to run code here ───────────────────────────────────────
#
# This endpoint executes arbitrary Python. It used to be reachable by anyone
# on the internet with CORS `*`, which is remote code execution as a service.
# Now it accepts exactly two callers, and no one else:
#
#   • a signed-in browser, proven by its session JWT (same key the Node side
#     signs with — verified here without any library);
#   • the platform's own agent runner, proven by the internal secret, which is
#     derived from JWT_SECRET the identical way api/_auth.js derives it.
#
# An anonymous caller has neither and is refused before a line of code runs.

def _jwt_secret() -> str:
    return os.environ.get("JWT_SECRET") or ""


def _internal_secret() -> str:
    return hashlib.sha256(f"{_jwt_secret()}:internal-tool-runner".encode()).hexdigest()


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
        if not hmac.compare_digest(sig, expected):
            return False
        payload = json.loads(_b64url_decode(body))
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


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if not _authorized(self.headers):
            self.send_response(401)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "unauthorized"}).encode())
            return

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")

        code = body.get("code", "")
        inputs = body.get("inputs", {})
        packages = body.get("packages", [])  # list of pip package names
        env_vars = body.get("env_vars", {})  # dict of env var key→value

        result = _run(code, inputs, packages, env_vars)

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())

    def log_message(self, *args):
        pass  # suppress access logs


PKG_DIR = "/tmp/pip_packages"


def _install(packages: list) -> str | None:
    """Install packages to /tmp (writable on Vercel). Returns error string or None."""
    if not packages:
        return None
    # Add target dir to path so imports work
    if PKG_DIR not in sys.path:
        sys.path.insert(0, PKG_DIR)
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "--target", PKG_DIR, *packages],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            return f"pip install failed:\n{(result.stderr or result.stdout)[:600]}"
    except Exception as e:
        return f"pip install error: {e}"
    return None


def _run(code: str, inputs: dict, packages: list, env_vars: dict) -> dict:
    """
    Execute the tool code and call its run(**kwargs) function.

    The tool code must define a function named `run` that accepts **kwargs.
    Packages are installed before execution. env_vars are available via os.environ.
    """
    if not code.strip():
        return {"error": "Tool has no code"}

    # Install required packages
    if packages:
        err = _install(packages)
        if err:
            return {"error": err}

    # Inject env vars into environment for this process (available via os.environ in user code)
    original_env = {}
    for k, v in (env_vars or {}).items():
        original_env[k] = os.environ.get(k)
        os.environ[k] = str(v)

    try:
        namespace = {"os": os}
        try:
            exec(code, namespace)  # noqa: S102
        except Exception as e:
            return {"error": f"Compilation error: {e}"}

        run_fn = namespace.get("run")
        if not callable(run_fn):
            defined = [k for k, v in namespace.items() if callable(v) and not k.startswith("_")]
            hint = f"Found: {defined}" if defined else "No functions defined."
            return {"error": f"No callable 'run' function found.\n{hint}\n\nMake sure your code defines:\n\ndef run(**kwargs):\n    ..."}

        try:
            result = run_fn(**inputs)
            return {"result": str(result)}
        except Exception as e:
            return {"error": f"Runtime error: {e}"}
    finally:
        # Restore env
        for k, orig in original_env.items():
            if orig is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = orig
