from http.server import BaseHTTPRequestHandler
import json
import subprocess
import sys
import os


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")

        code = body.get("code", "")
        inputs = body.get("inputs", {})
        packages = body.get("packages", [])  # list of pip package names
        env_vars = body.get("env_vars", {})  # dict of env var key→value

        result = _run(code, inputs, packages, env_vars)

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, *args):
        pass  # suppress access logs


def _install(packages: list) -> str | None:
    """Install packages via pip. Returns error string or None."""
    if not packages:
        return None
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--quiet", *packages],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
    except subprocess.CalledProcessError as e:
        return f"pip install failed: {e.stderr.decode()[:500] if e.stderr else str(e)}"
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
            return {"error": "No callable 'run' function found in tool code"}

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
