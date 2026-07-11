# Reference gateway image (reference implementation posture: runs the TS
# sources via tsx — no compile step to go stale; pin your own build for prod).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY packages ./packages
RUN npm ci --ignore-scripts && npm cache clean --force
ENV PORT=8317 NODE_ENV=production
EXPOSE 8317
USER node
CMD ["npx", "tsx", "packages/gateway/src/index.ts"]
