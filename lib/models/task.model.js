import mongoose from 'mongoose';

const TaskSchema = new mongoose.Schema({
    name: { type: String, required: true },
    projectId: { type: String, required: true },
    state: { type: String, required: true },
    jobType: { type: String, required: false },
    skillName: { type: String, required: false },
    actionName: { type: String, required: false },
    channelId: { type: String, required: false },
    startTime: { type: Date, required: false },
    activationId: { type: String, required: false },
    endTime: { type: Date, required: false },
    fabricResource: { type: String, required: false },
    resourceType: { type: String, required: false },
    resource: { type: String, required: false },
});
// Indexes
TaskSchema.index({ name: 1 }, { unique: false });
TaskSchema.index({ activationId: 1 }, { unique: false });
TaskSchema.index({ skillName: 1 }, { unique: false });
TaskSchema.index({ projectId: 1, resourceType: 1, fabricResource: 1 }, { unique: false });
const TaskListProjection = {
    _id: 0,
    name: 1,
    activationId: 1,
    channelId: 1,
    skillName: 1,
    actionName: 1,
    startTime: 1,
    fabricResource: 1,
    jobType: 1,
    endTime: 1,
    state: 1,
};
const Tasks = mongoose.model('Tasks', TaskSchema, 'Tasks');
export { Tasks };
export { TaskListProjection as TaskProjection };
export default {
    Tasks,
    TaskProjection: TaskListProjection,
};
