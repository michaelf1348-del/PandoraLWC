public with sharing class EquipoResolutoresMilestoneHandler {

    public static void onAfterUpdate(List<CaseMilestone> newList, Map<Id, CaseMilestone> oldMap) {
        Set<Id> violatedCaseIds = new Set<Id>();
        for (CaseMilestone ms : newList) {
            if (ms.CaseId == null || ms.IsViolated != true) {
                continue;
            }
            CaseMilestone oldMs = oldMap != null ? oldMap.get(ms.Id) : null;
            if (oldMs == null || oldMs.IsViolated != true) {
                violatedCaseIds.add(ms.CaseId);
            }
        }
        EquipoResolutoresController.imputeViolationToOpenCustody(violatedCaseIds);
        // imputeViolationToOpenCustody ya publica eventos SLA.
    }

    public static void onAfterInsert(List<CaseMilestone> newList) {
        Set<Id> violatedCaseIds = new Set<Id>();
        for (CaseMilestone ms : newList) {
            if (ms.CaseId != null && ms.IsViolated == true) {
                violatedCaseIds.add(ms.CaseId);
            }
        }
        EquipoResolutoresController.imputeViolationToOpenCustody(violatedCaseIds);
    }
}
