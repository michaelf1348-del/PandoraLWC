public with sharing class EquipoResolutoresCaseHandler {

    /** Valores exactos de la picklist SubEstado__c en Case. */
    private static final String SUBESTADO_TRATAMIENTO = 'Tratamiento Consultor';
    private static final String SUBESTADO_PRECIERRE = 'Pre-Cierre';

    /**
     * Before update: alinea SubEstado al cambiar Status (antes del cierre efectivo).
     * - Hacia Cierre → Pre-Cierre (consultor puede actuar antes de IsClosed).
     * - Otro cambio de Status → Tratamiento Consultor si aún no lo es
     *   (p. ej. desde Acción Cliente).
     */
    public static void onBeforeUpdate(List<Case> newList, Map<Id, Case> oldMap) {
        for (Case c : newList) {
            Case old = oldMap != null ? oldMap.get(c.Id) : null;
            if (old == null || c.Status == old.Status) {
                continue;
            }
            if (EquipoResolutoresController.isClosureStatus(c.Status)
                    || 'Cierre'.equalsIgnoreCase(String.valueOf(c.Status).trim())) {
                c.SubEstado__c = SUBESTADO_PRECIERRE;
            } else if (c.SubEstado__c != SUBESTADO_TRATAMIENTO) {
                c.SubEstado__c = SUBESTADO_TRATAMIENTO;
            }
        }
    }

    /**
     * Al asignar/cambiar el owner a un usuario, cierra la custodia abierta
     * previa y abre una nueva para el nuevo resolutor (Opcion A).
     *
     * Se ejecuta solo en after update (no en insert) para evitar capturar
     * al creador del ticket antes de que la automatizacion (flujo) asigne
     * al resolutor real.
     */
    public static void onAfterUpdate(List<Case> newList, Map<Id, Case> oldMap) {
        Map<Id, RotationReq> rotations = new Map<Id, RotationReq>();
        Set<Id> nowStopped = new Set<Id>();
        Set<Id> nowResumed = new Set<Id>();

        for (Case c : newList) {
            Case old = oldMap != null ? oldMap.get(c.Id) : null;
            if (old == null) {
                continue;
            }

            Boolean ownerChanged = (c.OwnerId != old.OwnerId
                    && c.OwnerId != null
                    && String.valueOf(c.OwnerId).startsWith('005'));
            Boolean statusChanged = (c.Status != old.Status);

            if (ownerChanged || statusChanged) {
                RotationReq req = new RotationReq();
                req.caseId = c.Id;
                req.newStatus = c.Status;
                req.ownerChanged = ownerChanged;
                req.statusChanged = statusChanged;
                req.newOwnerId = ownerChanged ? c.OwnerId : null;
                if (ownerChanged && old.OwnerId != null
                        && String.valueOf(old.OwnerId).startsWith('005')) {
                    req.oldOwnerId = old.OwnerId;
                }
                req.isStopped = (c.IsStopped == true);
                req.isClosing = EquipoResolutoresController.isCaseClosedForSla(c)
                    || EquipoResolutoresController.isClosureStatus(c.Status);
                rotations.put(c.Id, req);
            }

            if (c.IsStopped != old.IsStopped) {
                if (c.IsStopped == true) {
                    nowStopped.add(c.Id);
                } else {
                    nowResumed.add(c.Id);
                }
            }
        }

        Set<Id> nowClosed = new Set<Id>();
        for (Case c : newList) {
            Case old = oldMap.get(c.Id);
            if (old == null) {
                continue;
            }
            if (c.IsClosed == true && old.IsClosed != true) {
                nowClosed.add(c.Id);
            }
        }

        if (!rotations.isEmpty()) {
            rotateTramos(rotations);
        }
        if (!nowClosed.isEmpty()) {
            closeOpenCustodyForCases(nowClosed);
        }
        if (!nowStopped.isEmpty() || !nowResumed.isEmpty()) {
            applyPauseToOpenCustody(nowStopped, nowResumed);
        }

        queueRealtimeEvents(rotations, nowClosed, nowStopped, nowResumed);
        EquipoResolutoresRealtimePublisher.flushPending();
    }

    private static void queueRealtimeEvents(
        Map<Id, RotationReq> rotations,
        Set<Id> nowClosed,
        Set<Id> nowStopped,
        Set<Id> nowResumed
    ) {
        for (RotationReq req : rotations.values()) {
            Set<Id> extra = new Set<Id>();
            if (req.oldOwnerId != null) {
                extra.add(req.oldOwnerId);
            }
            String changeType = req.isClosing
                ? EquipoResolutoresRealtimePublisher.TYPE_CASE_CLOSED
                : (req.ownerChanged
                    ? EquipoResolutoresRealtimePublisher.TYPE_CUSTODY
                    : EquipoResolutoresRealtimePublisher.TYPE_CASE_STATUS);
            EquipoResolutoresRealtimePublisher.requestPublish(
                req.caseId,
                changeType,
                extra
            );
        }

        for (Id caseId : nowClosed) {
            if (!rotations.containsKey(caseId)) {
                EquipoResolutoresRealtimePublisher.requestPublish(
                    caseId,
                    EquipoResolutoresRealtimePublisher.TYPE_CASE_CLOSED,
                    null
                );
            }
        }

        Set<Id> pauseCases = new Set<Id>();
        pauseCases.addAll(nowStopped);
        pauseCases.addAll(nowResumed);
        for (Id caseId : pauseCases) {
            EquipoResolutoresRealtimePublisher.requestPublish(
                caseId,
                EquipoResolutoresRealtimePublisher.TYPE_CASE_PAUSE,
                null
            );
        }
    }

    /** Cierra tramos abiertos sin abrir uno nuevo (ticket cerrado). */
    private static void closeOpenCustodyForCases(Set<Id> caseIds) {
        if (caseIds == null || caseIds.isEmpty()) {
            return;
        }
        List<Equipo_de_Resolutores__c> abiertos = [
            SELECT Id, Inicio__c, Pausa_Inicio__c, Tiempo_Pausado_Min__c
            FROM Equipo_de_Resolutores__c
            WHERE Ticket__c IN :caseIds
              AND Inicio__c != null
              AND Fin__c = null
        ];
        if (abiertos.isEmpty()) {
            return;
        }
        for (Equipo_de_Resolutores__c r : abiertos) {
            EquipoResolutoresController.closeTramoInMemory(r);
        }
        update abiertos;
    }

    /**
     * Solicitud de rotacion de tramo para un Case. Se genera cuando cambia
     * el owner (custodia sigue al owner) y/o el Status (cada estado tiene su
     * propio evento clave, por lo que medimos tiempo por estado y consultor).
     */
    private class RotationReq {
        Id caseId;
        String newStatus;
        Id newOwnerId;
        Id oldOwnerId;
        Boolean ownerChanged = false;
        Boolean statusChanged = false;
        Boolean isStopped = false;
        Boolean isClosing = false;
    }

    /**
     * Pausa/reanuda el tramo de custodia abierto cuando el SLA del Case
     * se detiene o reanuda (Case.IsStopped). Aplica a quien tenga el caso
     * en sus manos (resolutor o apoyo con tramo abierto).
     */
    private static void applyPauseToOpenCustody(Set<Id> stoppedCaseIds, Set<Id> resumedCaseIds) {
        Set<Id> allCaseIds = new Set<Id>();
        allCaseIds.addAll(stoppedCaseIds);
        allCaseIds.addAll(resumedCaseIds);

        List<Equipo_de_Resolutores__c> abiertos = [
            SELECT Id, Ticket__c, Pausa_Inicio__c, Tiempo_Pausado_Min__c
            FROM Equipo_de_Resolutores__c
            WHERE Ticket__c IN :allCaseIds
              AND Inicio__c != null
              AND Fin__c = null
        ];

        Datetime nowDt = System.now();
        List<Equipo_de_Resolutores__c> toUpdate = new List<Equipo_de_Resolutores__c>();

        for (Equipo_de_Resolutores__c er : abiertos) {
            if (stoppedCaseIds.contains(er.Ticket__c)) {
                if (er.Pausa_Inicio__c == null) {
                    er.Pausa_Inicio__c = nowDt;
                    toUpdate.add(er);
                }
            } else if (resumedCaseIds.contains(er.Ticket__c)) {
                if (er.Pausa_Inicio__c != null) {
                    Long ms = nowDt.getTime() - er.Pausa_Inicio__c.getTime();
                    Decimal mins = Decimal.valueOf(ms) / 60000;
                    Decimal prev = er.Tiempo_Pausado_Min__c != null
                        ? er.Tiempo_Pausado_Min__c : 0;
                    er.Tiempo_Pausado_Min__c = prev + mins;
                    er.Pausa_Inicio__c = null;
                    toUpdate.add(er);
                }
            }
        }

        if (!toUpdate.isEmpty()) {
            update toUpdate;
        }
    }

    /**
     * Rota los tramos de custodia segun los cambios detectados en el Case.
     *
     * Modelo (a) "un tramo = un consultor en un estado":
     *  - Si cambia el Status: se cierra el tramo abierto (con su Estado previo
     *    ya guardado) y se abre uno nuevo para el MISMO responsable con el
     *    estado nuevo. Asi cada estado, que tiene su propio evento clave,
     *    queda medido por separado y por consultor.
     *  - Si cambia el owner: la custodia sigue al owner. Se cierra el tramo
     *    abierto (de otro resolutor) y se abre uno nuevo para el nuevo owner.
     *  - Si entra detenido (IsStopped), el tramo nuevo arranca en pausa para
     *    no contar tiempo efectivo mientras el SLA esta detenido.
     *
     * Conserva el historial de tramos (no reescribe registros previos).
     */
    private static void rotateTramos(Map<Id, RotationReq> reqs) {
        Set<Id> caseIds = reqs.keySet();

        Map<Id, List<Equipo_de_Resolutores__c>> byCase =
            new Map<Id, List<Equipo_de_Resolutores__c>>();
        for (Equipo_de_Resolutores__c er : [
            SELECT Id, Ticket__c, Resolutor__c, Inicio__c, Fin__c, Estado__c,
                   Pausa_Inicio__c, Tiempo_Pausado_Min__c
            FROM Equipo_de_Resolutores__c
            WHERE Ticket__c IN :caseIds
        ]) {
            if (!byCase.containsKey(er.Ticket__c)) {
                byCase.put(er.Ticket__c, new List<Equipo_de_Resolutores__c>());
            }
            byCase.get(er.Ticket__c).add(er);
        }

        Map<Id, Id> caseToRecordType = getRecordTypeMapForCases(caseIds);
        Datetime nowDt = System.now();

        List<Equipo_de_Resolutores__c> toUpdate = new List<Equipo_de_Resolutores__c>();
        List<Equipo_de_Resolutores__c> toInsert = new List<Equipo_de_Resolutores__c>();

        for (Id caseId : reqs.keySet()) {
            RotationReq req = reqs.get(caseId);
            List<Equipo_de_Resolutores__c> records = byCase.get(caseId);
            if (records == null) {
                records = new List<Equipo_de_Resolutores__c>();
            }

            Equipo_de_Resolutores__c openTramo = null;
            for (Equipo_de_Resolutores__c er : records) {
                if (er.Inicio__c != null && er.Fin__c == null) {
                    openTramo = er;
                    break;
                }
            }

            // Responsable del nuevo tramo: si cambio el owner sigue al owner;
            // si solo cambio el estado, conserva al custodio actual.
            Id newResp = null;
            if (req.ownerChanged) {
                newResp = req.newOwnerId;
            } else if (openTramo != null) {
                newResp = openTramo.Resolutor__c;
            }
            // Cambio de estado sin custodia activa: no inventamos custodia.
            if (newResp == null) {
                continue;
            }

            Boolean respChanged = (openTramo == null)
                || (openTramo.Resolutor__c != newResp);
            Boolean shouldRotate = req.statusChanged || respChanged;
            if (!shouldRotate) {
                continue;
            }

            if (openTramo != null) {
                EquipoResolutoresController.closeTramoInMemory(openTramo);
                toUpdate.add(openTramo);
            }

            // Cierre / cancelación: solo cerrar tramo, no abrir custodia nueva.
            if (req.isClosing) {
                continue;
            }

            Equipo_de_Resolutores__c reg = new Equipo_de_Resolutores__c(
                Ticket__c = caseId,
                Resolutor__c = newResp,
                Inicio__c = nowDt
            );
            EquipoResolutoresController.applyEquipoRecordContext(
                reg,
                caseId,
                EquipoResolutoresController.resolveEspecialidadForResolutor(caseId, newResp)
            );
            // Si el caso esta detenido al abrir, el tramo nace en pausa.
            if (req.isStopped) {
                reg.Pausa_Inicio__c = nowDt;
            }
            Id rtId = caseToRecordType.get(caseId);
            if (rtId != null) {
                reg.RecordTypeId = rtId;
            }
            toInsert.add(reg);
        }

        if (!toUpdate.isEmpty()) {
            update toUpdate;
        }
        if (!toInsert.isEmpty()) {
            insert toInsert;
        }
    }

    private static Map<Id, Id> getRecordTypeMapForCases(Set<Id> caseIds) {
        Map<Id, Id> result = new Map<Id, Id>();
        Map<String, Id> rtByDevName = new Map<String, Id>();

        List<Case> casos = [
            SELECT Id, RecordType.DeveloperName
            FROM Case
            WHERE Id IN :caseIds
        ];

        Set<String> devNames = new Set<String>();
        for (Case c : casos) {
            if (c.RecordType != null && c.RecordType.DeveloperName != null) {
                devNames.add(c.RecordType.DeveloperName);
            }
        }
        if (!devNames.isEmpty()) {
            for (RecordType rt : [
                SELECT Id, DeveloperName
                FROM RecordType
                WHERE SobjectType = 'Equipo_de_Resolutores__c'
                  AND DeveloperName IN :devNames
            ]) {
                rtByDevName.put(rt.DeveloperName, rt.Id);
            }
        }

        for (Case c : casos) {
            if (c.RecordType != null && c.RecordType.DeveloperName != null) {
                Id rtId = rtByDevName.get(c.RecordType.DeveloperName);
                if (rtId != null) {
                    result.put(c.Id, rtId);
                }
            }
        }
        return result;
    }
}
