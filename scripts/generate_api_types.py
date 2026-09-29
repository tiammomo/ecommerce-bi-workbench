#!/usr/bin/env python3
"""Export FastAPI OpenAPI without a server, then generate TypeScript types."""

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
destination = ROOT / "packages/api-types"
destination.mkdir(parents=True, exist_ok=True)
schema = subprocess.check_output(
    [
        "uv",
        "run",
        "python",
        "-c",
        "import json; from app.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))",
    ],
    cwd=ROOT / "apps/api",
)
(destination / "openapi.json").write_bytes(schema)
subprocess.run(
    [
        "pnpm",
        "exec",
        "openapi-typescript",
        str(destination / "openapi.json"),
        "-o",
        str(destination / "index.d.ts"),
    ],
    cwd=ROOT,
    check=True,
)
