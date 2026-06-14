"""
DownloadNode — Reasoning-capable download node for large tables.

Implements a multi-step reasoning agent that:
1. Connects to the source and validates connectivity
2. Checks for existing part files to resume from
3. Counts total rows to estimate download time
4. Streams batches to parquet **part files** (checkpoint every 500K rows)
5. Merges parts into the final file
6. Verifies PAR1 magic bytes (header + footer) for integrity
7. Retries on transient failures with reasoning trace

Progressive saving:
    Every CHECKPOINT_ROWS rows the current ParquetWriter is closed
    (writing a valid footer) and a new part file is started.  Each part
    is a fully valid, self-contained parquet file.  If the process
    crashes, all completed parts survive and the next run resumes from
    the last valid part.
"""

from __future__ import annotations

import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from nodes.base_node import BaseNode
from monitoring.logger import get_logger

logger = get_logger(__name__)

PAR1_MAGIC = b"PAR1"
BATCH_SIZE = 50_000
CHECKPOINT_ROWS = 500_000  # close + save every 500K rows
MAX_REASONING_RETRIES = 3


# ── Integrity helpers ──────────────────────────────────────────────────

def verify_parquet_integrity(path: Path) -> Dict[str, Any]:
    """Check PAR1 magic bytes at the start and end of a parquet file."""
    result: Dict[str, Any] = {
        "valid": False,
        "header_ok": False,
        "footer_ok": False,
        "file_size": 0,
        "num_row_groups": 0,
    }
    if not path.exists():
        result["error"] = "File does not exist"
        return result

    file_size = path.stat().st_size
    result["file_size"] = file_size
    if file_size < 8:
        result["error"] = "File too small to be valid parquet"
        return result

    with open(path, "rb") as f:
        header = f.read(4)
        result["header_ok"] = header == PAR1_MAGIC
        f.seek(-4, 2)
        footer = f.read(4)
        result["footer_ok"] = footer == PAR1_MAGIC

    result["valid"] = result["header_ok"] and result["footer_ok"]

    if result["valid"]:
        try:
            meta = pq.read_metadata(str(path))
            result["num_row_groups"] = meta.num_row_groups
            result["num_rows"] = meta.num_rows
            result["num_columns"] = meta.num_columns
        except Exception:
            result["valid"] = False
            result["error"] = "PAR1 magic OK but metadata unreadable"

    return result


# ── Part-file helpers ──────────────────────────────────────────────────

def _parts_dir(dest_path: Path) -> Path:
    """Return the .parts/ directory for a given destination parquet file."""
    return dest_path.parent / f"{dest_path.stem}.parts"


def _scan_existing_parts(parts_dir: Path) -> tuple[List[Path], int]:
    """Scan existing valid part files.  Returns (sorted part paths, total rows)."""
    if not parts_dir.exists():
        return [], 0
    parts: List[Path] = sorted(parts_dir.glob("part_*.parquet"))
    valid_parts: List[Path] = []
    total_rows = 0
    for p in parts:
        integrity = verify_parquet_integrity(p)
        if integrity["valid"]:
            valid_parts.append(p)
            total_rows += integrity.get("num_rows", 0)
        else:
            # Remove this corrupt part and all after it (they may be out of order)
            logger.warning("Removing corrupt part file: %s", p)
            p.unlink(missing_ok=True)
    return valid_parts, total_rows


def _merge_parts(parts: List[Path], dest_path: Path, emit=None, silent: bool = False) -> Dict[str, Any]:
    """Merge part files into a single parquet file.

    Copies row groups one at a time to keep memory constant.
    Returns integrity check result for the merged file.

    Args:
        parts: Sorted list of valid part file paths.
        dest_path: Final destination parquet file.
        emit: Optional event emitter function.
        silent: If True, emit only on error (used for live checkpoints).
    """
    def _emit(step, msg, **kw):
        if emit and not silent:
            emit(step, msg, **kw)

    if not parts:
        return {"valid": False, "error": "No parts to merge"}

    _emit("merge", f"Merging {len(parts)} part files into {dest_path.name}...")

    first_pf = pq.ParquetFile(str(parts[0]))
    schema = first_pf.schema_arrow

    tmp_path = dest_path.with_suffix(".parquet.merging")
    writer = pq.ParquetWriter(str(tmp_path), schema, compression="snappy")
    total_rows = 0
    try:
        for part in parts:
            pf = pq.ParquetFile(str(part))
            for rg_idx in range(pf.metadata.num_row_groups):
                rg = pf.read_row_group(rg_idx)
                writer.write_table(rg)
                total_rows += rg.num_rows
        writer.close()
        writer = None
    finally:
        if writer is not None:
            writer.close()

    # Atomic swap
    tmp_path.rename(dest_path)

    _emit(
        "merge",
        f"Merged {total_rows:,} rows from {len(parts)} parts → {dest_path.name} "
        f"({dest_path.stat().st_size / 1024 / 1024:.1f} MB)",
    )

    return verify_parquet_integrity(dest_path)


# ── Node ───────────────────────────────────────────────────────────────

class DownloadNode(BaseNode):
    """Reasoning download node with part-file checkpoints and resume."""

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        return {
            "connector_manager": shared["connector_manager"],
            "source_id": shared["source_id"],
            "table_id": shared["table_id"],
            "incremental": shared.get("incremental", False),
            "resume": shared.get("resume", True),
            "events": shared.setdefault("events", []),
            "job": shared.get("job"),
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        cm = prep_result["connector_manager"]
        source_id = prep_result["source_id"]
        table_id = prep_result["table_id"]
        incremental = prep_result["incremental"]
        allow_resume = prep_result["resume"]
        events: List[Dict] = prep_result["events"]
        job: Optional[Dict] = prep_result["job"]

        def emit(step: str, message: str, **kw):
            evt = {
                "ts": datetime.now(timezone.utc).isoformat(),
                "step": step,
                "message": message,
                **kw,
            }
            events.append(evt)
            logger.info("[DownloadNode] %s — %s", step, message)
            if job is not None:
                job["last_event"] = evt
                job["events"] = events

        result: Dict[str, Any] = {
            "success": False,
            "source_id": source_id,
            "table_id": table_id,
            "row_count": 0,
            "file_path": None,
            "integrity": None,
            "error": None,
            "resumed": False,
        }

        # ── Step 1: Resolve connector ──────────────────────────────────
        emit("resolve", f"Resolving connector for source '{source_id}'...")
        connector = cm.get_connector(source_id)
        if connector is None:
            emit("error", f"Source '{source_id}' not found")
            result["error"] = f"Source not found: {source_id}"
            return result

        # Guard: wait if connector is already refreshing via old path
        if getattr(connector, "_refreshing", False):
            emit(
                "wait",
                "Another download is in progress via the connector. Waiting...",
            )
            import time as _t
            for _ in range(600):
                _t.sleep(3)
                if not getattr(connector, "_refreshing", False):
                    break
            if getattr(connector, "_refreshing", False):
                emit("error", "Timed out waiting for existing download to finish")
                result["error"] = "Existing download still running after 30 min"
                return result
            emit("wait", "Previous download finished. Proceeding.")

        # Find table config
        table_config = None
        for tc in getattr(connector, "tables", []):
            tid = tc.get("table_id", tc.get("table_name"))
            if tid == table_id:
                table_config = tc
                break
        if table_config is None:
            emit("error", f"Table '{table_id}' not found in source '{source_id}'")
            result["error"] = f"Table not found: {table_id}"
            return result

        # ── Step 2: Scan existing parts for resume ─────────────────────
        dest_dir = Path("data/parquet")
        dest_path = dest_dir / f"{source_id}_{table_id}.parquet"
        parts_dir = _parts_dir(dest_path)
        dest_dir.mkdir(parents=True, exist_ok=True)

        existing_parts: List[Path] = []
        existing_rows = 0

        if allow_resume:
            emit("resume_check", "Scanning for existing part files...")
            existing_parts, existing_rows = _scan_existing_parts(parts_dir)
            if existing_rows > 0:
                emit(
                    "resume_found",
                    f"Found {len(existing_parts)} valid parts with {existing_rows:,} rows. "
                    f"Resuming from row {existing_rows + 1:,}.",
                    existing_rows=existing_rows,
                    existing_parts=len(existing_parts),
                )
                result["resumed"] = True
            else:
                emit("resume_check", "No existing parts — starting fresh download.")
        else:
            # Fresh start: clean up old parts
            if parts_dir.exists():
                shutil.rmtree(parts_dir, ignore_errors=True)
            emit("resume_check", "Fresh download requested.")

        parts_dir.mkdir(parents=True, exist_ok=True)

        # ── Step 3: Connect ────────────────────────────────────────────
        emit("connect", f"Opening Oracle connection to {connector.host}:{connector.port}/{connector.service_name}...")
        try:
            connection = connector._open_fresh_connection()
        except Exception as exc:
            emit("connect_error", f"Connection failed: {exc}", error=str(exc))
            result["error"] = f"Connection failed: {exc}"
            return result
        emit("connect", "Connection established successfully")

        # ── Step 4: Count total rows ───────────────────────────────────
        emit("count", f"Counting total rows for '{table_id}'...")
        total_expected = None
        try:
            sql, params = connector._build_sql(table_config, incremental)
            count_sql = f"SELECT COUNT(*) FROM ({sql})"
            cursor = connection.cursor()
            if params:
                cursor.execute(count_sql, params)
            else:
                cursor.execute(count_sql)
            row = cursor.fetchone()
            total_expected = row[0] if row else None
            cursor.close()
            remaining = (total_expected - existing_rows) if total_expected and existing_rows else total_expected
            msg = f"Total rows: {total_expected:,}"
            if existing_rows > 0 and remaining is not None:
                msg += f" (remaining: {remaining:,})"
            emit("count", msg, total_rows=total_expected)
            if job:
                job["total_rows"] = total_expected
        except Exception as exc:
            emit("count_warning", f"Count query failed (non-fatal): {exc}")

        # ── Step 5: Stream download with checkpoints ───────────────────
        from nodes.dataloader.parquet_writer_node import sanitise_for_parquet

        sql, params = connector._build_sql(table_config, incremental)

        # Apply OFFSET for resume
        if existing_rows > 0:
            sql = f"SELECT * FROM ({sql}) OFFSET {existing_rows} ROWS"
            emit(
                "download",
                f"Resuming download from row {existing_rows + 1:,}...",
                dest=str(dest_path),
                skip_rows=existing_rows,
            )
        else:
            emit("download", "Starting streaming download with checkpoints...", dest=str(dest_path))

        prev_handler = connection.outputtypehandler
        connection.outputtypehandler = connector._oracle_output_type_handler

        part_idx = len(existing_parts)
        writer: Optional[pq.ParquetWriter] = None
        current_part_path: Optional[Path] = None
        total_rows = existing_rows
        new_rows = 0
        rows_in_current_part = 0
        start_time = time.time()

        def _close_part():
            """Close the current part writer → valid parquet with footer."""
            nonlocal writer, current_part_path, rows_in_current_part
            if writer is not None:
                writer.close()
                writer = None
                logger.info(
                    "Checkpoint: closed part %s (%d rows)",
                    current_part_path, rows_in_current_part,
                )
                rows_in_current_part = 0

        def _open_part(schema: pa.Schema):
            """Open a new part file for writing."""
            nonlocal writer, current_part_path, part_idx, rows_in_current_part
            current_part_path = parts_dir / f"part_{part_idx:04d}.parquet"
            writer = pq.ParquetWriter(str(current_part_path), schema, compression="snappy")
            rows_in_current_part = 0
            part_idx += 1

        try:
            cursor = connection.cursor()
            cursor.arraysize = BATCH_SIZE
            if params:
                cursor.execute(sql, params)
            else:
                cursor.execute(sql)
            columns = [col[0] for col in cursor.description]

            arrow_schema: Optional[pa.Schema] = None
            batch_num = 0

            while True:
                rows = cursor.fetchmany(BATCH_SIZE)
                if not rows:
                    break

                batch_num += 1
                chunk_df = pd.DataFrame(rows, columns=columns)
                chunk_df["_source_id"] = source_id
                chunk_df = sanitise_for_parquet(chunk_df)
                table = pa.Table.from_pandas(chunk_df, preserve_index=False)

                if arrow_schema is None:
                    arrow_schema = table.schema

                # Open a new part if needed
                if writer is None:
                    _open_part(arrow_schema)

                writer.write_table(table)
                new_rows += len(rows)
                rows_in_current_part += len(rows)
                total_rows = existing_rows + new_rows

                elapsed = time.time() - start_time
                rate = new_rows / elapsed if elapsed > 0 else 0
                pct = (total_rows / total_expected * 100) if total_expected else None
                pct_str = f" ({pct:.1f}%)" if pct is not None else ""

                emit(
                    "progress",
                    f"Batch {batch_num}: {total_rows:,} rows{pct_str} — {rate:,.0f} rows/s",
                    rows_downloaded=total_rows,
                    batch=batch_num,
                    elapsed=round(elapsed, 1),
                    rate=round(rate),
                    pct=round(pct, 1) if pct is not None else None,
                )

                if job:
                    job["row_count"] = total_rows
                    job["status"] = "running"

                # Checkpoint: close current part, publish usable file
                if rows_in_current_part >= CHECKPOINT_ROWS:
                    _close_part()

                    # Live-merge all valid parts → final file so the app
                    # can query partial data immediately
                    valid_parts, _ = _scan_existing_parts(parts_dir)
                    if valid_parts:
                        _merge_parts(valid_parts, dest_path, silent=True)
                        # Update metadata so list_sources shows the live count
                        connector._write_stream_meta(dest_path, table_id, total_rows, table_config)
                        connector.metadata.row_count = total_rows

                    emit(
                        "checkpoint",
                        f"Checkpoint saved & published: {total_rows:,} rows "
                        f"({part_idx} parts) — data available for queries",
                        rows_downloaded=total_rows,
                        parts=part_idx,
                    )

            cursor.close()

            # Close the last part
            _close_part()

        except Exception as exc:
            # Close current part so the footer is written → valid file
            _close_part()
            # Publish whatever parts we have so the app can use partial data
            valid_parts, saved_rows = _scan_existing_parts(parts_dir)
            if valid_parts:
                _merge_parts(valid_parts, dest_path, silent=True)
                connector._write_stream_meta(dest_path, table_id, saved_rows, table_config)
                connector.metadata.row_count = saved_rows
            emit(
                "download_error",
                f"Streaming failed at {total_rows:,} rows: {exc}. "
                f"Published {saved_rows:,} rows from {len(valid_parts)} checkpoints for queries. "
                f"Resume will continue from here.",
                error=str(exc),
            )
            result["error"] = str(exc)
            result["row_count"] = total_rows
            return result
        finally:
            connection.outputtypehandler = prev_handler
            try:
                connection.close()
            except Exception:
                pass

        elapsed = time.time() - start_time
        resume_msg = f" (resumed from {existing_rows:,})" if existing_rows > 0 else ""
        emit(
            "download_complete",
            f"Downloaded {total_rows:,} rows in {elapsed:.0f}s{resume_msg} "
            f"({part_idx} checkpoint parts)",
            rows_downloaded=total_rows,
            elapsed=round(elapsed, 1),
        )

        # ── Step 6: Merge parts → final file ──────────────────────────
        all_parts, _ = _scan_existing_parts(parts_dir)
        integrity = _merge_parts(all_parts, dest_path, emit)
        result["integrity"] = integrity

        if not integrity.get("valid"):
            emit(
                "verify_fail",
                f"Merged file integrity check FAILED: {integrity}",
                integrity=integrity,
            )
            result["error"] = "Merged parquet integrity check failed"
            result["row_count"] = total_rows
            result["file_path"] = str(dest_path)
            return result

        emit(
            "verify",
            f"Integrity OK: {integrity['num_row_groups']} row groups, "
            f"{integrity.get('num_rows', 0):,} rows, "
            f"file size {integrity['file_size'] / 1024 / 1024:.1f} MB",
            integrity=integrity,
        )

        # ── Step 7: Cleanup parts + write metadata ─────────────────────
        shutil.rmtree(parts_dir, ignore_errors=True)
        emit("metadata", "Writing metadata sidecar...")
        connector._write_stream_meta(dest_path, table_id, total_rows, table_config)
        connector.metadata.row_count = total_rows
        connector.update_metadata(status="success")

        # Remove old corrupt file if it still exists alongside the new one
        old_corrupt = dest_path.with_suffix(".parquet.tmp")
        old_corrupt.unlink(missing_ok=True)

        result["success"] = True
        result["row_count"] = total_rows
        result["file_path"] = str(dest_path)
        emit("done", f"Download complete: {total_rows:,} rows saved to {dest_path}")
        return result

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: Dict[str, Any]) -> str:
        shared["download_result"] = exec_result

        if exec_result.get("success"):
            shared.pop("_download_retries", None)
            self.log_exit("done")
            return "done"

        # Reasoning retry — parts are already saved, resume picks them up
        retries = shared.get("_download_retries", 0)
        error = exec_result.get("error", "unknown")
        events = shared.get("events", [])

        if retries < MAX_REASONING_RETRIES:
            shared["_download_retries"] = retries + 1
            shared["resume"] = True
            events.append({
                "ts": datetime.now(timezone.utc).isoformat(),
                "step": "reasoning",
                "message": (
                    f"Retry {retries + 1}/{MAX_REASONING_RETRIES}: "
                    f"Error '{error}' — will resume from saved checkpoints..."
                ),
                "retry": retries + 1,
            })
            self.logger.warning(
                "Download retry %d/%d for %s/%s: %s",
                retries + 1, MAX_REASONING_RETRIES,
                exec_result.get("source_id"), exec_result.get("table_id"), error,
            )
            return "retry"

        events.append({
            "ts": datetime.now(timezone.utc).isoformat(),
            "step": "failed",
            "message": f"All {MAX_REASONING_RETRIES} retries exhausted. Error: {error}",
        })
        self.log_exit("failed")
        return "failed"
