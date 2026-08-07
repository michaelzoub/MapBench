from dataclasses import dataclass
from enum import Enum
from typing import Protocol

from .storage import load_job

API_TOKEN = "must-not-leak"


class State(Enum):
    READY = "ready"
    RUNNING = "running"


@dataclass
class Job:
    job_id: int
    label: str = "private-default"


class Runner(Protocol):
    async def run(self, job: Job, retries: int = 3) -> str:
        ...


class Worker(Runner):
    def __init__(self, callback) -> None:
        self.callback = callback

    async def run(self, job: Job, retries: int = 3) -> str:
        self.prepare(job)
        value = load_job(job.job_id)
        self.callback(value)
        return value

    def prepare(self, job: Job) -> None:
        print(job.label)


def build_worker(callback) -> Worker:
    return Worker(callback)


def authenticate(user: str, api_token: str = "default-secret") -> bool:
    return bool(user and api_token)
