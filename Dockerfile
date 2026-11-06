FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.7 /uv /usr/local/bin/uv
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
WORKDIR /app
COPY pyproject.toml uv.lock /app/
RUN uv sync --locked --no-dev --no-cache --no-install-project --no-python-downloads
COPY site /app/site
RUN mkdir -p /state && chown 10001:10001 /state
ENV ARC_STATE=/state ARC_BIND=0.0.0.0 PORT=8788
USER 10001:10001
EXPOSE 8788
CMD ["/app/.venv/bin/python", "/app/site/server.py"]
