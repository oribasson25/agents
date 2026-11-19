"""
The tool runner: runs a customer's Python and returns what its run(**inputs)
returned.

    POST /api/run-tool   X-Internal-Secret: <secret>
    { "code": "...", "inputs": {...}, "packages": ["requests"], "env_vars": {"KEY": "..."} }
    → { "result": "<str(return value)>" }  or  { "error": "..." }

This file exists twice, byte for byte: here (the platform's own deployment)
and as tool-runner/api/run_tool.py (a deployment of its own). A probe holds
them equal. See tool-runner/README.md.
"""

from http.server import BaseHTTPRequestHandler
import hashlib
import hmac
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile


# ─── who may run code here ─────────────────────────────────────────────────
#
# Only the platform itself, proven by a shared secret in X-Internal-Secret.
# A browser never calls this: a person testing a tool goes through
# POST /api/tool-run (Node), which checks their access to the chatbot first.
# (Once any signed-in session was enough, which made every account a way to
# run code next to the platform's secrets.)
#
# Two secrets are accepted, whichever are configured:
#   • TOOL_RUNNER_SECRET — the only secret a separate tool-runner deployment
#     holds, and what the platform sends when TOOL_RUNNER_URL points there;
#   • the internal secret derived from JWT_SECRET, exactly as api/_auth.js
#     internalSecret() derives it — what the platform sends to its own copy.
# Neither configured: nothing is accepted. A missing secret never becomes an
# empty or a computable one.

def _accepted_secrets() -> list:
    secrets = []
    dedicated = os.environ.get("TOOL_RUNNER_SECRET") or ""
    if dedicated:
        secrets.append(dedicated)
    jwt_secret = os.environ.get("JWT_SECRET") or ""
    if jwt_secret:
        secrets.append(hashlib.sha256(f"{jwt_secret}:internal-tool-runner".encode()).hexdigest())
    return secrets


def _authorized(headers) -> bool:
    got = headers.get("X-Internal-Secret", "") or ""
    if not got:
        return False
    ok = False
    for secret in _accepted_secrets():
        # every candidate is compared, so the time does not say which matched
        if hmac.compare_digest(got.encode(), secret.encode()):
            ok = True
    return ok


# ─── where the code runs ───────────────────────────────────────────────────
#
# Not in this process. This process's environment holds whatever the
# deployment holds — on the platform's own deployment that is DATABASE_URL,
# JWT_SECRET and the provider keys. The code runs in a child Python started
# with an environment made from nothing: a PATH, a HOME in a scratch folder,
# and the tool's own env_vars. `-I` keeps PYTHON* variables and the current
# folder off its import path; `-B` keeps it from writing bytecode.
#
# What a child process does NOT stop: on Linux a process can read
# /proc/<pid>/environ of any process running as the same user, its parent
# included, and the runtime runs everything as one user. So on a deployment
# that holds secrets, this narrows the door but does not shut it. The door is
# shut only by running this file in a deployment that holds no secrets but
# TOOL_RUNNER_SECRET (tool-runner/README.md). For the same reason, code from
# two customers that land on one warm instance can see each other's processes;
# per-run isolation needs a sandbox per run (Vercel Sandbox, Firecracker).

RUN_TIMEOUT = int(os.environ.get("TOOL_RUN_TIMEOUT_SECONDS") or 60)
PIP_TIMEOUT = int(os.environ.get("TOOL_PIP_TIMEOUT_SECONDS") or 120)
MAX_BODY = 2 * 1024 * 1024
MAX_RESULT = 5 * 1024 * 1024

CHILD = r'''
import json, sys
payload = json.loads(sys.stdin.read())
for path in reversed(payload.get("paths") or []):
    sys.path.insert(0, path)
import os

def finish(obj):
    with open(payload["result_path"], "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False)
    raise SystemExit(0)

namespace = {"os": os, "__name__": "__tool__"}
try:
    exec(compile(payload["code"], "<tool>", "exec"), namespace)
except BaseException as e:
    if isinstance(e, SystemExit) and e.code == 0 and os.path.exists(payload["result_path"]):
        raise
    finish({"error": f"Compilation error: {e}"})

run_fn = namespace.get("run")
if not callable(run_fn):
    defined = [k for k, v in namespace.items() if callable(v) and not k.startswith("_")]
    hint = f"Found: {defined}" if defined else "No functions defined."
    finish({"error": f"No callable 'run' function found.\n{hint}\n\nMake sure your code defines:\n\ndef run(**kwargs):\n    ..."})

inputs = payload.get("inputs")
if not isinstance(inputs, dict):
    finish({"error": "The inputs have to be an object of name → value."})
try:
    result = run_fn(**inputs)
except BaseException as e:
    finish({"error": f"Runtime error: {e}"})
finish({"result": str(result)})
'''


def _base_env(home: str) -> dict:
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": home,
        "TMPDIR": home,
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PYTHONIOENCODING": "utf-8",
    }


_ENV_KEY = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,127}$")


def _child_env(home: str, env_vars) -> dict:
    env = _base_env(home)
    for k, v in (env_vars or {}).items() if isinstance(env_vars, dict) else []:
        if isinstance(k, str) and _ENV_KEY.match(k) and v is not None:
            env[k] = str(v).replace("\x00", "")
    return env


def _kill_group(proc) -> None:
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except Exception:
        pass


# ─── packages ──────────────────────────────────────────────────────────────
#
# Installed once per set of packages per warm instance, into a folder of its
# own (keyed by the sorted list), never one shared folder that every
# customer's code imports from. A customer's code can write to /tmp, so it
# could plant a module in another set's folder; this process therefore keeps
# a fingerprint of every file it installed (in its own memory, which the code
# cannot reach) and re-checks it before each use: anything added or changed
# since, and the folder is thrown away and installed again. Per-request
# installs would be safer still and were rejected for latency: a chatbot that
# calls a tool on every turn would wait for pip on every turn.

PKG_ROOT = os.path.join(tempfile.gettempdir(), "8legs-tool-packages")
_FINGERPRINTS = {}

# a requirement, not an option: "requests", "pandas==2.2.2", "httpx[http2]>=0.27,<1"
_REQUIREMENT = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(\[[A-Za-z0-9._,-]{1,100}\])?"
    r"((===?|!=|<=|>=|~=|<|>)[A-Za-z0-9.*+!_-]{1,50}(,(===?|!=|<=|>=|~=|<|>)[A-Za-z0-9.*+!_-]{1,50}){0,4})?$"
)


def _fingerprint(path: str) -> str:
    h = hashlib.sha256()
    for root, dirs, files in os.walk(path):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(root, name)
            h.update(os.path.relpath(full, path).encode("utf-8", "surrogateescape"))
            h.update(b"\0")
            if os.path.islink(full):
                h.update(b"link:" + os.readlink(full).encode("utf-8", "surrogateescape"))
            else:
                with open(full, "rb") as fh:
                    for chunk in iter(lambda: fh.read(1 << 20), b""):
                        h.update(chunk)
            h.update(b"\0")
    return h.hexdigest()


def _packages_dir(packages):
    """Returns (folder or None, error or None)."""
    if not packages:
        return None, None
    if not isinstance(packages, list) or len(packages) > 30:
        return None, "packages has to be a list of at most 30 package names"
    clean = []
    for p in packages:
        p = str(p).strip()
        if not _REQUIREMENT.match(p):
            return None, f"Not a package name: {p[:80]!r}"
        clean.append(p)
    clean = sorted(set(clean))
    key = hashlib.sha256(json.dumps([sys.version, clean]).encode()).hexdigest()[:32]
    target = os.path.join(PKG_ROOT, key)

    known = _FINGERPRINTS.get(key)
    if known and os.path.isdir(target) and not os.path.islink(target):
        try:
            if _fingerprint(target) == known:
                return target, None
        except Exception:
            pass

    if os.path.islink(target):
        os.unlink(target)
    shutil.rmtree(target, ignore_errors=True)
    os.makedirs(target, exist_ok=True)
    home = tempfile.mkdtemp(prefix="8legs-pip-")
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
             "--no-input", "--target", target, "--", *clean],
            capture_output=True, text=True, timeout=PIP_TIMEOUT,
            env=_base_env(home), cwd=home,
        )
        if result.returncode != 0:
            shutil.rmtree(target, ignore_errors=True)
            return None, f"pip install failed:\n{(result.stderr or result.stdout)[:600]}"
        _FINGERPRINTS[key] = _fingerprint(target)
        return target, None
    except subprocess.TimeoutExpired:
        shutil.rmtree(target, ignore_errors=True)
        return None, f"pip install did not finish within {PIP_TIMEOUT} seconds"
    except Exception as e:
        shutil.rmtree(target, ignore_errors=True)
        return None, f"pip install error: {e}"
    finally:
        shutil.rmtree(home, ignore_errors=True)


# ─── one run ───────────────────────────────────────────────────────────────

def _run(code, inputs, packages, env_vars) -> dict:
    """
    Execute the tool code and call its run(**kwargs) function.

    The tool code must define a function named `run` that accepts **kwargs.
    Packages are installed before execution. env_vars are available via
    os.environ — and they are the only variables there.
    """
    if not isinstance(code, str) or not code.strip():
        return {"error": "Tool has no code"}

    pkg_dir, err = _packages_dir(packages)
    if err:
        return {"error": err}

    work = tempfile.mkdtemp(prefix="8legs-run-")
    result_path = os.path.join(work, ".result.json")
    log_path = os.path.join(work, ".output.log")
    proc = None
    try:
        payload = {
            "code": code,
            "inputs": inputs if inputs is not None else {},
            "paths": [pkg_dir] if pkg_dir else [],
            "result_path": result_path,
        }
        with open(log_path, "wb") as log:
            proc = subprocess.Popen(
                [sys.executable, "-I", "-B", "-c", CHILD],
                stdin=subprocess.PIPE, stdout=log, stderr=log,
                env=_child_env(work, env_vars), cwd=work, start_new_session=True,
            )
            try:
                proc.communicate(json.dumps(payload).encode("utf-8"), timeout=RUN_TIMEOUT)
            except subprocess.TimeoutExpired:
                return {"error": f"Runtime error: the tool did not finish within {RUN_TIMEOUT} seconds"}
        try:
            if os.path.getsize(result_path) > MAX_RESULT:
                return {"error": "The tool returned more than 5 MB"}
            with open(result_path, encoding="utf-8") as fh:
                out = json.load(fh)
            if isinstance(out, dict) and ("result" in out or "error" in out):
                return {k: out[k] for k in ("result", "error") if k in out}
        except FileNotFoundError:
            pass
        except Exception as e:
            return {"error": f"Runtime error: unreadable result ({e})"}
        tail = ""
        try:
            with open(log_path, "rb") as fh:
                fh.seek(max(0, os.path.getsize(log_path) - 1500))
                tail = fh.read().decode("utf-8", "replace").strip()
        except Exception:
            pass
        return {"error": "Runtime error: the tool stopped without returning" + (f"\n{tail}" if tail else "")}
    finally:
        if proc is not None:
            _kill_group(proc)
        shutil.rmtree(work, ignore_errors=True)


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
            return self._reply(413, {"error": "request too large"})
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception:
            return self._reply(400, {"error": "the body is not JSON"})
        if not isinstance(body, dict):
            return self._reply(400, {"error": "the body is not a JSON object"})

        result = _run(body.get("code", ""), body.get("inputs", {}), body.get("packages", []), body.get("env_vars", {}))
        return self._reply(200, result)

    def log_message(self, *args):
        pass  # suppress access logs
