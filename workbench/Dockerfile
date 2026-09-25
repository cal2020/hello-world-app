# Integration workbench demo image: synthetic data, simulated identities.
ARG BASE_IMAGE=python:3.11-slim
FROM ${BASE_IMAGE}

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    LWB_HOST=0.0.0.0 PORT=8080 LWB_VAR=/data LWB_SEED_ON_START=1 LWB_QUIET=1

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY lucidwb/ lucidwb/
COPY consumer_app/ consumer_app/
COPY scripts/ scripts/
COPY web/ web/
COPY fixtures/ fixtures/

# Starts as root only to fix volume ownership, then runs as 'app' (see scripts/entrypoint.sh).
RUN useradd --system --uid 10001 --user-group app && mkdir -p /data && chown app:app /data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT','8080'))"

ENTRYPOINT ["scripts/entrypoint.sh"]
