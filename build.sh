#!/bin/bash -eu
function error_exit {
    echo "$1" >&2   ## Send message to stderr. Exclude >&2 if you don't want it that way.
    exit "${2:-1}"  ## Return a code specified by $2 or 1 by default.
}

function local_build(){
  npm install || error_exit "Failed to run npm install"
}

# this runs on host os e.g MAC/Windows
function local_docker(){
    BRANCH=$(git symbolic-ref --short -q HEAD)
    IMAGE_NAME=$(git remote -v | grep "(fetch)" | sed -E "s/.*git@.*:.*\/(.*)\.git.*/\1/")
    DOCKER_USER=${DOCKER_USER-"c12e"}
    DOCKER_TAG="${DOCKER_USER}/${IMAGE_NAME}:${BRANCH}"
    # don't copy secrets into layers !!!
    docker rmi "${DOCKER_TAG}" "${DOCKER_USER}/${IMAGE_NAME}:latest-develop" || echo "old image not cleanedup..."
    docker build -t "${DOCKER_TAG}"  --secret id=npm,src=$HOME/.npmrc .
    docker tag "${DOCKER_TAG}" "${DOCKER_USER}/${IMAGE_NAME}:latest-develop"

}

## MAIN
cd "$(dirname "$0")"
VERSION=$(git describe --long --always --match='v*.*' | sed 's/v//; s/-/./')
echo "##### BUILDING ${VERSION} ######"
case ${1-local} in
*)
 local_build
 local_docker
 ;;
esac
