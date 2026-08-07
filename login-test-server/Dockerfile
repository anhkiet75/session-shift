FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY public ./public
COPY server.mjs ./
EXPOSE 3000
CMD ["node", "server.mjs"]