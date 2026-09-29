"""Real-process persistence acceptance. Never opens the workspace's normal database.

Run: cd apps/api && uv run python ../../scripts/verify_persistence.py
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

import httpx

ROOT = Path(__file__).resolve().parents[1]
API_DIRECTORY = ROOT / "apps/api"


def run(command, environment):
    result = subprocess.run(
        command, cwd=API_DIRECTORY, env=environment, capture_output=True, text=True, timeout=90
    )
    if result.returncode:
        raise AssertionError(f"Subprocess failed: {result.stderr[-5000:]}\n{result.stdout[-2000:]}")
    return result.stdout


def api(client, method, path, **kwargs):
    response = client.request(method, "/api/v1" + path, **kwargs)
    assert response.status_code == 200, (method, path, response.status_code, response.text[:2000])
    return response.json()


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def main():
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="workbench-persistence-") as directory:
        temporary = Path(directory)
        with socket.socket() as bound:
            bound.bind(("127.0.0.1", 0))
            port = bound.getsockname()[1]
        environment = os.environ | {
            "DATABASE_PATH": str(temporary / "isolated.sqlite3"),
            "TEST_ARTIFACT_ROOT": str(temporary),
            "TEST_API_PORT": str(port),
            "APP_MODE": "demo",
        }
        run([sys.executable, "-m", "alembic", "upgrade", "head"], environment)
        seed_code = "from pathlib import Path; import os,json; import app.seed as seed; seed.ROOT=Path(os.environ['TEST_ARTIFACT_ROOT']); print(json.dumps(seed.run_seed()))"
        initialized = json.loads(run([sys.executable, "-c", seed_code], environment))
        assert initialized["counts"]["orders"] == 10000
        launch_code = "from pathlib import Path; import os; import app.seed as seed; seed.ROOT=Path(os.environ['TEST_ARTIFACT_ROOT']); import uvicorn; uvicorn.run('app.main:app',host='127.0.0.1',port=int(os.environ['TEST_API_PORT']),log_level='warning')"
        log = (temporary / "api.log").open("w+")

        def launch():
            process = subprocess.Popen(
                [sys.executable, "-c", launch_code],
                cwd=API_DIRECTORY,
                env=environment,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=45)
            for _ in range(100):
                if process.poll() is not None:
                    log.seek(0)
                    raise AssertionError("API exited before readiness: " + log.read()[-4000:])
                try:
                    response = client.get("/health/ready")
                    if response.status_code == 200:
                        return process, client
                except httpx.ConnectError:
                    pass
                time.sleep(0.05)
            stop(process)
            raise AssertionError("API readiness timed out")

        first, client = launch()
        first_pid = first.pid
        try:
            baseline = api(client, "GET", "/analytics")["summary"]
            target_baseline = next(
                row
                for row in api(client, "GET", "/targets?month=2026-09")["items"]
                if row["store_id"] == "pdd-1"
            )["target"]
            preview = api(
                client,
                "POST",
                "/costs/preview",
                json={
                    "sku_ids": ["SKU001"],
                    "scope": "store",
                    "scope_id": "temu-1",
                    "unit_cost": "88.5500",
                    "adjustment_type": "absolute",
                    "adjustment_value": "88.5500",
                    "effective_from": "2026-10-01",
                    "note": "独立进程持久化验收",
                },
            )
            committed = api(
                client,
                "POST",
                "/operations/commit",
                json={"preview_id": preview["preview_id"], "idempotency_key": "persistence-cost"},
            )
            api(
                client,
                "PUT",
                "/targets/pdd-1/2026-09",
                json={"target": "123456.78", "idempotency_key": "persistence-target"},
            )
            report = api(
                client,
                "POST",
                "/reports/views",
                json={
                    "name": "重启后应保留的视图",
                    "report_type": "products",
                    "filters": {"channel_ids": "temu", "sku_ids": "SKU001"},
                    "columns": ["name", "revenue", "profit"],
                    "sort": {"by": "profit", "direction": "desc"},
                },
            )
            revision_before_restart = api(client, "GET", "/meta")["revision"]
            assert api(client, "GET", "/analytics")["summary"] == baseline, (
                "Future cost must not alter past snapshots"
            )
        finally:
            client.close()
            stop(first)

        skipped = json.loads(run([sys.executable, "-c", seed_code], environment))
        assert skipped["status"] == "already_initialized"
        assert skipped["revision"] == revision_before_restart
        second, client = launch()
        second_pid = second.pid
        try:
            assert second_pid != first_pid
            history = api(client, "GET", "/costs/SKU001/history")["items"]
            assert any(
                row["unit_cost"] == "88.5500" and row["note"] == "独立进程持久化验收" for row in history
            )
            targets = api(client, "GET", "/targets?month=2026-09")["items"]
            assert next(row["target"] for row in targets if row["store_id"] == "pdd-1") == "123456.78"
            assert api(client, "GET", "/reports/views")["items"] == [report]
            assert api(client, "GET", "/meta")["revision"] == revision_before_restart
            assert api(client, "GET", "/analytics")["summary"] == baseline
            replay = api(
                client,
                "POST",
                "/operations/commit",
                json={"preview_id": preview["preview_id"], "idempotency_key": "persistence-cost"},
            )
            assert replay == committed, "Operation retry after restart must return original receipt"
            reset = api(client, "POST", "/demo/reset", json={"confirm": True})
            assert reset["revision"] > revision_before_restart
            assert api(client, "GET", "/reports/views")["items"] == []
            restored_history = api(client, "GET", "/costs/SKU001/history")["items"]
            assert not any(row["note"] == "独立进程持久化验收" for row in restored_history)
            restored_targets = api(client, "GET", "/targets?month=2026-09")["items"]
            assert (
                next(row["target"] for row in restored_targets if row["store_id"] == "pdd-1")
                == target_baseline
            )
            assert api(client, "GET", "/analytics")["summary"] == baseline
            assert api(client, "GET", "/meta")["revision"] == reset["revision"]
        finally:
            client.close()
            stop(second)
            log.close()
        result = {
            "passed": True,
            "isolated_database": True,
            "process_ids": [first_pid, second_pid],
            "verified": [
                "cost_version_persistence",
                "target_persistence",
                "saved_view_persistence",
                "revision_persistence",
                "historical_snapshots_unchanged",
                "ordinary_seed_preserves_edits",
                "cross_process_idempotency",
                "explicit_reset_restores_data",
                "reset_advances_revision",
            ],
            "revision_before_restart": revision_before_restart,
            "revision_after_reset": reset["revision"],
            "elapsed_seconds": round(time.monotonic() - started, 2),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
