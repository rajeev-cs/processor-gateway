ARG K6_VERSION=0.46.0
FROM grafana/xk6:0.9.0 as build
RUN  xk6 build ${K6_VERSION} \
    --output /tmp/k6 \
    --with github.com/grafana/xk6-browser \
    --with github.com/szkiba/xk6-dotenv \
    --with github.com/szkiba/xk6-prometheus \
    --with github.com/martymarron/xk6-output-prometheus-pushgateway

FROM grafana/k6:${K6_VERSION}
COPY  --from=build  /tmp/k6 /usr/bin/k6
