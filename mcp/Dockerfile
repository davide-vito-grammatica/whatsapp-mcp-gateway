FROM python:3.13-alpine@sha256:9ef1a599f863231c3d91e941389bfdc4a2d6070557243d54df1a4e57015b960e AS dependencies
WORKDIR /build
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir --upgrade pip==26.3 && \
    pip install --prefix=/install --no-cache-dir --only-binary=:all: -r requirements.txt && \
    PYTHONPATH=/install/lib/python3.13/site-packages pip check

FROM python:3.13-alpine@sha256:9ef1a599f863231c3d91e941389bfdc4a2d6070557243d54df1a4e57015b960e
RUN apk upgrade --no-cache && python -m pip uninstall -y pip && \
    rm -rf /usr/local/lib/python3.13/ensurepip
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY --from=dependencies /install/ /usr/local/
COPY adapter.py server.py media.py smoke_test.py test_mcp.py LICENSE THIRD_PARTY_NOTICES.md ./
USER 10001:10001
CMD ["python", "/app/server.py"]
