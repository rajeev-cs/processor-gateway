ARG VERSION=local
ARG NODE_IMAGE=${NODE_IMAGE}
FROM $NODE_IMAGE as build
ARG CI_COMMIT_BRANCH=""
ENV HUSKY_SKIP_INSTALL=1
ENV MONGOMS_SYSTEM_BINARY=/opt/tools/mongod
ENV REDISMS_SYSTEM_BINARY=/opt/tools/redis-server
WORKDIR /app

# Copy from docker images as we can possibly cache these
COPY --from=mongo:6.0.14-jammy /usr/bin/mongod /opt/tools/mongod
COPY --from=redis:6.2 /usr/local/bin/redis-server /opt/tools/redis-server

# Copy source
COPY . ./

RUN --mount=type=secret,id=npm,target=/root/.npmrc npm ci --include=dev --ignore-scripts

RUN npm run build
RUN npm run test
RUN --mount=type=secret,id=sonarhost \
    --mount=type=secret,id=sonartoken \
    if [ "${CI_COMMIT_BRANCH}" = "develop" ]; then \
      export SONAR_HOST_URL=$(cat /run/secrets/sonarhost) && export SONAR_TOKEN=$(cat /run/secrets/sonartoken) && npm run scan; \
    fi
# Remove cruft from thirdparty deps
RUN ./node_modules/.bin/clean-modules -y
RUN npm prune --omit=dev


RUN mkdir -p build/ \
    && cp -r licenses/ package*.json node_modules/ data/ dist/ config/ migrations/ spec/ ./build/

FROM ${NODE_IMAGE}-slim as runtime
ARG VERSION=${VERSION}

LABEL release=$VERSION
LABEL name="cortex-processor-gateway-service" \
      vendor="CognitiveScale" \
      version=5 \
      summary="Service for management of processor gateway." \
      description="Service for management of processor gateway."

WORKDIR /app

COPY --from=build /app/build /app

ENV PORT=4444 NODE_ENV=production

# for agent invoke job
COPY --from=c12e/scuttle:latest-main /scuttle /bin/scuttle
ENV ENVOY_ADMIN_API=http://localhost:15000
ENV ISTIO_QUIT_API=http://localhost:15020

# allow app to write to log directory
USER root
RUN sed  -i '/version/s/.*,/'"  \"version\": \"$VERSION\",/" package.json \
  && echo "default:x:1001:0:Default Application User:/app:/sbin/nologin" >> /etc/passwd
USER default

# Expose 9229 for debugging
EXPOSE 4444 9229
CMD ["node", "--experimental-json-modules", "./dist/server.js"]
