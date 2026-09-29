#!/usr/bin/env python3
"""Run only this workspace's development processes, and stop them together."""

from __future__ import annotations

import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]


def available(host: str, port: int) -> None:
    with socket.socket() as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
        except OSError as exc:
            raise SystemExit(
                f"端口 {host}:{port} 已被占用。请设置 API_PORT / WEB_PORT，或自行停止对应服务。"
            ) from exc


def main() -> int:
    host = os.environ.get("API_HOST", "127.0.0.1")
    api_port = int(os.environ.get("API_PORT", "8000"))
    web_port = int(os.environ.get("WEB_PORT", "5173"))
    available(host, api_port)
    available("127.0.0.1", web_port)
    children: list[subprocess.Popen] = []

    def stop(*_args: object) -> None:
        for child in children:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    env = os.environ.copy()
    env["API_PORT"] = str(api_port)
    env["VITE_API_PROXY"] = f"http://{host}:{api_port}"
    env["API_PROXY_TARGET"] = f"http://{host}:{api_port}"
    try:
        children.append(
            subprocess.Popen(
                ["uv", "run", "uvicorn", "app.main:app", "--host", host, "--port", str(api_port), "--reload"],
                cwd=ROOT / "apps/api",
                env=env,
                start_new_session=True,
            )
        )
        children.append(
            subprocess.Popen(
                [
                    "pnpm",
                    "--filter",
                    "web",
                    "dev",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(web_port),
                    "--strictPort",
                ],
                cwd=ROOT,
                env=env,
                start_new_session=True,
            )
        )
        print(f"\n多渠道经营工作台 http://127.0.0.1:{web_port}", flush=True)
        print(f"API 文档 http://{host}:{api_port}/docs\n按 Ctrl+C 停止本次启动的服务。\n", flush=True)
        deadline = time.monotonic() + 45
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        while all(child.poll() is None for child in children):
            try:
                with opener.open(f"http://127.0.0.1:{web_port}/api/v1/health/ready", timeout=1) as response:
                    if response.status == 200:
                        print("WORKBENCH_READY", flush=True)
                        break
            except (OSError, urllib.error.URLError):
                pass
            if time.monotonic() > deadline:
                raise SystemExit("服务未在 45 秒内就绪，请检查上面的初始化或端口错误。")
            time.sleep(0.2)
        while all(child.poll() is None for child in children):
            time.sleep(0.4)
        return next((child.returncode for child in children if child.returncode), 0)
    finally:
        stop()
        for child in children:
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()


if __name__ == "__main__":
    sys.exit(main())
