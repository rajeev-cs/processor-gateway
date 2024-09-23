#!/bin/bash
export NPMRC=$(printf "//cognitivescale.jfrog.io/cognitivescale/api/npm/:_authToken=%s" "${NPM_TOKEN}")
if [ $# -lt 1 ]; then
  skaffold -n cortex --no-prune=false --cache-artifacts=false dev
else
  skaffold -n cortex $*
fi
