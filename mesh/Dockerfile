FROM oven/bun:1.4-alpine
WORKDIR /app
COPY lib.ts ./lib.ts
COPY mesh/ ./mesh/
ENV OMP_MESSENGER_MESH_PORT=8765
ENV OMP_MESSENGER_MESH_DATA_DIR=/data
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8765/healthz || exit 1
CMD ["bun", "mesh/server.ts", "--data-dir", "/data"]
