#!/usr/bin/env bash
kubectl patch -n cortex virtualservice cortex-processor-gateway-virt --type=json -p '[{"op": "add", "path": "/spec/http/0/retries", "value": { "attempts": 5, "retryOn": "gateway-error,connect-failure,retriable-4xx", "perTryTimeout": "1s"}}]'
