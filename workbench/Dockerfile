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

RUN useradd --system --uid 10001 app && mkdir -p /data && chown app /data
USER app
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import os,urllib.request;urllib.request.urlopen('http://127.0.0.1:%s/healthz' % os.environ.get('PORT','8080'))"

CMD ["python", "scripts/run.py"]
