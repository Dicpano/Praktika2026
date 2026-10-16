"""Фонові задачі: навчання й оцінювання виконуються в окремому потоці.

Чому: Streamlit перезапускає скрипт сторінки при кожному кліку та переході, і довга операція,
запущена прямо зі сторінки, обривається. Тут задача живе в пулі потоків процесу сервера —
можна вільно ходити між модулями, а прогрес і журнал читаються з об'єкта Job.

Задачі виконуються по черзі (за замовчуванням 1 одночасно), щоб навчання двох моделей
не ділили процесор і пам'ять; кількість можна змінити в Налаштуваннях.
"""
from __future__ import annotations

import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from core.experiment import log


class Cancelled(Exception):
    """Задачу скасовано користувачем."""


@dataclass
class Job:
    module: str
    title: str
    id: str = field(default_factory=lambda: uuid.uuid4().hex[:8])
    status: str = "queued"          # queued | running | done | error | cancelled
    progress: float = 0.0
    message: str = "у черзі"
    lines: list[tuple[str, str, str]] = field(default_factory=list)   # (час, рівень, текст)
    result: Any = None
    error: str = ""
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    _cancel: threading.Event = field(default_factory=threading.Event, repr=False)

    # --- API для коду задачі (викликається з фонового потоку) ---
    def log(self, text: str, level: str = "") -> None:
        self.lines.append((datetime.now().strftime("%H:%M:%S"), level, str(text)))
        del self.lines[:-300]
        log.info("[%s] %s", self.module, text)

    def ok(self, text: str) -> None:
        self.log(text, "ok")

    def warn(self, text: str) -> None:
        self.log(text, "wr")

    def set(self, progress: float | None = None, message: str | None = None) -> None:
        if self._cancel.is_set():
            raise Cancelled()
        if progress is not None:
            self.progress = max(0.0, min(1.0, float(progress)))
        if message is not None:
            self.message = message

    def check(self) -> None:
        if self._cancel.is_set():
            raise Cancelled()

    # --- для інтерфейсу ---
    @property
    def active(self) -> bool:
        return self.status in ("queued", "running")

    @property
    def elapsed(self) -> float:
        if not self.started:
            return 0.0
        return (self.finished or time.time()) - self.started

    def cancel(self) -> None:
        self._cancel.set()
        if self.status == "queued":
            self.status, self.message = "cancelled", "скасовано"


class JobManager:
    def __init__(self, workers: int = 1):
        self._lock = threading.Lock()
        self._jobs: list[Job] = []
        self._workers = workers
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="tl-job")

    def set_workers(self, n: int) -> None:
        n = max(1, int(n))
        if n != self._workers:
            self._workers = n
            self._pool = ThreadPoolExecutor(max_workers=n, thread_name_prefix="tl-job")

    def submit(self, module: str, title: str, fn: Callable[..., Any], **kwargs) -> Job:
        """Ставить задачу в чергу. fn(job, **kwargs) повертає результат."""
        with self._lock:
            busy = self.active(module)
            if busy:
                return busy
            job = Job(module, title)
            job.log(f"задачу «{title}» поставлено в чергу")
            self._jobs.append(job)
            del self._jobs[:-50]
        self._pool.submit(self._run, job, fn, kwargs)
        return job

    def _run(self, job: Job, fn, kwargs) -> None:
        if job.status == "cancelled":
            return
        job.status, job.started, job.message = "running", time.time(), "виконується"
        job.log("старт", "ok")
        try:
            job.result = fn(job, **kwargs)
            job.status, job.progress, job.message = "done", 1.0, "готово"
            job.ok(f"готово за {job.elapsed:.0f} с")
        except Cancelled:
            job.status, job.message = "cancelled", "скасовано"
            job.warn("скасовано користувачем")
        except Exception as e:  # помилка задачі не валить сервер
            job.status, job.error, job.message = "error", str(e), "помилка"
            job.log(f"помилка: {e}", "er")
            log.error("job %s failed\n%s", job.module, traceback.format_exc())
        finally:
            job.finished = time.time()

    def active(self, module: str | None = None) -> Job | None:
        for j in reversed(self._jobs):
            if j.active and (module is None or j.module == module):
                return j
        return None

    def latest(self, module: str) -> Job | None:
        for j in reversed(self._jobs):
            if j.module == module:
                return j
        return None

    def all(self) -> list[Job]:
        return list(self._jobs)

    def running(self) -> list[Job]:
        return [j for j in self._jobs if j.active]


# Один менеджер на процес сервера: модуль Python імпортується один раз і живе між перезапусками сторінок
MANAGER = JobManager()


class NullJob:
    """Заглушка з тим самим API, коли модуль запускається без інтерфейсу (CLI, тести)."""
    def __init__(self, verbose: bool = False):
        self.verbose = verbose

    def log(self, text, level=""):
        if self.verbose:
            print(text)

    ok = warn = log

    def set(self, progress=None, message=None):
        pass

    def check(self):
        pass


def reporter(job) -> "Job | NullJob":
    return job if job is not None else NullJob()
