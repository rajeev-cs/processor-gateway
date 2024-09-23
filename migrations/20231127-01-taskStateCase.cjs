const mongoose = require('mongoose');
const _ = require('lodash');


async function updateTaskStatus() {
    try {
        const coll = mongoose.connection.collection('Tasks');
        const cursor = coll.find({}); // MongoDB native find() returns cursor
        for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
            if (doc?.state) {
                await coll.updateOne( { "_id": doc._id }, { "$set" : { state: doc.state.toUpperCase() }})
            }
        }
        await cursor.close();
    } catch (err) {
        throw new Error(`Error during task resource task case migration: ${err.message}`);
    }
}

module.exports = {
    up: async () => {
        await updateTaskStatus();
    },
    down: async () => {
    },
};
