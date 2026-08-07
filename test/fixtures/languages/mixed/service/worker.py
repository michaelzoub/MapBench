class Worker:
    def execute(self, task: str) -> str:
        return task.upper()


def create_worker() -> Worker:
    return Worker()
