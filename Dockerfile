# Hosted Gesso, for claude.ai and ChatGPT connectors. See docs/hosting.md.
#
#   docker build -t gesso .
#   docker run -p 8080:8080 -v gesso-data:/data -e GESSO_PUBLIC_URL=https://gesso.example.com gesso

FROM node:22-bookworm-slim AS build
WORKDIR /src
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile \
  && node packages/gesso-mcp/build.mjs \
  && cd packages/gesso-mcp && npm pack --pack-destination /tmp

FROM node:22-bookworm-slim
# A hosted server has no fonts of its own: these cover Latin, Greek, Cyrillic and many other scripts.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-dejavu-core fonts-liberation2 fonts-noto-core \
  && rm -rf /var/lib/apt/lists/*
COPY --from=build /tmp/gesso-mcp-*.tgz /tmp/
RUN npm install -g /tmp/gesso-mcp-*.tgz && rm /tmp/gesso-mcp-*.tgz \
  && mkdir /data && chown node:node /data
ENV NODE_ENV=production GESSO_WORKDIR=/data PORT=8080
VOLUME /data
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["gesso-mcp", "--hosted"]
