trigger CaseMilestoneEquipoResolutores on CaseMilestone (after insert, after update) {
    if (Trigger.isAfter && Trigger.isInsert) {
        EquipoResolutoresMilestoneHandler.onAfterInsert(Trigger.new);
    }
    if (Trigger.isAfter && Trigger.isUpdate) {
        EquipoResolutoresMilestoneHandler.onAfterUpdate(Trigger.new, Trigger.oldMap);
    }
}
