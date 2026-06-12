trigger CaseEquipoResolutores on Case (before update, after update) {
    if (Trigger.isBefore && Trigger.isUpdate) {
        EquipoResolutoresCaseHandler.onBeforeUpdate(Trigger.new, Trigger.oldMap);
    }
    if (Trigger.isAfter && Trigger.isUpdate) {
        EquipoResolutoresCaseHandler.onAfterUpdate(Trigger.new, Trigger.oldMap);
    }
}
