---
marp: true
theme: default
paginate: true
style: |
section {
font-size: 20px;
}
---


![bg left:40% 80%](https://www.cognitivescale.com/wp-content/uploads/2020/08/CognitiveScale-Logo-ColorBlack-Tagline.svg)

# **Fabric Gateway**

## Kafka connector

---

# Kafka Connector: Purpose

**Why?**

* Add buffering for agent invokes to handle peak throughput
* Assure agent invokes get delivered (at least once)
  * Survive GW restarts
* Allow for fabric autoscaling

**What it is not?**

* Kafka is NOT used internally between skills
* Streaming data into profiles is a separate component.

---

# Gateway: Protocol Connectors

![width:600px](docs/diagrams/Kafka-v2.drawio.png)
Extensibility for additional communication protocols e.g.: AMQP, GRPC, Kafka

---

# Gateway: Workers

Gateway now supports "worker" threads for agents execution.
Default: 4 workers, 4 parallel requests

**Pros:**

* Separates request handling from agents execution
* Increases CPU utilization in K8s POD to trigger scaling
* Adds queuing of requests, to avoid overloading worker

**Cons:**

* Increases resource utilization, shouldn't replace scaling

---

# Kafka connector: Setup

## Requirements

* The workers feature must be enabled `FEATURE_AGENT_WORKERS=true`
* A connector config map `gateway-connector-configs` must be provided
* The processor gateway services must be restarted

``` JSON
{
  "name": "kafkaDefault",
  "type": "kafka",
  "kafka": {
    "config": {
        "clientId": "gateway",
        "brokers": ["192.168.39.138:30942"]
    },
    "groupId": "gateway",
    "inTopic": "fabric-in",
    "outTopic": "fabric-out",
    "retryTopic": "fabric-err"
  },
  "pat": {...}
}
```

`retryTopic` is optional, if provided errors are written to this topic for re-submittal
`pat` is optional, if provided `authorzation` header is not required

---

# Kafka connector: Behavior

Invokes are written to `inTopic`
* Similar JSON format as REST agent invoke
* headers are supported for "Authorization: bearer <JWT>" and http header propagation to skills

```JSON
{
    "agentName": "cortex/hello_agent",
    "projectId": "johan",
    "serviceName": "input", 
    "correlationId": "ckyojce4p0000zgc7k3o9yyk7",
    "properties": "{...}",
    "sessionId": "",
    "payload": {"numbers": [2, 14, 23]}
}
```

---

# Kafka connector: Behavior

Response are received from `outTopic`
* Gateway always sends a response for each message it processes regardless od success or failure.

``` JSON  
{
  "activationId":"8e88d261-7a74-4922-a98c-a029707c7b55",
  "correlationId":"ckynvsvoo0000xmc7zaxx0m9u",
  "response": {"sum": 39},
  "status":"COMPLETE",
}  
```

---

# Kafka connector: Behavior

If the error topics is configured, all errors will be written to the error topic.

* Original payload and headers are included

``` JSON  
{
  "activationId":"8e88d261-7a74-4922-a98c-a029707c7b55",
  "correlationId":"ckynvsvoo0000xmc7zaxx0m9u",
  "response":"Error invoking agent cortex/hello_agents input input: Agent \"cortex/hello_agents\" not found in project johan",
  "status":"ERROR",
  "payload":{"numbers":[25,1,17,26]}
}  
```

---

# Python kafka client

Simple client application that:

* Sends invoke messages to kafka
* Waits for a response and prints, matches the response to a request and prints out a message.

```shell
$ python main.py -b 192.168.39.138:30942 -g gwclient -o fabric-in -i fabric-out -n 100
```

---

# Kafka connector: future work

* Allow developers to configure connectors
* Support kafka headers for agent invoke: name, input, project (TBD)
* Support message transformations, payload == message
* Support message "only" requests
* Support skill invokes (TBD)
* Python client example:
  * Add file input
  * Parameterize agent name and input
