# Multi-stage: build the React app, then serve it with nginx.
# Self-hosters never need Node locally — `docker compose up` builds everything.
#
# --platform=$BUILDPLATFORM pins the build stage to the host's native arch even when
# cross-building for other targets (e.g. amd64 host building an arm64 image). The build
# output (static JS/CSS/HTML) is arch-independent, so there's no reason to run it under
# QEMU — and QEMU-emulated npm installs are known to corrupt esbuild/rollup's platform-
# specific native binaries, which is what breaks `vite build` with unrelated-looking
# module-resolution errors.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
ARG CLUB_NAME=openGym
ENV CLUB_NAME=${CLUB_NAME}
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci 2>/dev/null || npm install
COPY frontend/ ./
RUN npm run build && node -e 'const fs=require("node:fs"); const name=process.env.CLUB_NAME || "openGym"; const m="/app/dist/manifest.json"; const manifest=JSON.parse(fs.readFileSync(m,"utf8")); manifest.name=name; manifest.short_name=name.slice(0,12); manifest.description=name+" fitness tracker"; fs.writeFileSync(m,JSON.stringify(manifest,null,2)+"\n"); const p="/app/dist/index.html"; const html=fs.readFileSync(p,"utf8").replace("<title>openGym</title>","<title>"+name+"</title>").replace("content=\"openGym\"","content=\""+name+"\""); fs.writeFileSync(p,html);'

FROM nginx:alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
# exercise media (img/gif) is mounted at runtime from the media volume
