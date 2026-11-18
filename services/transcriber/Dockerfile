FROM python:3.13-slim
WORKDIR /app
COPY services/transcriber/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY services/transcriber/app.py services/transcriber/rooms.py ./
ENV HF_HUB_DISABLE_IMPLICIT_TOKEN=1 HF_HOME=/models/huggingface WHISPER_MODEL=base.en WHISPER_MODEL_DIR=/models WHISPER_THREADS=2
RUN mkdir -p /models && chown 65532:65532 /models
USER 65532:65532
EXPOSE 8092
CMD ["uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8092", "--no-access-log"]
