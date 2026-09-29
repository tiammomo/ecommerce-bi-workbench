import argparse
import sqlite3
from datetime import datetime
from pathlib import Path

from .db import DB_PATH, ROOT


def main():
    parser = argparse.ArgumentParser(description="多渠道经营工作台本地维护")
    parser.add_argument("command", choices=["migrate", "seed", "reset", "backup"])
    parser.add_argument("--output")
    parser.add_argument("--confirm", action="store_true")
    args = parser.parse_args()
    if args.command == "migrate":
        from alembic.config import Config
        from alembic import command

        cfg = Config(str(ROOT / "apps/api/alembic.ini"))
        command.upgrade(cfg, "head")
        print(f"数据库迁移完成：{DB_PATH}")
    elif args.command in ("seed", "reset"):
        from .seed import run_seed

        if args.command == "reset" and not args.confirm:
            parser.error("恢复演示数据会清除当前工作区修改，请追加 --confirm")
        print(run_seed(reset=args.command == "reset"))
    elif args.command == "backup":
        output = Path(
            args.output or str(ROOT / ".localdata" / f"backup-{datetime.now():%Y%m%d-%H%M%S}.sqlite3")
        )
        if output.resolve() == DB_PATH.resolve():
            parser.error("备份路径不能是当前数据库")
        output.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(DB_PATH) as source, sqlite3.connect(output) as dest:
            source.backup(dest)
        print(f"一致性备份已保存：{output.resolve()}")


if __name__ == "__main__":
    main()
