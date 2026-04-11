from http.server import BaseHTTPRequestHandler
import json


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")

        code = body.get("code", "")
        inputs = body.get("inputs", {})

        result = _run(code, inputs)

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


def _run(code: str, inputs: dict) -> dict:
    """
    Execute the tool code and call its run(**kwargs) function.

    The tool code must define a function named `run` that accepts **kwargs.
    Example:
        def run(**kwargs):
            age = kwargs.get("age")
            return f"You are {age} years old."
    """
    if not code.strip():
        return {"error": "Tool has no code"}

    namespace = {}
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
