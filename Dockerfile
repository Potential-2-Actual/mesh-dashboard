FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-slim
WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/package*.json ./
RUN npm ci --omit=dev
ENV NODE_ENV=production
ENV PORT=3100
EXPOSE 3100
CMD ["node", "build"]
