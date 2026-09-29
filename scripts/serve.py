#!/usr/bin/env python3
"""Serve the built frontend and API from one local port."""

from pathlib import Path
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]
if not (ROOT / "apps/web/dist/index.html").exists():
    raise SystemExit("请先在项目根目录运行 pnpm build。")
subprocess.run(
    [
        "uv",
        "run",
        "uvicorn",
        "app.main:app",
        "--host",
        os.getenv("API_HOST", "127.0.0.1"),
        "--port",
        os.getenv("API_PORT", "8000"),
    ],
    cwd=ROOT / "apps/api",
    check=True,
)
