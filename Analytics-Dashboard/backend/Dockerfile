# Образ сервера FastAPI: API + роздача фронтенду. Збирається з кореня проєкту (docker-compose.yml).
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 TZ=Europe/Kyiv FRONTEND_DIR=/app/frontend
WORKDIR /app
COPY backend/requirements.txt backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt
# Код бекенду і джерела геоданих (SQL-файли бази в образ не потрапляють — див. .dockerignore)
COPY backend backend
COPY frontend frontend
RUN useradd -r -u 10001 app && chown -R app /app
USER app
EXPOSE 8000
CMD ["uvicorn", "backend.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
