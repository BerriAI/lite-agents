"""
Optional deferred tasks. One file: store + dispatcher.

Set ENABLE_TASKS=1 and DATABASE_URL, apply migrations/001_tasks.sql,
and the agent gets schedule / list_tasks / cancel tools. Every 60s the
dispatcher asks `check_agent` whether each due task is ready; if it
returns done=True with a message, `delivery` is invoked.

Atomic across instances: `_claim` uses FOR UPDATE SKIP LOCKED and
`_mark_fired` is a conditional UPDATE, so two replicas ticking the
same DB never double-fire a task.

Register a delivery callback before start():

    import tasks
    async def deliver(task: dict, message: str) -> None:
        ...
    tasks.delivery = deliver
"""
from __future__ import annotations

import asyncio
import logging
import os
import uuid
from collections.abc import Awaitable, Callable
from datetime import datetime, timedelta, timezone

import asyncpg
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger
from pydantic import BaseModel
from pydantic_ai import Agent

log = logging.getLogger("tasks")

MAX_PER_USER = 10
RETRY_INTERVAL = timedelta(minutes=5)
TASK_TTL = timedelta(days=7)
ERROR_LIMIT = 3
CHECK_TIMEOUT = 60.0
TICK_SECONDS = 60

delivery: Callable[[dict, str], Awaitable[None]] | None = None
_pool: asyncpg.Pool | None = None


def _needs_ssl(dsn: str) -> bool:
    return "sslmode=require" in dsn or "sslmode=verify" in dsn


async def _conn() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        dsn = os.environ["DATABASE_URL"]
        kwargs: dict = {"min_size": 1, "max_size": 5}
        if _needs_ssl(dsn):
            kwargs["ssl"] = "require"
        _pool = await asyncpg.create_pool(dsn, **kwargs)
    return _pool


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


# ---------------------------------------------------------------------------
# Public API: called from agent tools.
# ---------------------------------------------------------------------------


async def create(
    *, tenant: str, user: str, channel: str,
    title: str, check_prompt: str, minutes: int = 60,
) -> str:
    pool = await _conn()
    now = datetime.now(timezone.utc)
    async with pool.acquire() as c:
        n = await c.fetchval(
            "select count(*) from tasks "
            "where tenant_id=$1 and user_id=$2 and status='pending'",
            tenant, user,
        )
        if n >= MAX_PER_USER:
            raise ValueError(f"too many active tasks (max {MAX_PER_USER})")
        row = await c.fetchrow(
            "insert into tasks (tenant_id, user_id, channel, title, "
            "                   check_prompt, next_run_at, expires_at) "
            "values ($1, $2, $3, $4, $5, $6, $7) returning id",
            tenant, user, channel, title, check_prompt,
            now + timedelta(minutes=max(minutes, 1)), now + TASK_TTL,
        )
    return str(row["id"])


async def list_for(tenant: str, user: str) -> list[dict]:
    pool = await _conn()
    async with pool.acquire() as c:
        rows = await c.fetch(
            "select * from tasks "
            "where tenant_id=$1 and user_id=$2 and status='pending' "
            "order by next_run_at",
            tenant, user,
        )
    return [dict(r) for r in rows]


async def cancel(task_id: str, tenant: str, user: str) -> bool:
    try:
        tid = uuid.UUID(task_id)
    except ValueError:
        return False
    pool = await _conn()
    async with pool.acquire() as c:
        tag = await c.execute(
            "update tasks set status='cancelled' "
            "where id=$1 and tenant_id=$2 and user_id=$3 and status='pending'",
            tid, tenant, user,
        )
    return tag.endswith(" 1")


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------


class CheckResult(BaseModel):
    done: bool
    reason: str = ""
    message: str = ""


_CHECK_PROMPT = (
    "Decide whether the user's scheduled condition is satisfied right now. "
    "Use available tools to check external state. Return done=True with a "
    "short user-facing `message` only when ready; otherwise done=False "
    "with a brief `reason`. Be conservative."
)


def make_check_agent(parent: Agent) -> Agent[None, CheckResult]:
    return Agent(
        parent.model,
        output_type=CheckResult,
        system_prompt=_CHECK_PROMPT,
        toolsets=parent.toolsets,
    )


async def _claim(limit: int = 20) -> list[dict]:
    pool = await _conn()
    async with pool.acquire() as c, c.transaction():
        rows = await c.fetch(
            "select * from tasks "
            "where status='pending' "
            "  and next_run_at <= now() and expires_at > now() "
            "  and (last_checked_at is null "
            "       or last_checked_at < now() - interval '30 seconds') "
            "order by next_run_at limit $1 for update skip locked",
            limit,
        )
        if rows:
            await c.execute(
                "update tasks set last_checked_at=now() "
                "where id = any($1::uuid[])",
                [r["id"] for r in rows],
            )
    return [dict(r) for r in rows]


async def _reschedule(task_id: uuid.UUID, reason: str) -> None:
    pool = await _conn()
    async with pool.acquire() as c:
        await c.execute(
            "update tasks set next_run_at = now() + $2, last_reason=$3, "
            "                  consecutive_errors=0 where id=$1",
            task_id, RETRY_INTERVAL, reason,
        )


async def _record_error(task_id: uuid.UUID, reason: str) -> None:
    pool = await _conn()
    async with pool.acquire() as c:
        n = await c.fetchval(
            "update tasks set consecutive_errors = consecutive_errors + 1, "
            "                  next_run_at = now() + $2, last_reason=$3 "
            "where id=$1 returning consecutive_errors",
            task_id, RETRY_INTERVAL, reason,
        )
        if n is not None and n >= ERROR_LIMIT:
            await c.execute(
                "update tasks set status='failed' where id=$1", task_id,
            )


async def _mark_fired(task_id: uuid.UUID) -> bool:
    pool = await _conn()
    async with pool.acquire() as c:
        tag = await c.execute(
            "update tasks set status='fired', fired_at=now() "
            "where id=$1 and status='pending'",
            task_id,
        )
    return tag.endswith(" 1")


async def _expire(task_id: uuid.UUID) -> None:
    pool = await _conn()
    async with pool.acquire() as c:
        await c.execute(
            "update tasks set status='expired' where id=$1", task_id,
        )


async def _run_one(task: dict, check_agent: Agent) -> None:
    tid: uuid.UUID = task["id"]
    if task["expires_at"] <= datetime.now(timezone.utc):
        await _expire(tid)
        return
    try:
        r = await asyncio.wait_for(
            check_agent.run(task["check_prompt"]), timeout=CHECK_TIMEOUT,
        )
    except Exception as e:  # noqa: BLE001
        log.exception("task %s: check raised", tid)
        await _record_error(tid, f"{type(e).__name__}: {e}"[:200])
        return
    res: CheckResult = r.output
    if not res.done:
        await _reschedule(tid, res.reason)
        return
    if not res.message:
        log.warning("task %s: done with empty message", tid)
        await _record_error(tid, "empty message")
        return
    if not await _mark_fired(tid):
        return  # another worker fired first
    if delivery is None:
        log.warning(
            "task %s fired but no delivery registered: %s", tid, res.message,
        )
        return
    await delivery(task, res.message)


async def _tick(check_agent: Agent) -> None:
    for task in await _claim():
        try:
            await _run_one(task, check_agent)
        except Exception:  # noqa: BLE001
            log.exception("task %s: dispatcher crashed", task["id"])


def start(parent: Agent) -> AsyncIOScheduler:
    """Start the tick. Returns the scheduler so the caller can shut it down."""
    check_agent = make_check_agent(parent)
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        _tick, IntervalTrigger(seconds=TICK_SECONDS),
        kwargs={"check_agent": check_agent},
        id="tasks_tick", max_instances=1, coalesce=True,
    )
    scheduler.start()
    log.info("tasks: dispatcher started (tick=%ss)", TICK_SECONDS)
    return scheduler
