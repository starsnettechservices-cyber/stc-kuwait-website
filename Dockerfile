FROM node:18-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY . .
EXPOSE 8080
ENV NODE_ENV=production
CMD ["node", "server.js"]
