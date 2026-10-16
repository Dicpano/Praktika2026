"""python -m server [--port 8501] — запуск сервера Transfer Learning-лабораторії."""
import argparse

import uvicorn

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8501)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    # один процес, без автоперезавантаження: моделі й фонові задачі живуть у пам'яті сервера
    uvicorn.run("server.main:app", host=a.host, port=a.port, log_level="warning", workers=1, reload=False)
