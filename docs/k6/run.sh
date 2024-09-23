#!/bin/bash -eux

if [ $# -lt 1 ]; then
  echo "$0 <script name>"
fi
SCRIPTNAME=$1
kubectl create configmap ${SCRIPTNAME} --from-file ${SCRIPTNAME}.js --from-file .env -o yaml --dry-run=client | kubectl apply -f -
kubectl create -f ${SCRIPTNAME}.yaml
