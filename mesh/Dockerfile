FROM oven/bun:1.4-alpine
WORKDIR /app
COPY lib.ts ./lib.ts
COPY mesh/protocol.ts mesh/types.ts mesh/server-state.ts mesh/persist.ts mesh/server.ts ./mesh/
ENV PI_MESSENGER_MESH_PORT=8765
EXPOSE 8765
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8765/healthz || exit 1
CMD ["bun", "mesh/server.ts", "--data-dir", "/data"]
