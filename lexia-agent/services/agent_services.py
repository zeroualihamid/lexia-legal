"""
QVD Agent - Handles chat interactions with QVD agents using streaming responses
"""

import sys
import os

from services.dataframe_services import DataFrameService

# Ensure project root is on sys.path when running this file directly.
# (Allows: `python services/agent_services.py` without ModuleNotFoundError for `lumo`.)
_project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

import os
import json
import asyncio
import logging
from datetime import datetime, timezone
import time
from dataclasses import dataclass
from threading import RLock
from typing import AsyncGenerator, Dict, Any, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from qclick.agents.qvd_agent import QvdAgent
else:
    QvdAgent = Any  # type: ignore

# Setup logger
logger = logging.getLogger(__name__)


@dataclass
class SessionMeta:
    last_activity_ts: float
    auth_close_deadline_ts: Optional[float] = None
    auth_close_warned: bool = False
    auth_close_kill_ts: Optional[float] = None


class AgentManager:
    """
    Singleton manager for storing and retrieving QvdAgent instances.
    """
    _instance = None
    _agents: Dict[str, 'QvdAgent'] = {}
    _meta: Dict[str, SessionMeta] = {}
    _event_queues: Dict[str, asyncio.Queue] = {}
    
    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._init_once()
        return cls._instance

    def _init_once(self):
        # Thread-safe guard for sync entrypoints
        self._lock = RLock()

        # Configurable durations (seconds)
        self.session_idle_ttl_s = int(os.getenv("SESSION_IDLE_TTL_S", "900"))          # 5 minutes
        # Rolling auth-close deadline updated on each chat activity
        self.auth_close_after_s = int(os.getenv("AUTH_CLOSE_AFTER_S", "300"))           # default 60s since last chat
        self.auth_close_grace_s = int(os.getenv("AUTH_CLOSE_GRACE_S", "50"))           # grace period after warning

        # Background idle loop control
        self._idle_loop_task: Optional[asyncio.Task] = None
        self._idle_loop_stop = asyncio.Event()

        # Sentinel to close SSE streams
        self._close_event_type = "__close__"
    
    def get_or_create_agent(self, session_id: str, authorization_token: Optional[str] = None, tool_stream_callback: callable = None, dataframe_service: DataFrameService = None, chart_callback: callable = None) -> 'QvdAgent':
        """
        Get existing agent or create a new one.
        
        Args:
            session_id: UUID string of the session
            authorization_token: Optional authorization token
            tool_stream_callback: Callback for streaming tool output (MUST be updated on each request)
            dataframe_service: DataFrameService instance
            chart_callback: Optional callback for spawning chart generation
            
        Returns:
            QvdAgent instance
        """
        key = session_id

        with self._lock:
            if key not in self._agents:
                logger.info(f"Creating new agent for session_id={session_id}")
                try:
                    from qclick.agents.qvd_agent import QvdAgent  # local import (avoids import-time hard dependency)
                    self._agents[key] = QvdAgent(session_id=session_id, authorization_token=authorization_token, tool_stream_callback=tool_stream_callback, dataframe_service=dataframe_service, chart_callback=chart_callback)
                except Exception:
                    logger.exception("Failed to create QvdAgent for session_id=%s", session_id)
                    raise
                self._meta[key] = SessionMeta(last_activity_ts=time.time())
            else:
                logger.info(f"Retrieving existing agent for session_id={session_id}")
                agent = self._agents[key]
                # CRITICAL: Update session_id, tool_stream_callback, and chart_callback on EVERY request
                # The callbacks are tied to the current request's event loop/queue
                if session_id:
                    agent.session_id = session_id
                if tool_stream_callback is not None:
                    agent.tool_stream_callback = tool_stream_callback
                    logger.info(f"Updated tool_stream_callback for session_id={session_id}")
                if chart_callback is not None:
                    agent.chart_callback = chart_callback
                    logger.info(f"Updated chart_callback for session_id={session_id}")
                # Reset the workflow to ensure fresh state for new request
                agent.flow = None

            # Ensure event queue exists
            if key not in self._event_queues:
                self._event_queues[key] = asyncio.Queue()

            return self._agents[key]
    
    def get_agent(self, session_id: str) -> Optional['QvdAgent']:
        """
        Get existing agent without creating a new one.
        
        Args:
            session_id: UUID string of the session
            
        Returns:
            QvdAgent instance or None if not found
        """
        key = session_id
        with self._lock:
            return self._agents.get(key)
    
    def remove_agent(self, session_id: str) -> bool:
        """
        Remove an agent from the registry.
        
        Args:
            session_id: UUID string of the session
            
        Returns:
            True if agent was removed, False if not found
        """
        key = session_id
        with self._lock:
            if key in self._agents:
                logger.info(f"Removing agent for session_id={session_id}")
                del self._agents[key]
                self._meta.pop(key, None)
                return True
            return False
    
    def get_all_agents(self) -> Dict[str, 'QvdAgent']:
        """
        Get all registered agents.
        
        Returns:
            Dictionary of all agents
        """
        with self._lock:
            return self._agents.copy()
    
    def clear_all_agents(self):
        """Clear all agents from the registry."""
        logger.info("Clearing all agents from registry")
        with self._lock:
            self._agents.clear()
            self._meta.clear()
            self._event_queues.clear()

    # -------------------------
    # Session lifecycle helpers
    # -------------------------
    def touch(self, session_id: str) -> None:
        """
        Record activity for this session.
        - Updates last_activity_ts (guardrail TTL)
        - Sets auth_close_deadline_ts = now + AUTH_CLOSE_AFTER_S
        - Clears any pending auth-close warning/kill
        """
        now = time.time()
        with self._lock:
            meta = self._meta.get(session_id)
            if not meta:
                self._meta[session_id] = SessionMeta(
                    last_activity_ts=now,
                    auth_close_deadline_ts=now + self.auth_close_after_s,
                    auth_close_warned=False,
                    auth_close_kill_ts=None,
                )
                return
            meta.last_activity_ts = now
            meta.auth_close_deadline_ts = now + self.auth_close_after_s
            meta.auth_close_warned = False
            meta.auth_close_kill_ts = None

    def get_event_queue(self, session_id: str) -> asyncio.Queue:
        with self._lock:
            q = self._event_queues.get(session_id)
            if q is None:
                q = asyncio.Queue()
                self._event_queues[session_id] = q
            return q

    def enqueue_event(self, session_id: str, event: Dict[str, Any]) -> None:
        q = self.get_event_queue(session_id)
        try:
            q.put_nowait(event)
        except Exception as e:
            logger.warning(f"Failed to enqueue event for session {session_id}: {e}")

    # No per-agent timers; auth-close uses rolling deadline set by touch()

    # -------------------------
    # Background idle loop
    # -------------------------
    def start_idle_cleanup_loop(self) -> None:
        """Start background idle eviction loop (safe to call multiple times)."""
        if self._idle_loop_task and not self._idle_loop_task.done():
            return
        self._idle_loop_stop.clear()
        loop = asyncio.get_running_loop()
        self._idle_loop_task = loop.create_task(self._idle_cleanup_loop())
        logger.info(
            "Started AgentManager idle cleanup loop",
            extra={
                "ttl_s": self.session_idle_ttl_s,
                "auth_close_after_s": self.auth_close_after_s,
                "auth_close_grace_s": self.auth_close_grace_s,
            },
        )

    async def stop_idle_cleanup_loop(self) -> None:
        """Stop background idle loop."""
        self._idle_loop_stop.set()
        task = self._idle_loop_task
        if not task:
            return
        if not task.done():
            task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        self._idle_loop_task = None

    async def _idle_cleanup_loop(self) -> None:
        """
        Enforce rolling auth-close and guardrail TTL.
        - If auth_close_deadline hits: emit auth_close_warning, start grace timer
        - If grace expires: expire session (reason=auth_close)
        - If guardrail TTL expires: expire session (reason=idle_ttl)
        """
        sleep_s = float(os.getenv("SESSION_IDLE_LOOP_INTERVAL_S", "2.0"))
        while not self._idle_loop_stop.is_set():
            now = time.time()

            with self._lock:
                session_ids = list(self._agents.keys())

            for sid in session_ids:
                with self._lock:
                    meta = self._meta.get(sid)
                    if not meta:
                        continue
                    agent = self._agents.get(sid)
                    idle = now - meta.last_activity_ts
                    # Rolling auth-close warning + grace-kill
                    # Only apply if session is authenticated (credentials.confirmed == True).
                    confirmed = bool((getattr(agent, "credentials", {}) or {}).get("confirmed")) if agent else False
                    if confirmed:
                        deadline = meta.auth_close_deadline_ts
                        if deadline is not None and (now >= deadline) and (not meta.auth_close_warned):
                            meta.auth_close_warned = True
                            meta.auth_close_kill_ts = now + float(self.auth_close_grace_s)
                            self.enqueue_event(
                                sid,
                                {
                                    "type": "auth_close_warning",
                                    "session_id": sid,
                                    "grace_seconds": int(self.auth_close_grace_s),
                                    "timestamp": datetime.now(timezone.utc).isoformat(),
                                },
                            )

                        if meta.auth_close_kill_ts is not None and now >= meta.auth_close_kill_ts:
                            self._expire_session_locked(sid, reason="auth_close")
                            continue
                    else:
                        # Not authenticated: do not warn/kill via auth-close; rely on guardrail TTL.
                        meta.auth_close_warned = False
                        meta.auth_close_kill_ts = None

                    # Guardrail TTL eviction
                    if idle >= self.session_idle_ttl_s:
                        self._expire_session_locked(sid, reason="idle_ttl")
                        continue

            await asyncio.sleep(sleep_s)

    def _expire_session_locked(self, session_id: str, reason: str) -> None:
        """Expire session and remove agent/meta. Call only while holding self._lock."""
        self.enqueue_event(
            session_id,
            {
                "type": "session_expired",
                "session_id": session_id,
                "reason": reason,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            },
        )
        self.enqueue_event(session_id, {"type": self._close_event_type})
        self._agents.pop(session_id, None)
        self._meta.pop(session_id, None)

    def cleanup_event_queue(self, session_id: str) -> None:
        """Remove event queue after SSE stream is closed."""
        with self._lock:
            self._event_queues.pop(session_id, None)




# Example usage for testing
if __name__ == "__main__":
    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s | %(levelname)s | %(name)s | %(message)s'
    )

    async def _test_all_timers():
        """
        Quick timer integration test (prints emitted events):
        - auth_close_warning (rolling deadline now+AUTH_CLOSE_AFTER_S)
        - session_expired (after grace)

        This test uses shortened durations to complete quickly.
        """
        mgr = AgentManager()

        # Short durations for a fast test run
        mgr.session_idle_ttl_s = 20
        mgr.auth_close_after_s = 4
        mgr.auth_close_grace_s = 2

        test_session_id = "timer-test-session"
        agent = mgr.get_or_create_agent(session_id=test_session_id)
        mgr.start_idle_cleanup_loop()

        # Consume events from the session queue
        q = mgr.get_event_queue(test_session_id)
        received = []

        async def _consume():
            while True:
                ev = await q.get()
                if isinstance(ev, dict):
                    received.append(ev)
                    print(f"[EVENT] {ev}")
                    if ev.get("type") == "session_expired":
                        break

        consumer_task = asyncio.create_task(_consume())

        # Touch to set last_activity baseline
        mgr.touch(test_session_id)

        # Wait until the session expires via auth_close warning + grace kill
        try:
            await asyncio.wait_for(consumer_task, timeout=15)
        finally:
            await mgr.stop_idle_cleanup_loop()

        return received

    print("=" * 80)
    print("TESTING AGENT TIMERS (idle TTL + upsell + auth-close)")
    print("=" * 80)
    asyncio.run(_test_all_timers())
    print("=" * 80)
    print("TEST COMPLETED")
    print("=" * 80)

