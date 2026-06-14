"""
Refresh Scheduler for automatic data source updates.

Manages background refresh tasks for data sources with polling policies.
"""

import logging
import threading
import time
from typing import Dict, Optional, TYPE_CHECKING
import schedule

if TYPE_CHECKING:
    from services.connector_manager import ConnectorManager

logger = logging.getLogger(__name__)


class RefreshScheduler:
    """
    Background scheduler for automatic data source refresh.

    Features:
    - Registers sources with polling policy
    - Executes refresh on configurable intervals
    - Runs in background thread
    - Automatic error handling and retry logic
    """

    def __init__(self, connector_manager: 'ConnectorManager'):
        """
        Initialize refresh scheduler.

        Args:
            connector_manager: ConnectorManager instance to manage refreshes
        """
        self.connector_manager = connector_manager
        self.scheduler = schedule.Scheduler()
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.stop_event = threading.Event()

        # Track scheduled jobs per source
        self.scheduled_jobs: Dict[str, schedule.Job] = {}

        logger.info("RefreshScheduler initialized")

    def register_source(self, source_id: str, interval_seconds: int):
        """
        Register a data source for automatic refresh.

        Args:
            source_id: Identifier of the source to refresh
            interval_seconds: Refresh interval in seconds

        Raises:
            ValueError: If source not found or already registered
        """
        connector = self.connector_manager.get_connector(source_id)
        if connector is None:
            raise ValueError(f"Connector not found: {source_id}")

        if source_id in self.scheduled_jobs:
            logger.warning(
                f"Source '{source_id}' already registered for refresh, "
                "updating interval"
            )
            self.unregister_source(source_id)

        # Schedule refresh job
        job = self.scheduler.every(interval_seconds).seconds.do(
            self._refresh_source_task,
            source_id=source_id
        )

        self.scheduled_jobs[source_id] = job

        logger.info(
            f"Registered source '{source_id}' for automatic refresh "
            f"every {interval_seconds} seconds ({interval_seconds / 60:.1f} minutes)"
        )

    def unregister_source(self, source_id: str):
        """
        Unregister a data source from automatic refresh.

        Args:
            source_id: Identifier of the source
        """
        if source_id in self.scheduled_jobs:
            job = self.scheduled_jobs.pop(source_id)
            self.scheduler.cancel_job(job)
            logger.info(f"Unregistered source '{source_id}' from automatic refresh")

    def _refresh_source_task(self, source_id: str):
        """
        Background task to refresh a data source.

        Args:
            source_id: Identifier of the source to refresh
        """
        try:
            logger.info(f"[scheduler] Starting automatic refresh for '{source_id}'")
            start_time = time.time()

            # Attempt incremental refresh first, fallback to full
            success = self.connector_manager.refresh_source(
                source_id,
                incremental=True,
                force=True  # Ignore needs_refresh check (we're the scheduler)
            )

            duration = time.time() - start_time

            if success:
                connector = self.connector_manager.get_connector(source_id)
                logger.info(
                    f"[scheduler] Successfully refreshed '{source_id}' in {duration:.2f}s "
                    f"({connector.metadata.row_count:,} rows)"
                )
            else:
                logger.error(f"[scheduler] Failed to refresh '{source_id}'")

        except Exception as e:
            logger.error(
                f"[scheduler] Error refreshing source '{source_id}': {str(e)}",
                exc_info=True
            )

    def start(self):
        """
        Start the refresh scheduler in background thread.

        The scheduler will run until stop() is called.
        """
        if self.running:
            logger.warning("RefreshScheduler already running")
            return

        self.running = True
        self.stop_event.clear()

        # Start background thread
        self.thread = threading.Thread(
            target=self._run_scheduler,
            name="RefreshScheduler",
            daemon=True
        )
        self.thread.start()

        logger.info(
            f"RefreshScheduler started with {len(self.scheduled_jobs)} registered sources"
        )

    def _run_scheduler(self):
        """
        Main scheduler loop (runs in background thread).
        """
        logger.info("[scheduler] Background thread started")

        while self.running and not self.stop_event.is_set():
            try:
                # Run pending scheduled jobs
                self.scheduler.run_pending()

                # Sleep for 1 second before checking again
                self.stop_event.wait(timeout=1.0)

            except Exception as e:
                logger.error(f"[scheduler] Error in scheduler loop: {str(e)}", exc_info=True)
                # Continue running despite errors
                time.sleep(5)

        logger.info("[scheduler] Background thread stopped")

    def stop(self, timeout: float = 10.0):
        """
        Stop the refresh scheduler.

        Args:
            timeout: Maximum time to wait for thread to stop (seconds)
        """
        if not self.running:
            logger.warning("RefreshScheduler not running")
            return

        logger.info("Stopping RefreshScheduler...")
        self.running = False
        self.stop_event.set()

        # Wait for thread to finish
        if self.thread and self.thread.is_alive():
            self.thread.join(timeout=timeout)
            if self.thread.is_alive():
                logger.warning(
                    f"RefreshScheduler thread did not stop within {timeout}s"
                )

        logger.info("RefreshScheduler stopped")

    def get_next_run_times(self) -> Dict[str, Optional[float]]:
        """
        Get next scheduled run time for each source.

        Returns:
            Dictionary mapping source_id to next run time (seconds from now)
        """
        next_runs = {}

        for source_id, job in self.scheduled_jobs.items():
            next_run = job.next_run
            if next_run:
                # Calculate seconds until next run
                seconds_until = (next_run - schedule.datetime.datetime.now()).total_seconds()
                next_runs[source_id] = max(0, seconds_until)
            else:
                next_runs[source_id] = None

        return next_runs

    def get_status(self) -> Dict[str, any]:
        """
        Get scheduler status information.

        Returns:
            Dictionary with scheduler status
        """
        return {
            "running": self.running,
            "registered_sources": list(self.scheduled_jobs.keys()),
            "source_count": len(self.scheduled_jobs),
            "next_run_times": self.get_next_run_times(),
        }

    def __repr__(self) -> str:
        return (
            f"RefreshScheduler(running={self.running}, "
            f"sources={len(self.scheduled_jobs)})"
        )
