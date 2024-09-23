# Background & Implementation
Currently, the `getTasksLog` function internally uses a function from `cortex-express-common/getResourceLogs` which then uses `@kubernetes/clinet-node/readNamespacedPodLog`. 

To stream the live log we can use the existing option `follow: true` with `readNamespacedPodLog` but there are some existing issues while returning the stream.

So, as mentioned on their GitHub documentation, we have decided to use the `Log` class from `@kubernetes/client-node`.
- [Log Class](https://github.com/kubernetes-client/javascript/blob/master/src/log.ts) 
- [Example Usage for Log Class](https://github.com/kubernetes-client/javascript/blob/master/examples/follow-logs.js)

The above class allows us to use various options like `follow`, `timestamp`, `pretty`, `sinceSeconds`, `tailLines`, and other options to manage live logs.

This implementation will allow us to trail/track live logs. To push these live logs to API (so that API also can publish and send live logs instead of just console), we would have to use WebSocket, SSE, HTTP/2, or a similar solution for managing live streaming of data/log.

At this stage, WebSocket is too complex for the required solution as we only want to send logs from server to client as in one-way communication. Between SSE & HTTP/2, because. of the simple implementation and usage popularity, we have decided to use SSE to send live logs from API.

# Things done:
- Created a new function `cortex-express-common/getResourceLiveLogs` to use above mentioned Log class and stream live logs from pod which returns the stream
* Updated `cortex-processor-gateway/lib/controller/tasks.ts/getTaskLogs` function to use above created new function
* Updated `cortex-processor-gateway/lib/controller/tasks.controller.ts/getTaskLogs` function to support all 3 cases
    * When `Task is Running` & `Follow=true`: Send Realtime Server-Sent Events (currently as a string as it will be individual lines of the log but can be incorporated as JSON string as well) and returns the stream
    * When `Task is Completed/Errored/Failed`: JSON Response from Managed content
    * When `Task is invalid (task not found etc)`: General Failed JSON Response with appropriate message

 # Things to be done:
* Update function to use above mentioned option from cli with follow flag
* Make sure no loss of messages from SSE (if required we can use existing infra/redis and publish messages to the channel to use it as a cache to serve all requests better and faster)

# Some points to check further while testing & furture implementation
* What happens if there are large amounts of logs 10-100megs
    * Do I download them all
    * Do I only get the last N minutes?  We should default to last N minutes but need to allow the users to get to older logs. (See log viewer from k8s ( allows 1 min,5 min,10 min, ALL ) defaults to 1m)
* What happens if it stays open for a while, and the user leaves the tab open hours long job? Do we handle web-socket/sse disconnects?
    * Should attempt reconnects, if we can't catch up with missing entries, should show a user-facing message and refresh but this is very intrusive UX
    * What happens when the task is completed while tailing the log
    * Should stop sending text and give a user-facing message (Job complete exit 0)
* What happens if we try to get logs and the pods aren't created/yet running?
    * Like k9s poll, every few seconds shows a user-facing message "Log not available yet: ${reason}"
* What happens if I try to get logs and the task has already been completed.
    * Should download /perhaps tail logs and show them in view.  Again if I have 10megs we don't always download the whole file.
* What do we do with multiple processes two options:
    * Multiple plex the logs from multiple pods into one stream ( like Stern )
    * Give the user a list of pods and allow them to select one and switch between them
    * For daemons get logs for a deployment resource ( all logs from all pods )
    * We can ALSO get logs for all containers in a pod, for example, init containers + istio/vault sidecars
* We should include timestamps from k8s otherwise user can't contextualize log entries (k9s includes a toggle to turn on/off timestamps)
* Do we support colorising logs ( random library GitHub - gagan-bansal/munia-pretty-json: Convert the JSON log into readable form with command line.  )? This may require a stream transformer(s) to apply consistent formatting to log output.