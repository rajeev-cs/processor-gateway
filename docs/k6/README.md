# Installation

Binary for local execution can be obtained from https://github.com/grafana/k6.

A prebuilt docker image is available here https://hub.docker.com/r/grafana/k6. There are two versions with and without xk6-browser ( TAG with/without "-browser")

Lastly, users can build a custom docker container to add extensions.  
A custom image is only needed if you need extensions to k6 https://k6.io/docs/extensions

```
docker build -t k6:0.46.0-tt .
```

## Test environment setup
The example script assumes access to a Sensa cluster.  
You must have installed the `cortex` CLI and configured a connection to a cluster using a PAT file.

First, install the patternDaemon test fixture:
```
git clone https://github.com/CognitiveScale/cortex-local
cd cortex-local/agent-patterns
cortex workspace build
cortex workspace publish
cortex agents save agents/*
```

Next, create an empty .env file to later hold the API key and other settings needed for tests.
```
touch .env
```

For example, create a local file by running `cortex configure env > .env.local`

Finally, verify that the agents and skills are installed and ready.
```
cortex agents list
cortex skills list
```

## Running k6 locally/Developing scripts

Use the `k6` binary locally to prototype and test scripts before deploying them to a cluster for execution with the k6 operator.

To run scripts locally with a single user and iteration, run the following:
```
k6 run -u -i 1 <myscript.js>
```

## Running scripts on a Kubernetes cluster
Install the k6 operator
```
`curl https://raw.githubusercontent.com/grafana/k6-operator/main/bundle.yaml | kubectl apply -f -
````

Install `virtual-service.yaml` for some of the tests.
# Running test scripts

NOTE: Update the XXX.yaml file's `spec.runner.image` to match the image + tag built above

`run.sh` creates/updates a ConfigMap with scripts and submits a k6 resource to trigger test execution.
```
run.sh call-daemon-directly
```

## Test scripts

call-daemon-directly - call daemon directly, avoiding processor gateway
" You must install the virtual service to allow direct access to the daemon."
skill-sync-300rps - call skill synchronously using GW

agent-sync-300rps - call an agent with a single skill and await the response.

agent-async-300rps - call an agent and verify that the activation record exists immediately after submitting the request.
