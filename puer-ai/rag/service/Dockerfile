# Build context = rag/ (docker build -f service/Dockerfile rag/)
FROM python:3.12-slim
WORKDIR /app
COPY service/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
# code only — data assets are a runtime bind-mount (RAG_DATA_DIR=/data)
COPY service/ ./service/
COPY rag_pipeline.py retriever.py teacher_api.py image_ocr.py visual_match.py ./
ENV RAG_DATA_DIR=/data
EXPOSE 8000
CMD ["uvicorn", "service.server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
