/**
 * PandoraTimeController - imputaciones desde Centro de Imputaciones (dailyTimeCalendar).
 *
 * getActiveTickets(selectedDate): casos activos visibles para el usuario y horas ya cargadas ese dia.
 *
 * saveTimeEntries(payloadJson): lista de { id, horas, noFacturable, fecha }.
 * Cada elemento del JSON = un registro Imputacion__c. Puedes enviar varias filas con el mismo Case Id
 * y distinta fecha (multidia) desde cualquier cliente que arme ese payload.
 */
public with sharing class PandoraTimeController {
    public class TicketRowDTO {
        @AuraEnabled public Id id;
        @AuraEnabled public String caseNumber;
        @AuraEnabled public String subject;
        @AuraEnabled public String status;
        @AuraEnabled public String recordLink;
        @AuraEnabled public Decimal horasImputadas;
    }

    public class TimeEntryDTO {
        @AuraEnabled public Id id;
        @AuraEnabled public Decimal horas;
        @AuraEnabled public Boolean noFacturable;
        @AuraEnabled public Date fecha;
    }

    @AuraEnabled(cacheable = true)
    public static List<TicketRowDTO> getActiveTickets(String selectedDate) {
        if (String.isBlank(selectedDate)) {
            throw new AuraHandledException('La fecha es obligatoria.');
        }
        Date workDate = Date.valueOf(selectedDate);
        Id uid = UserInfo.getUserId();

        Set<Id> collaboratorIds = getCaseIdsWhereUserCollaborates(uid);
        List<Case> cases;
        if (collaboratorIds.isEmpty()) {
            cases = [
                SELECT Id, CaseNumber, Subject, Status
                FROM Case
                WHERE OwnerId = :uid AND IsClosed = FALSE
                ORDER BY LastModifiedDate DESC
                LIMIT 200
            ];
        } else {
            cases = [
                SELECT Id, CaseNumber, Subject, Status
                FROM Case
                WHERE IsClosed = FALSE AND (OwnerId = :uid OR Id IN :collaboratorIds)
                ORDER BY LastModifiedDate DESC
                LIMIT 200
            ];
        }

        Set<Id> caseIds = new Set<Id>();
        for (Case c : cases) {
            caseIds.add(c.Id);
        }

        Map<Id, Decimal> hoursByCase = getHoursForCasesOnDate(caseIds, workDate);
        String base = System.Url.getOrgDomainUrl().toExternalForm();

        List<TicketRowDTO> out = new List<TicketRowDTO>();
        for (Case c : cases) {
            TicketRowDTO row = new TicketRowDTO();
            row.id = c.Id;
            row.caseNumber = c.CaseNumber;
            row.subject = c.Subject;
            row.status = c.Status;
            row.recordLink = base + '/lightning/r/Case/' + c.Id + '/view';
            row.horasImputadas = hoursByCase.containsKey(c.Id) ? hoursByCase.get(c.Id) : 0;
            out.add(row);
        }
        return out;
    }

    /**
     * Procesa todas las filas del payload; cada fila usa su propia fecha (incluye escenarios multidia).
     */
    @AuraEnabled
    public static Integer saveTimeEntries(String payloadJson) {
        if (String.isBlank(payloadJson)) {
            return 0;
        }
        List<TimeEntryDTO> rows = (List<TimeEntryDTO>) JSON.deserialize(payloadJson, List<TimeEntryDTO>.class);
        if (rows == null || rows.isEmpty()) {
            return 0;
        }

        Id uid = UserInfo.getUserId();
        Set<Id> caseIds = new Set<Id>();
        for (TimeEntryDTO r : rows) {
            if (r != null && r.id != null) {
                caseIds.add(r.id);
            }
        }

        Map<Id, Case> caseMap = caseIds.isEmpty()
            ? new Map<Id, Case>()
            : new Map<Id, Case>([SELECT Id, OwnerId FROM Case WHERE Id IN :caseIds]);

        Set<Id> teamOk = buildTeamMembershipForCases(caseIds, uid);

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            throw new AuraHandledException('No existe el objeto Imputacion__c en esta org.');
        }
        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();

        List<SObject> toInsert = new List<SObject>();
        for (TimeEntryDTO r : rows) {
            if (r == null || r.id == null) {
                continue;
            }
            Case c = caseMap.get(r.id);
            if (c == null) {
                throw new AuraHandledException('Ticket no encontrado o sin acceso: ' + r.id);
            }
            Boolean owner = c.OwnerId == uid;
            if (!owner && !teamOk.contains(r.id)) {
                throw new AuraHandledException(
                    'No puedes imputar en este ticket (no eres resolutor ni est�s en el equipo del caso).'
                );
            }

            Decimal h = r.horas == null ? 0 : r.horas;
            Boolean nf = r.noFacturable == true;
            if (h <= 0 && !nf) {
                continue;
            }
            if (r.fecha == null) {
                throw new AuraHandledException('Fecha obligatoria en cada fila del payload.');
            }
            if (r.fecha > Date.today()) {
                throw new AuraHandledException('No se permiten fechas futuras.');
            }
            if (h > 24) {
                throw new AuraHandledException('Las horas no pueden superar 24 por registro.');
            }

            SObject rec = impType.newSObject();
            putTicketRef(rec, fMap, r.id);
            putFirstExisting(rec, fMap, new List<String>{ 'Fecha__c', 'Date__c' }, r.fecha);
            if (h > 0) {
                putFirstExisting(rec, fMap, new List<String>{ 'Horas__c', 'Hours__c' }, h);
            }
            putNoFacturable(rec, fMap, nf);
            putFirstExisting(
                rec,
                fMap,
                new List<String>{ 'Origen__c', 'Source__c' },
                'PandoraDailyCalendar'
            );
            putFirstExisting(rec, fMap, new List<String>{ 'En_nombre_de__c', 'Consultor__c', 'Usuario__c' }, uid);

            toInsert.add(rec);
        }

        if (toInsert.isEmpty()) {
            return 0;
        }

        Integer ok = 0;
        Database.SaveResult[] sr = Database.insert(toInsert, false);
        for (Database.SaveResult one : sr) {
            if (one.isSuccess()) {
                ok++;
            }
        }
        if (ok == 0) {
            List<String> msgs = new List<String>();
            for (Database.SaveResult one : sr) {
                if (!one.isSuccess()) {
                    for (Database.Error err : one.getErrors()) {
                        msgs.add(err.getMessage());
                    }
                }
            }
            throw new AuraHandledException(
                'No se pudo guardar ninguna imputaci�n. ' + String.join(msgs, ' | ')
            );
        }
        return ok;
    }

    private static void putTicketRef(SObject rec, Map<String, Schema.SObjectField> fMap, Id caseId) {
        putFirstExisting(
            rec,
            fMap,
            new List<String>{ 'Ticket__c', 'Case__c', 'CaseId__c', 'CaseId' },
            caseId
        );
    }

    private static Map<Id, Decimal> getHoursForCasesOnDate(Set<Id> caseIds, Date workDate) {
        Map<Id, Decimal> out = new Map<Id, Decimal>();
        if (caseIds == null || caseIds.isEmpty()) {
            return out;
        }

        Schema.SObjectType impType = Schema.getGlobalDescribe().get('Imputacion__c');
        if (impType == null) {
            return out;
        }
        Map<String, Schema.SObjectField> fMap = impType.getDescribe().fields.getMap();
        String ticketApi = resolveImputationTicketFieldForAggregate(fMap);
        String hoursApi = resolveImputationHoursFieldForAggregate(fMap);
        String fechaApi = resolveImputationDateFieldForAggregate(fMap);
        if (String.isBlank(ticketApi) || String.isBlank(hoursApi) || String.isBlank(fechaApi)) {
            return out;
        }

        String soql =
            'SELECT ' +
            ticketApi +
            ' tid, SUM(' +
            hoursApi +
            ') total FROM Imputacion__c WHERE ' +
            ticketApi +
            ' IN :caseIds AND ' +
            fechaApi +
            ' = :workDate GROUP BY ' +
            ticketApi;

        try {
            for (AggregateResult ar : Database.query(soql)) {
                Id tid = (Id) ar.get('tid');
                if (tid != null) {
                    out.put(tid, (Decimal) ar.get('total'));
                }
            }
        } catch (Exception ex) {
            System.debug(LoggingLevel.WARN, 'PandoraTimeController agg: ' + ex.getMessage());
        }
        return out;
    }

    private static String resolveImputationTicketFieldForAggregate(Map<String, Schema.SObjectField> fMap) {
        List<String> candidates = new List<String>{ 'Ticket__c', 'Case__c', 'CaseId__c', 'CaseId' };
        for (String api : candidates) {
            if (!fMap.containsKey(api)) {
                continue;
            }
            Schema.DescribeFieldResult d = fMap.get(api).getDescribe();
            if (!d.isAccessible()) {
                continue;
            }
            Schema.DisplayType t = d.getType();
            if ((t == Schema.DisplayType.REFERENCE || t == Schema.DisplayType.ID) && d.isGroupable()) {
                return api;
            }
        }
        return null;
    }

    private static String resolveImputationHoursFieldForAggregate(Map<String, Schema.SObjectField> fMap) {
        List<String> candidates = new List<String>{ 'Horas__c', 'Hours__c' };
        for (String api : candidates) {
            if (!fMap.containsKey(api)) {
                continue;
            }
            Schema.DescribeFieldResult d = fMap.get(api).getDescribe();
            if (!d.isAccessible()) {
                continue;
            }
            Schema.DisplayType t = d.getType();
            if (
                t == Schema.DisplayType.DOUBLE ||
                t == Schema.DisplayType.CURRENCY ||
                t == Schema.DisplayType.PERCENT ||
                t == Schema.DisplayType.INTEGER
            ) {
                return api;
            }
        }
        return null;
    }

    private static String resolveImputationDateFieldForAggregate(Map<String, Schema.SObjectField> fMap) {
        List<String> candidates = new List<String>{ 'Fecha__c', 'Date__c', 'FechaImputacion__c' };
        for (String api : candidates) {
            if (!fMap.containsKey(api)) {
                continue;
            }
            Schema.DescribeFieldResult d = fMap.get(api).getDescribe();
            if (d.isAccessible() && d.getType() == Schema.DisplayType.DATE && d.isGroupable()) {
                return api;
            }
        }
        return null;
    }

    private static void putFirstExisting(
        SObject rec,
        Map<String, Schema.SObjectField> fMap,
        List<String> candidates,
        Object value
    ) {
        if (value == null) {
            return;
        }
        for (String api : candidates) {
            if (fMap.containsKey(api)) {
                rec.put(api, value);
                return;
            }
        }
    }

    private static void putNoFacturable(SObject rec, Map<String, Schema.SObjectField> fMap, Boolean value) {
        if (value == null || value == false) {
            return;
        }
        List<String> apis = new List<String>{ 'No_Facturable__c', 'NoFacturable__c' };
        for (String api : apis) {
            if (!fMap.containsKey(api)) {
                continue;
            }
            Schema.DisplayType t = fMap.get(api).getDescribe().getType();
            if (t == Schema.DisplayType.Boolean) {
                rec.put(api, value);
                return;
            }
            if (t == Schema.DisplayType.Picklist) {
                rec.put(api, value ? 'Si' : 'No');
                return;
            }
        }
    }

    private static Id getUserContactId(Id userId) {
        if (userId == null) {
            return null;
        }
        if (!User.SObjectType.getDescribe().fields.getMap().containsKey('ContactId')) {
            return null;
        }
        User u = [SELECT ContactId FROM User WHERE Id = :userId LIMIT 1];
        return u.ContactId;
    }

    private static Set<Id> getCaseIdsWhereUserCollaborates(Id userId) {
        Set<Id> ids = new Set<Id>();
        for (CaseTeamMember m : [
            SELECT ParentId
            FROM CaseTeamMember
            WHERE MemberId = :userId AND ParentId != NULL
        ]) {
            ids.add(m.ParentId);
        }
        Id contactId = getUserContactId(userId);
        if (contactId != null) {
            for (CaseTeamMember m : [
                SELECT ParentId
                FROM CaseTeamMember
                WHERE MemberId = :contactId AND ParentId != NULL
            ]) {
                ids.add(m.ParentId);
            }
        }
        return ids;
    }

    private static Set<Id> buildTeamMembershipForCases(Set<Id> caseIds, Id uid) {
        Set<Id> ok = new Set<Id>();
        if (caseIds == null || caseIds.isEmpty()) {
            return ok;
        }
        Id contactId = getUserContactId(uid);
        if (contactId != null) {
            for (CaseTeamMember m : [
                SELECT ParentId
                FROM CaseTeamMember
                WHERE ParentId IN :caseIds AND (MemberId = :uid OR MemberId = :contactId)
            ]) {
                ok.add(m.ParentId);
            }
        } else {
            for (CaseTeamMember m : [
                SELECT ParentId
                FROM CaseTeamMember
                WHERE ParentId IN :caseIds AND MemberId = :uid
            ]) {
                ok.add(m.ParentId);
            }
        }
        return ok;
    }
}
