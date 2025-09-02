FROM node:18-bullseye-slim
RUN apt-get update && \
    apt-get install -y git
RUN git clone https://github.com/satomahga/cuteproxy /app
WORKDIR /app
RUN chown -R 1000:1000 /app
USER 1000
RUN npm install
COPY Dockerfile greeting.md* .env* ./
RUN npm run build
EXPOSE 7860
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=12882"
CMD [ "npm", "start" ]
