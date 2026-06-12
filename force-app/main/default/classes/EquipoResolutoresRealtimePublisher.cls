/**
 * Publica Platform Events para refresco casi en tiempo real de LWCs
 * (equipo, custodia, SLA) entre usuarios.
 */
public with sharing class EquipoResolutoresRealtimePublisher {

    public static final String TYPE_TEAM = 'TEAM';
    public static final String TYPE_CUSTODY = 'CUSTODY';
    public static final String TYPE_CASE_STATUS = 'CASE_STATUS';
    public static final String TYPE_CASE_PAUSE = 'CASE_PAUSE';
    public static final String TYPE_CASE_CLOSED = 'CASE_CLOSED';
    public static final String TYPE_SLA = 'SLA';

    @TestVisible
    private static Map<Id, PendingEvent> pendingByCase = new Map<Id, PendingEvent>();

    private class PendingEvent {
        Id caseId;
        String changeType;
        Set<Id> extraNotifyIds = new Set<Id>();
    }

    /** Encola un evento por Case (se agrupa en flushPending). */
    public static void requestPublish(Id caseId, String changeType, Set<Id> extraNotifyIds) {
        if (caseId == null || String.isBlank(changeType)) {
            return;
        }
        PendingEvent pending = pendingByCase.get(caseId);
        if (pending == null) {
            pending = new PendingEvent();
            pending.caseId = caseId;
            pending.changeType = changeType;
            pendingByCase.put(caseId, pending);
        } else {
            pending.changeType = mergeChangeType(pending.changeType, changeType);
        }
        if (extraNotifyIds != null) {
            pending.extraNotifyIds.addAll(extraNotifyIds);
        }
    }

    /** Publica de inmediato (acciones Aura desde LWC). */
    public static void publishNow(Id caseId, String changeType, Set<Id> extraNotifyIds) {
        requestPublish(caseId, changeType, extraNotifyIds);
        flushPending();
    }

    /** Vacía la cola y publica todos los eventos pendientes. */
    public static void flushPending() {
        if (pendingByCase.isEmpty()) {
            return;
        }
        List<Pandora_Equipo_Sla_Change__e> events = new List<Pandora_Equipo_Sla_Change__e>();
        for (PendingEvent pending : pendingByCase.values()) {
            events.add(buildEvent(pending));
        }
        pendingByCase.clear();
        if (!events.isEmpty()) {
            EventBus.publish(events);
        }
    }

    @TestVisible
    private static Pandora_Equipo_Sla_Change__e buildEvent(PendingEvent pending) {
        Set<Id> notify = resolveStakeholders(pending.caseId);
        notify.addAll(pending.extraNotifyIds);

        Pandora_Equipo_Sla_Change__e evt = new Pandora_Equipo_Sla_Change__e();
        evt.Case_Id__c = String.valueOf(pending.caseId);
        evt.Change_Type__c = pending.changeType;
        Id actorId = UserInfo.getUserId();
        if (actorId != null) {
            evt.Actor_User_Id__c = String.valueOf(actorId);
        }
        evt.Notify_User_Ids__c = joinUserIds(notify);
        evt.Correlation_Id__c = generateCorrelationId();
        return evt;
    }

    /** Owner del Case + apoyos (sin tramo de custodia abierto). */
    public static Set<Id> resolveStakeholders(Id caseId) {
        Set<Id> userIds = new Set<Id>();
        if (caseId == null) {
            return userIds;
        }

        List<Case> casos = [
            SELECT OwnerId
            FROM Case
            WHERE Id = :caseId
            LIMIT 1
        ];
        if (!casos.isEmpty() && isUserId(casos[0].OwnerId)) {
            userIds.add(casos[0].OwnerId);
        }

        for (Equipo_de_Resolutores__c er : [
            SELECT Resolutor__c
            FROM Equipo_de_Resolutores__c
            WHERE Ticket__c = :caseId
              AND Resolutor__c != null
              AND Inicio__c = null
        ]) {
            if (isUserId(er.Resolutor__c)) {
                userIds.add(er.Resolutor__c);
            }
        }

        for (Equipo_de_Resolutores__c er : [
            SELECT Resolutor__c
            FROM Equipo_de_Resolutores__c
            WHERE Ticket__c = :caseId
              AND Resolutor__c != null
              AND Inicio__c != null
              AND Fin__c = null
        ]) {
            if (isUserId(er.Resolutor__c)) {
                userIds.add(er.Resolutor__c);
            }
        }

        return userIds;
    }

    private static Boolean isUserId(Id recordId) {
        return recordId != null && String.valueOf(recordId).startsWith('005');
    }

    private static String joinUserIds(Set<Id> userIds) {
        List<String> parts = new List<String>();
        for (Id userId : userIds) {
            if (userId != null) {
                parts.add(String.valueOf(userId));
            }
        }
        return String.join(parts, ';');
    }

    private static String generateCorrelationId() {
        String blobPart = EncodingUtil.convertToHex(Crypto.generateAesKey(128)).left(32);
        return blobPart + String.valueOf(DateTime.now().getTime());
    }

    /** Prioridad: cierre > custodia/equipo > pausa > SLA > estado. */
    private static String mergeChangeType(String existingType, String newType) {
        Integer existingRank = typeRank(existingType);
        Integer newRank = typeRank(newType);
        return newRank < existingRank ? newType : existingType;
    }

    private static Integer typeRank(String changeType) {
        if (changeType == TYPE_CASE_CLOSED) {
            return 0;
        }
        if (changeType == TYPE_CUSTODY || changeType == TYPE_TEAM) {
            return 1;
        }
        if (changeType == TYPE_CASE_PAUSE) {
            return 2;
        }
        if (changeType == TYPE_SLA) {
            return 3;
        }
        return 4;
    }

    @TestVisible
    private static void clearPendingForTest() {
        pendingByCase.clear();
    }

    @TestVisible
    private static Integer pendingCountForTest() {
        return pendingByCase.size();
    }

    @TestVisible
    private static String mergeChangeTypeForTest(String existingType, String newType) {
        return mergeChangeType(existingType, newType);
    }
}
