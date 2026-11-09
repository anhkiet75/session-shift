FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY public ./public
COPY server.ts ./
EXPOSE 3000
CMD ["npm", "start"]