#!/usr/bin/env python3
"""Simple HTTP build server that runs inside the Cloudflare container."""

import http.server
import json
import os
import subprocess
import tempfile


class BuildHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/ping":
            body = b"pong"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_error(404, "Unknown endpoint")

    def do_POST(self):
        if self.path != "/run":
            self.send_error(404, "Unknown endpoint")
            return

        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            self.send_error(400, "Empty request body")
            return

        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError as exc:
            self.send_error(400, f"Invalid JSON: {exc}")
            return

        repo_url = payload.get("repoUrl")
        branch = payload.get("branch")
        commands = payload.get("commands", [])

        if not repo_url or not branch:
            self.send_error(400, "repoUrl and branch are required")
            return

        stdout_parts = []
        stderr_parts = []
        exit_code = 0

        with tempfile.TemporaryDirectory() as workdir:
            clone_result = subprocess.run(
                ["git", "clone", "--depth", "1", "--branch", branch, repo_url, workdir],
                capture_output=True,
                text=True,
            )
            stdout_parts.append(f"$ git clone --branch {branch} <repo>\n{clone_result.stdout}")
            stderr_parts.append(f"$ git clone --branch {branch} <repo>\n{clone_result.stderr}")
            if clone_result.returncode != 0:
                exit_code = clone_result.returncode
            else:
                for cmd in commands:
                    if exit_code != 0:
                        break
                    result = subprocess.run(cmd, shell=True, cwd=workdir, capture_output=True, text=True)
                    stdout_parts.append(f"$ {cmd}\n{result.stdout}")
                    stderr_parts.append(f"$ {cmd}\n{result.stderr}")
                    exit_code = result.returncode

        response = {
            "success": exit_code == 0,
            "exitCode": exit_code,
            "stdout": "\n".join(stdout_parts),
            "stderr": "\n".join(stderr_parts),
        }

        body = json.dumps(response).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} - {fmt % args}", flush=True)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    server = http.server.ThreadingHTTPServer(("0.0.0.0", port), BuildHandler)
    print(f"Build server listening on port {port}", flush=True)
    server.serve_forever()
