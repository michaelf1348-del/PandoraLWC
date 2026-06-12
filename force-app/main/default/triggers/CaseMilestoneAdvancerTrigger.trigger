/**
 * Before update trigger que intercepta cambios de Status para:
 * 1. Completar el milestone activo
 * 2. Revertir el Status
 * 3. Publicar Platform Event para cambiar Status en transaccion separada
 */
trigger CaseMilestoneAdvancerTrigger on Case (before update, after update) {
    if (Trigger.isBefore && Trigger.isUpdate) {
        CaseMilestoneAdvancer.onBeforeUpdate(Trigger.new, Trigger.oldMap);
    }
    if (Trigger.isAfter && Trigger.isUpdate) {
        CaseMilestoneAdvancer.onAfterUpdate(Trigger.new, Trigger.oldMap);
    }
}
