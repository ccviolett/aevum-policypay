# Stage 1: Compile Solidity contracts + build Vite React frontend
FROM node:22-alpine AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.4.1 --activate

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.json ./
COPY frontend/package.json ./frontend/package.json
RUN pnpm install --frozen-lockfile

COPY contracts ./contracts
COPY scripts ./scripts
COPY shared ./shared
COPY frontend ./frontend

ARG VITE_VAULT_ADDRESS=""
ENV VITE_VAULT_ADDRESS=$VITE_VAULT_ADDRESS

RUN pnpm compile && pnpm --filter aevum-policypay-frontend build

# Stage 2: Minimal static runtime image (< 50 MB)
FROM nginx:1.27-alpine AS runtime
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/frontend/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
CMD ["nginx", "-g", "daemon off;"]
