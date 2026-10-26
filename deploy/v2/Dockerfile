# Keep the already validated Node/Python/uv toolchain; never mutate the running v1 image.
ARG BASE_IMAGE=mcphub:upstream-key-stats
FROM ${BASE_IMAGE}
WORKDIR /app
ENV CI=true
COPY package.json pnpm-lock.yaml .pnpmfile.cjs ./
COPY patches ./patches
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build
ENTRYPOINT ["node"]
CMD ["dist/index.js"]
