const CommitTimeInterval = 5000;
/* Idea copied from https://github.com/yonigo/kafkajs-wrapper */
class CommitManager {
    constructor() {
        this.partitionsData = {};
        this.partitionCallbacks = {};
        this.lastCommited = [];
    }

    start(kafkaConsumer, kafkaConfig) {
        this.kafkaConsumer = kafkaConsumer;
        this.commitInterval = kafkaConfig.commitInterval || CommitTimeInterval;
        if (!kafkaConfig.autoCommit) {
            setInterval(() => {
                this.commitProcessedOffsets();
            }, this.commitInterval);
        }
        // TODO perhaps add to mocks ?
        // this.kafkaConsumer.on(this.kafkaConsumer.events.COMMIT_OFFSETS, (data) => {
        //     logger.debug(`Commit  ${JSON.stringify(data)}`);
        // });
    }

    notifyStartProcessing(data) {
        const { partition, offset, topic } = data;
        this.partitionsData[partition] = this.partitionsData[partition] || [];
        this.partitionsData[partition].push({
            offset,
            topic,
            done: false,
        });
    }

    notifyFinishedProcessing(data) {
        const { partition, offset } = data;
        this.partitionsData[partition] = this.partitionsData[partition] || [];
        const record = this.partitionsData[partition].filter((r) => r.offset === offset)[0];
        if (record) {
            record.done = true;
        }
    }

    async commitProcessedOffsets() {
        const offsetsToCommit = [];
        await Promise.all(Object.keys(this.partitionsData).map(async (key) => {
            const partition = key - 0; // cast to int
            await this.partitionCallbacks[partition].heartbeat();
            const pi = this.partitionsData[key].findIndex((record) => record.done); // last processed index
            const npi = this.partitionsData[key].findIndex((record) => !record.done); // first unprocessed index
            let lastProcessedRecord;
            if (npi > 0) {
                lastProcessedRecord = this.partitionsData[key][npi - 1];
            } else {
                lastProcessedRecord = pi > -1 ? this.partitionsData[key][this.partitionsData[key].length - 1] : null;
            }
            if (lastProcessedRecord) {
                if (!this.partitionCallbacks[partition].isRunning()) return;
                await this.partitionCallbacks[partition].resolveOffset(lastProcessedRecord.offset);
                await this.partitionCallbacks[partition].commitOffsetsIfNecessary();
                this.partitionsData[key].splice(0, this.partitionsData[key].indexOf(lastProcessedRecord) + 1); // remove commited records from array
                offsetsToCommit.push({ partition: key - 0, offset: lastProcessedRecord.offset, topic: lastProcessedRecord.topic });
            }
        }));
        this.lastCommited = offsetsToCommit.length > 0 ? offsetsToCommit : this.lastCommited;
    }

    setPartitionCBs({
 partition, resolveOffset, commitOffsetsIfNecessary, heartbeat, isRunning, 
}) {
        this.partitionCallbacks[partition] = {
            resolveOffset,
            commitOffsetsIfNecessary,
            heartbeat,
            isRunning,
        };
    }

    getLastCommited() {
        return this.lastCommited;
    }
}
export default new CommitManager();
