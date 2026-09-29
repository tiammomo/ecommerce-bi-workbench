#!/usr/bin/env python3
"""Explicit, repeatable first-time installation and demo initialization."""

from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def run(command: list[str], cwd: Path = ROOT) -> None:
    print("→ " + " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, check=True)


if __name__ == "__main__":
    run(["pnpm", "install"])
    run(["uv", "sync"], ROOT / "apps/api")
    run(["uv", "run", "python", "-m", "app.cli", "migrate"], ROOT / "apps/api")
    run(["uv", "run", "python", "-m", "app.cli", "seed"], ROOT / "apps/api")
    run(["python3", "scripts/generate_api_types.py"])
    print("\n初始化完成。运行 pnpm dev 打开工作台。")
