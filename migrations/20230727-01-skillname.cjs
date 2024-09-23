const mongoose = require('mongoose');
const _ = require('lodash');

async function updateTaskSkillName() {
    try {
        const coll = mongoose.connection.collection('Tasks');
        coll.find({ resource: { $exists: true },  skillName: { $exists: false } }).forEach(function (doc) {
            const parsedSkillName = JSON.parse(doc.resource)?.spec?.skillName
            if(parsedSkillName) {
                coll.updateOne(
                    { _id: doc._id },
                    { $set: { skillName: parsedSkillName } }
                );
            } else {
                coll.updateOne(
                    { _id: doc._id },
                    { $set: { skillName: "injected-skill-name" } }
                );
            }
        })
    } catch (err) {
        throw new Error(`Error during task resource skill name migration: ${err.message}`);
    }
}

module.exports = {
    up: async () => {
        await updateTaskSkillName();
    },
    down: async () => {
    },
};
