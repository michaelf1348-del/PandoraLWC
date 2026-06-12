/**

 * Completa el CaseMilestone activo al cambiar Status.

 *

 * - Estados intermedios: completa el hito en after update (evita

 *   SELF_REFERENCE_FROM_TRIGGER), revierte Status en before y publica

 *   Platform Event para aplicar el nuevo Status en otra transaccion.

 * - Cierre / cancelacion: no interviene.

 */

public without sharing class CaseMilestoneAdvancer {



    private static final Map<String, String> MILESTONE_BY_STATUS = new Map<String, String>{

        'Recepci\u00F3n y Asignaci\u00F3n' => 'Recepci\u00F3n y Asignaci\u00F3n',

        'Recepcion y Asignacion'           => 'Recepci\u00F3n y Asignaci\u00F3n',

        'An\u00E1lisis o Estimaci\u00F3n'  => 'An\u00E1lisis o Estimaci\u00F3n',

        'Analisis o Estimacion'            => 'An\u00E1lisis o Estimaci\u00F3n',

        'Aprobaci\u00F3n'                  => 'Aprobaci\u00F3n',

        'Aprobacion'                       => 'Aprobaci\u00F3n',

        'Configuraci\u00F3n y/o Desarrollo'=> 'Configuraci\u00F3n y/o Desarrollo',

        'Configuracion y/o Desarrollo'     => 'Configuraci\u00F3n y/o Desarrollo',

        'Configuraci\u00F3n y Desarrollo'  => 'Configuraci\u00F3n y/o Desarrollo',

        'Configuracion y Desarrollo'       => 'Configuraci\u00F3n y/o Desarrollo',

        'Prueba o Aceptaci\u00F3n'         => 'Prueba o Aceptaci\u00F3n',

        'Prueba o Aceptacion'              => 'Prueba o Aceptaci\u00F3n',

        'Soluci\u00F3n Propuesta'          => 'Soluci\u00F3n Propuesta',

        'Solucion Propuesta'               => 'Soluci\u00F3n Propuesta',

        'Entrega y Transporte'             => 'Entrega y Transporte'

    };



    /** Estados destino sin hito SLA: no revertir ni usar Platform Event. */

    private static final Set<String> DIRECT_ADVANCE_STATUS = new Set<String>{

        'Cierre',

        'Cerrado',

        'Closed',

        'Cancelado',

        'Cancelled'

    };



    @TestVisible

    private static List<CaseMilestone> pendingMilestoneComplete = new List<CaseMilestone>();

    @TestVisible

    private static List<SLA_Milestone_Event__e> pendingStatusEvents = new List<SLA_Milestone_Event__e>();



    public static void onBeforeUpdate(List<Case> newList, Map<Id, Case> oldMap) {

        pendingMilestoneComplete.clear();

        pendingStatusEvents.clear();



        Map<Id, String> caseToNewStatus = new Map<Id, String>();

        Map<Id, String> caseToMilestoneName = new Map<Id, String>();



        for (Case c : newList) {

            Case old = oldMap.get(c.Id);

            if (old == null || c.Status == old.Status || old.Status == null) {

                continue;

            }



            Boolean cerrandose = (c.IsClosed == true && old.IsClosed != true)

                || isDirectAdvanceStatus(c.Status);

            if (cerrandose) {

                continue;

            }



            String milestoneName = MILESTONE_BY_STATUS.get(old.Status);

            if (milestoneName != null) {

                caseToNewStatus.put(c.Id, c.Status);

                caseToMilestoneName.put(c.Id, milestoneName);

            }

        }



        if (caseToMilestoneName.isEmpty()) {

            return;

        }



        Set<String> milestoneNames = new Set<String>(caseToMilestoneName.values());

        List<CaseMilestone> activeMilestones = [

            SELECT Id, CaseId, MilestoneType.Name

            FROM CaseMilestone

            WHERE CaseId IN :caseToMilestoneName.keySet()

              AND MilestoneType.Name IN :milestoneNames

              AND IsCompleted = false

        ];



        Set<Id> casesProcessed = new Set<Id>();



        for (CaseMilestone cm : activeMilestones) {

            String expected = caseToMilestoneName.get(cm.CaseId);

            if (expected != null && cm.MilestoneType.Name == expected) {

                cm.CompletionDate = System.now();

                pendingMilestoneComplete.add(cm);

                casesProcessed.add(cm.CaseId);

            }

        }



        if (casesProcessed.isEmpty()) {

            return;

        }



        for (Case c : newList) {

            if (!casesProcessed.contains(c.Id)) {

                continue;

            }

            pendingStatusEvents.add(new SLA_Milestone_Event__e(

                CaseId__c = c.Id,

                New_Status__c = caseToNewStatus.get(c.Id)

            ));

            c.Status = oldMap.get(c.Id).Status;

        }

    }



    /**

     * Completa milestones y publica eventos fuera del before update del Case

     * para evitar SELF_REFERENCE_FROM_TRIGGER al actualizar CaseMilestone.

     */

    public static void onAfterUpdate(List<Case> newList, Map<Id, Case> oldMap) {

        if (pendingMilestoneComplete.isEmpty() && pendingStatusEvents.isEmpty()) {

            return;

        }



        List<CaseMilestone> milestones = new List<CaseMilestone>(pendingMilestoneComplete);

        List<SLA_Milestone_Event__e> events = new List<SLA_Milestone_Event__e>(pendingStatusEvents);

        pendingMilestoneComplete.clear();

        pendingStatusEvents.clear();



        if (!milestones.isEmpty()) {

            update milestones;

        }

        if (!events.isEmpty()) {

            EventBus.publish(events);

        }

    }



    @TestVisible

    private static Boolean isDirectAdvanceStatus(String status) {

        if (String.isBlank(status)) {

            return false;

        }

        if (DIRECT_ADVANCE_STATUS.contains(status)) {

            return true;

        }

        String lower = status.toLowerCase();

        return lower.contains('cerrad') || lower.contains('closed')

            || lower.contains('cancel');

    }



    @TestVisible

    private static void clearPendingForTest() {

        pendingMilestoneComplete.clear();

        pendingStatusEvents.clear();

    }

}

