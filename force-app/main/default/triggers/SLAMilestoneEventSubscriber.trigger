/**
 * Platform Event subscriber que recibe SLA_Milestone_Event__e
 * y actualiza el Status del Case en una transaccion separada.
 *
 * Al cambiar el Status aqui, el CaseMilestoneAdvancerTrigger se re-dispara
 * pero no encuentra milestone pendiente (ya fue completado) -> no procesa.
 */
trigger SLAMilestoneEventSubscriber on SLA_Milestone_Event__e (after insert) {
    List<Case> toUpdate = new List<Case>();

    for (SLA_Milestone_Event__e evt : Trigger.new) {
        if (evt.CaseId__c != null && evt.New_Status__c != null) {
            toUpdate.add(new Case(
                Id = evt.CaseId__c,
                Status = evt.New_Status__c
            ));
        }
    }

    if (!toUpdate.isEmpty()) {
        Database.update(toUpdate, false);
    }
}
