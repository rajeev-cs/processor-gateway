# Processor Gateway Service

This service implements the Processor API and also serves as the runtime and orchestration engine for Processors.

## Running
**PREREQS**
redis server without a password.
REDIS_PASSWORD partially work some tests intermittantly fail.. Likely a timing issue.

**Standalone**

    npm install
    npm start
     
**Tests**

Unit tests require a local Redis to run.

    npm test


### Dianostic tools
To diagnose issues with agent execution
```
export CORTEX_TOKEN=$(cortex configure token)
curl -H "Authorization: bearer $CORTEX_TOKEN" -H "content-type: application/json" "http://localhost:4444/fabric/v4/projects/johan/agentinvoke/dexcoreflow-374ba/services/predict/diagram" | jq -r .dotNotation > diagram.dot
dot -Tpng diagram.dot > diagram.png
open diagram.png
```

NOTE: Install `dot` for above on mac with `brew install graphviz`

## Tools and Packages
- Debugging via [debug](https://www.npmjs.com/package/debug)          
- Universal logging library winston
- [Mongoose](https://mongoosejs.org) for Mongo ORM
- Configuration using [node-config](https://www.npmjs.com/package/config)

## Installing kafka

1) Install the strimzi operator

```
kubectl create namespace kafka
helm repo add strimzi https://strimzi.io/charts/
helm install -n kafka kafka strimzi/strimzi-kafka-operator
```
3) Create cluster
```
cat << EOF | kubectl create -n kafka -f -
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: fabric-cluster
spec:
  kafka:
    replicas: 1
    listeners:
      - name: plain
        port: 9092
        type: internal
        tls: false
      - name: tls
        port: 9093
        type: internal
        tls: true
        authentication:
          type: tls
      - name: external
        port: 9094
        type: nodeport
        tls: false
    storage:
      type: jbod
      volumes:
      - id: 0
        type: persistent-claim
        size: 10Gi
        deleteClaim: false
    config:
      offsets.topic.replication.factor: 1
      transaction.state.log.replication.factor: 1
      transaction.state.log.min.isr: 1
  zookeeper:
    replicas: 1
    storage:
      type: persistent-claim
      size: 10Gi
      deleteClaim: false
  entityOperator:
    topicOperator: {}
    userOperator: {}
EOF
```

3) Create in/out topics
The topics are auto created upon connecting,  this allows us to set a retention message period of 1 hour 
```
cat << EOF | kubectl create -n kafka -f -        
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: fabric-in
  labels:
    strimzi.io/cluster: "fabric-cluster"
spec:
  config:
    retention.ms: 3600000
  partitions: 3
  replicas: 1
EOF

cat << EOF | kubectl create -n kafka -f -        
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: fabric-out
  labels:
    strimzi.io/cluster: "fabric-cluster"
spec:
  config:
    retention.ms: 3600000
  partitions: 3
  replicas: 1
EOF

cat << EOF | kubectl create -n kafka -f -        
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: fabric-err
  labels:
    strimzi.io/cluster: "fabric-cluster"
spec:
  config:
    retention.ms: 3600000
  partitions: 3
  replicas: 1
EOF

```

4) Create gateway config

`kubectl create -n cortex -f k8s/gateway-connector-configs.yaml`

6) Testing

Shell into the kafka pod and run the following
```
./bin/kafka-console-producer.sh --bootstrap-server localhost:9092 --topic fabric-in
```

Sample request for "default" deployment where kafka invokes any agent

```json
{"correlationId": "i2" ,"agentName": "cortex/hello_agent", "projectId": "johan", "serviceName": "input", "payload": {"text": "test message"}}
`````
{"`agentName`": "cortex/hello_agent", "projectId": "johan", "serviceName": "input", "payload": {"text": "test message"}}

{"agentName": "cortex/hello_agent", "projectId": "sssjohan", "serviceName": "input", "payload": {"text": "test message"}}

To see output run the following
```
./bin/kafka-console-consumer.sh --bootstrap-server localhost:9092 --from-beginning --topic fabric-out
```

**Testing outside of the cluster**
Obtain the external bootstrap ip and port (tested with minikube)
```
echo "$(minikube ip):$(kubectl -n istio-system get service fabric-cluster-kafka-external-bootstrap --namespace kafka -o jsonpath='{.spec.ports[0].nodePort}')"
```

Use this address to access the cluster remotely 


## Redis script

The following is a script to remove all keys from a db
This is an alternative when `flushdb` is unavailable on a cluster

```lua
EVAL "local cursor = 0 local calls = 0 local dels = 0 repeat    local result = redis.call('SCAN', cursor, 'MATCH', ARGV[1])     calls = calls + 1   for _,key in ipairs(result[2]) do       redis.call('DEL', key)      dels = dels + 1     end     cursor = tonumber(result[1]) until cursor == 0 return 'Calls ' .. calls .. ' Dels ' .. dels" 0 '*'
```
