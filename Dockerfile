FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt jn_server.py ./
COPY public-deploy ./public-deploy

RUN useradd --create-home --uid 10001 appuser \
    && chown -R appuser:appuser /app

USER appuser

ENV PORT=8765
EXPOSE 8765

CMD ["python", "jn_server.py"]
