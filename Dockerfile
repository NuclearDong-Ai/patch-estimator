FROM python:3.12-slim

WORKDIR /app

COPY public-deploy/ ./public-deploy/
COPY jn_server.py .

EXPOSE 8765

CMD ["python", "jn_server.py"]
