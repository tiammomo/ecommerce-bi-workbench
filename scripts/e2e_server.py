#!/usr/bin/env python3
"""Create a disposable SQLite workspace for browser acceptance tests."""

from pathlib import Path
import os
import subprocess
import sys
import tempfile

from dev import ROOT, main


with tempfile.TemporaryDirectory(prefix="ecommerce-bi-e2e-") as directory:
    os.environ["APP_MODE"] = "demo"
    os.environ["LOG_LEVEL"] = "WARNING"
    os.environ["DATABASE_PATH"] = str(Path(directory) / "acceptance.sqlite3")
    os.environ["API_PORT"] = os.getenv("E2E_API_PORT", "8011")
    os.environ["WEB_PORT"] = os.getenv("E2E_WEB_PORT", "5175")
    for command in ("migrate", "seed"):
        subprocess.run(["uv", "run", "python", "-m", "app.cli", command], cwd=ROOT / "apps/api", check=True)
    sys.exit(main())
