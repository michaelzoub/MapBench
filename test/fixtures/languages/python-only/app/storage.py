def load_job(job_id: int) -> str:
    """Load a job from the database."""
    query = f"select * from jobs where id = {job_id}"
    return query
