# Build context = rag/ (docker build -f service/Dockerfile rag/)
FROM python:3.12-slim
WORKDIR /app
# W3 HEIC: ffmpeg + libheif so visual_match.decode() can open iPhone HEIC
# photos (AppContainer stack already proves ffmpeg-decoded-then-sharp-rotate is
# the only path that works — see app Dockerfile "apk add ffmpeg" + memory
# puer-hub-security-hardening.md §HEIC). Keep this list minimal: ffmpeg for
# the decode + libheif runtime + python pillow-heif binding for PIL.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ffmpeg libheif1 libde265-0 && \
    rm -rf /var/lib/apt/lists/*
COPY service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt pillow-heif
# code only — data assets are a runtime bind-mount (RAG_DATA_DIR=/data)
COPY service/ ./service/
COPY rag_pipeline.py retriever.py teacher_api.py image_ocr.py visual_match.py query_classifier.py hard_neg_rules.py cancel.py cache.py refusal.py ./
ENV RAG_DATA_DIR=/data
EXPOSE 8000
CMD ["uvicorn", "service.server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
