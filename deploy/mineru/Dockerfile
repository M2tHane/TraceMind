# CPU-only MinerU API (pipeline backend). Models are downloaded at build time so the
# container starts offline and parsing never triggers a runtime download.
FROM python:3.12-slim

ARG MINERU_MODEL_SOURCE=modelscope
ENV PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    MINERU_DEVICE_MODE=cpu

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl libgl1 libglib2.0-0 fonts-noto-core fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision \
    && pip install "mineru[core]>=3.4,<4"

RUN MINERU_MODEL_SOURCE=${MINERU_MODEL_SOURCE} mineru-models-download -s ${MINERU_MODEL_SOURCE} -m pipeline

ENV MINERU_MODEL_SOURCE=local
WORKDIR /app
EXPOSE 8000
CMD ["mineru-api", "--host", "0.0.0.0", "--port", "8000"]
